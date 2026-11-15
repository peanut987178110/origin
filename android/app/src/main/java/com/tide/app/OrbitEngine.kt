package com.tide.app

import android.app.ActivityManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Orbit · on-device model bridge (exposed to the page as window.AndroidOrbitAI)
 * =============================================================================
 * Product requirement: "download and chat right away — no login, no API key".
 * So the default (and only) brain is a model that ships inside the APK.
 *
 * Lifecycle
 *   prepare()  called by the page on first launch, in the background:
 *              copy the bundled GGUF out of the APK once → load it → state "ready".
 *              The page never waits on this for navigation; only the very first reply
 *              may show "getting ready…" if the user is faster than the copy.
 *   warm(json) prefill the persona's system prompt into the KV cache right after the
 *              user picks a companion, so the first real reply only decodes new tokens.
 *   generate() streams text chunks to window.__orbitChunk(id, text) and finishes with
 *              window.__orbitDone(id, ok, statsJson | error).
 *   stop()     cancels the current generation.
 */
class OrbitEngine(private val ctx: Context, private val web: WebView) {

    companion object {
        init { System.loadLibrary("orbit_local") }
        const val ASSET = "models/orbit-qwen2.5-1.5b-instruct-q4_k_m.gguf"
        const val MODEL_NAME = "Qwen2.5-1.5B-Instruct (Q4_K_M)"
        const val N_CTX = 4096
    }

    private external fun nativeLoad(path: String, nCtx: Int, nThreads: Int, nThreadsBatch: Int)
    private external fun nativeGenerate(
        roles: Array<ByteArray>, contents: Array<ByteArray>, maxTokens: Int, temp: Float, topP: Float,
        seed: Int, prefillOnly: Boolean, cb: ChunkSink
    ): ByteArray
    private external fun nativeStop()
    private external fun nativeFree()

    /** Called from C++ on the generation thread. */
    interface ChunkSink { fun onChunk(utf8: ByteArray) }

    private val loader = Executors.newSingleThreadExecutor()
    private val gen = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private val started = AtomicBoolean(false)
    @Volatile private var closed = false

    @Volatile private var state = "idle"       // idle | copying | loading | ready | error | unsupported
    @Volatile private var progress = 0.0
    @Volatile private var error = ""
    @Volatile private var loadMs = 0L
    private val threads: Int
    private val threadsBatch: Int

    init {
        val cores = Runtime.getRuntime().availableProcessors()
        // Never use every core. llama.cpp's worker threads spin-wait on each other at every
        // step; if one is pre-empted (WebView, UI rendering) or lands on a slow LITTLE core,
        // all of them stall. Measured on the 6-vCPU emulator with 6 threads: the same 54-token
        // prefill took 340 ms in one run and 18 s in another. Leave headroom for the UI.
        threads = (cores / 2).coerceIn(2, 4)
        threadsBatch = (cores - 2).coerceIn(2, 6)
    }

    private fun js(code: String) {
        if (closed) return
        main.post { if (!closed) try { web.evaluateJavascript(code, null) } catch (_: Exception) {} }
    }

    @JavascriptInterface
    fun status(): String = JSONObject()
        .put("state", state).put("progress", progress).put("error", error)
        .put("model", MODEL_NAME).put("threads", threads).put("threadsBatch", threadsBatch)
        .put("loadMs", loadMs).put("nCtx", N_CTX)
        .toString()

    @JavascriptInterface
    fun prepare() {
        if (!started.compareAndSet(false, true)) return
        state = "starting"; error = ""
        loader.execute { doPrepare() }
    }

    private fun cpuSupported(): Boolean {
        val abi = android.os.Build.SUPPORTED_ABIS.firstOrNull() ?: ""
        if (!abi.startsWith("arm64")) return true            // x86_64 build targets AVX2 (emulator / Chromebook)
        return try {
            File("/proc/cpuinfo").readText().contains("asimddp")
        } catch (_: Exception) { true }
    }

    private fun doPrepare() {
        val t0 = System.currentTimeMillis()
        try {
            if (!cpuSupported()) { state = "unsupported"; error = "cpu"; notifyStatus(); return }
            val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            val mi = ActivityManager.MemoryInfo().also { am.getMemoryInfo(it) }
            if (mi.totalMem in 1 until 3L * 1024 * 1024 * 1024) { state = "unsupported"; error = "ram"; notifyStatus(); return }

            val dst = File(ctx.filesDir, File(ASSET).name)
            // remove model files from older versions (v4/v5 shipped "qwen.gguf", ~490 MB)
            ctx.filesDir.listFiles()?.forEach { f ->
                if (f.name.endsWith(".gguf") && f.name != dst.name) f.delete()
                if (f.name.endsWith(".gguf.part")) f.delete()
            }
            val expected = ctx.assets.openFd(ASSET).use { it.length }
            if (!dst.exists() || dst.length() != expected) {
                state = "copying"; progress = 0.0; notifyStatus()
                val tmp = File(ctx.filesDir, dst.name + ".part")
                ctx.assets.open(ASSET).use { input ->
                    tmp.outputStream().use { out ->
                        val buf = ByteArray(1 shl 20)
                        var done = 0L
                        var lastReport = 0L
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            out.write(buf, 0, n)
                            done += n
                            progress = done.toDouble() / expected
                            val now = System.currentTimeMillis()
                            if (now - lastReport > 250) { lastReport = now; notifyStatus() }
                        }
                    }
                }
                if (!tmp.renameTo(dst)) throw IllegalStateException("storage")
            }
            // Warm the page cache with ONE sequential read before mmap-loading.
            // Measured on the emulator after a reboot: without this, the model's pages were
            // faulted in randomly during the first prompt (38 s warm-up, 16 s first reply);
            // a sequential read turns that into plain streaming IO. On phones (UFS) it is ~1 s.
            state = "loading"; progress = 0.0; notifyStatus()
            dst.inputStream().use { input ->
                val buf = ByteArray(4 shl 20)
                var done = 0L
                var lastReport = 0L
                val total = dst.length().coerceAtLeast(1)
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    done += n
                    progress = done.toDouble() / total
                    val now = System.currentTimeMillis()
                    if (now - lastReport > 250) { lastReport = now; notifyStatus() }
                }
            }
            progress = 1.0; notifyStatus()
            nativeLoad(dst.absolutePath, N_CTX, threads, threadsBatch)
            loadMs = System.currentTimeMillis() - t0
            state = "ready"; notifyStatus()
        } catch (e: Throwable) {
            state = "error"
            error = when {
                e.message?.contains("storage") == true || e is java.io.IOException -> "storage"
                else -> e.message ?: e.javaClass.simpleName
            }
            started.set(false)    // allow a retry from the page
            notifyStatus()
        }
    }

    private fun notifyStatus() = js("window.__orbitStatus && window.__orbitStatus(" + JSONObject.quote(status()) + ")")

    private fun parseMessages(json: String): Pair<Array<ByteArray>, Array<ByteArray>> {
        val arr = JSONArray(json)
        val roles = Array(arr.length()) { ByteArray(0) }
        val contents = Array(arr.length()) { ByteArray(0) }
        for (i in 0 until arr.length()) {
            val m = arr.getJSONObject(i)
            roles[i] = m.getString("role").toByteArray(Charsets.UTF_8)
            contents[i] = m.getString("content").toByteArray(Charsets.UTF_8)
        }
        return roles to contents
    }

    /** Fill the KV cache with the persona prompt so the first reply is fast. Fire and forget. */
    @JavascriptInterface
    fun warm(messagesJson: String) {
        gen.execute {
            if (!waitReady(120_000)) return@execute
            try {
                val (r, c) = parseMessages(messagesJson)
                val stats = String(nativeGenerate(r, c, 0, 0.7f, 0.9f, -1, true, object : ChunkSink { override fun onChunk(utf8: ByteArray) {} }), Charsets.UTF_8)
                js("window.__orbitWarm && window.__orbitWarm(" + JSONObject.quote(stats) + ")")
            } catch (_: Throwable) {}
        }
    }

    @JavascriptInterface
    fun generate(messagesJson: String, optsJson: String, id: String) {
        gen.execute {
            if (!waitReady(180_000)) {
                js("window.__orbitDone && window.__orbitDone(" + JSONObject.quote(id) + ",false," + JSONObject.quote(if (state == "unsupported") "unsupported" else "not_ready") + ")")
                return@execute
            }
            try {
                val o = if (optsJson.isBlank()) JSONObject() else JSONObject(optsJson)
                val (r, c) = parseMessages(messagesJson)
                // Batch chunks: one evaluateJavascript every ~40 ms instead of per token.
                // (The very first chunk goes out at once: it is the moment the user starts reading.)
                val sb = StringBuilder()
                var last = 0L
                val sink = object : ChunkSink {
                    override fun onChunk(utf8: ByteArray) {
                        sb.append(String(utf8, Charsets.UTF_8))
                        val now = System.currentTimeMillis()
                        if (last == 0L || now - last >= 40) { last = now; flush() }
                    }
                    fun flush() {
                        if (sb.isEmpty()) return
                        val text = sb.toString(); sb.setLength(0)
                        js("window.__orbitChunk && window.__orbitChunk(" + JSONObject.quote(id) + "," + JSONObject.quote(text) + ")")
                    }
                }
                val stats = String(nativeGenerate(r, c, o.optInt("maxTokens", 160), o.optDouble("temperature", 0.7).toFloat(),
                    o.optDouble("topP", 0.9).toFloat(), o.optInt("seed", -1), false, sink), Charsets.UTF_8)
                sink.flush()
                js("window.__orbitDone && window.__orbitDone(" + JSONObject.quote(id) + ",true," + JSONObject.quote(stats) + ")")
            } catch (e: Throwable) {
                js("window.__orbitDone && window.__orbitDone(" + JSONObject.quote(id) + ",false," + JSONObject.quote(e.message ?: "generation_failed") + ")")
            }
        }
    }

    @JavascriptInterface
    fun stop() = nativeStop()

    private fun waitReady(timeoutMs: Long): Boolean {
        if (state == "idle" || state == "error") prepare()
        val end = System.currentTimeMillis() + timeoutMs
        while (state != "ready" && System.currentTimeMillis() < end) {
            if (state == "unsupported" || state == "error" || closed) return false
            Thread.sleep(100)
        }
        return state == "ready"
    }

    fun close() {
        closed = true
        try { nativeStop() } catch (_: Throwable) {}
        gen.shutdown(); loader.shutdown()
    }
}
