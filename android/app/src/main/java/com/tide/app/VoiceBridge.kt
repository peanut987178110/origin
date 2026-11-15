package com.tide.app

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.webkit.JavascriptInterface
import android.webkit.WebView
import java.util.Locale

/**
 * 潮汐 · 语音桥接
 * ============================================================
 * 为什么不用页面里的 speechSynthesis / SpeechRecognition：
 *
 * WebView 对 Web Speech API 的支持很不稳定——
 * speechSynthesis 在部分安卓 WebView 上完全没有实现，
 * webkitSpeechRecognition 基本都不可用（需要 Google 服务框架）。
 * 而系统的 TextToSpeech 和 SpeechRecognizer 是每台安卓机都有的能力。
 *
 * 这里把系统能力包成两个简单接口给页面调用：
 *   speak(text, rate, pitch, pauseMs) / stop()
 *   startListening() / stopListening()
 *
 * speak() 会先等上一条说完、再静一静（pauseMs），然后才开口。页面把一句回复拆成
 * 短句、每句带自己的语速/音高/停顿，让声音有起伏；如果把这些短句直接 QUEUE_ADD，
 * 引擎会把它们连成一串没有停顿的字，听起来反而更平。
 */
class VoiceBridge(
    private val ctx: Context,
    private val web: WebView,
    private val onNeedMicPermission: () -> Unit
) {

    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private val main = Handler(Looper.getMainLooper())
    private var recognizer: SpeechRecognizer? = null
    private var paused: Runnable? = null                         // the pending "wait, then speak" step
    private var lastDoneAt = 0L                                  // when the last phrase actually finished speaking
    private var waitForIdle: Runnable? = null                    // "start this phrase once the engine is free"
    @Volatile private var langTag = "en-US"      // set by the page: Orbit is English-first
    private fun zh() = langTag.startsWith("zh")

    init {
        tts = TextToSpeech(ctx) { status ->
            ttsReady = status == TextToSpeech.SUCCESS
            if (ttsReady) {
                applyTtsLanguage()
            }
        }
        /* The page reads a reply clause by clause and waits for each one to end before starting
           the next (its own estimate was a guess — a short clause at a slow rate got cut off).
           onDone/onError/onStop tell the page the voice has actually finished speaking.
           v6.3: onStart says the phrase is actually being spoken now (the page waits for it
           instead of guessing), and lastDoneAt marks a real phrase boundary, so a pause between
           phrases is never doubled by an estimate. */
        tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) { notifyStart(utteranceId) }
            override fun onDone(utteranceId: String?) { lastDoneAt = SystemClock.uptimeMillis(); notifyEnd(utteranceId) }
                    @Deprecated("兼容旧版本")
            override fun onError(utteranceId: String?) { notifyEnd(utteranceId) }
            /* API 21+: gives us the error code, so the page can fall back to plain text
               instead of showing a dead clause when the device has no voice for this language. */
            override fun onError(utteranceId: String?, errorCode: Int) { notifyError(utteranceId, errorCode) }
            override fun onStop(utteranceId: String?, interrupted: Boolean) { notifyEnd(utteranceId) }
        })
    }

    private fun applyTtsLanguage() {
        try {
            val r = tts?.setLanguage(Locale.forLanguageTag(langTag))
            if (r == TextToSpeech.LANG_MISSING_DATA || r == TextToSpeech.LANG_NOT_SUPPORTED) {
                tts?.setLanguage(Locale.getDefault())
            }
        } catch (_: Exception) {}
    }

    private fun notifyStart(utteranceId: String?) {
        val id = utteranceId ?: return
        web.post { try { web.evaluateJavascript("window.__orbitVoiceStart && window.__orbitVoiceStart(" + jsString(id) + ")", null) } catch (_: Exception) {} }
    }

    private fun notifyError(utteranceId: String?, errorCode: Int) {
        val id = utteranceId ?: return
        web.post { try { web.evaluateJavascript("window.__orbitVoiceEnd && window.__orbitVoiceEnd(" + jsString(id) + "," + errorCode + ")", null) } catch (_: Exception) {} }
    }

    private fun notifyEnd(utteranceId: String?) {
        val id = utteranceId ?: return
        web.post { try { web.evaluateJavascript("window.__orbitVoiceEnd && window.__orbitVoiceEnd(" + jsString(id) + ")", null) } catch (_: Exception) {} }
    }

    /** "en-US" / "zh-CN" — the page calls this when the user's language is known or changes. */
    @JavascriptInterface
    fun setLanguage(tag: String) {
        langTag = if (tag.isBlank()) "en-US" else tag
        main.post { if (ttsReady) applyTtsLanguage() }
    }

    private fun jsString(s: String): String =
        "'" + s.replace("\\", "\\\\")
              .replace("'", "\\'")
              .replace("\n", "\\n")
              .replace("\r", "\\r") + "'"

    /** 朗读一段话；rate/pitch 夹到合理区间，pauseMs 是念完后的停顿 */
    @JavascriptInterface
    fun speak(text: String, rate: Float, pitch: Float) = speak(text, rate, pitch, 0)

    @JavascriptInterface
    fun speak(text: String, rate: Float, pitch: Float, pauseMs: Int) {
        if (text.isBlank()) return
        val r = rate.coerceIn(0.6f, 1.5f)
        val p = pitch.coerceIn(0.6f, 1.6f)
        val pause = pauseMs.coerceIn(0, 1200).toLong()
        val id = "orbit_" + System.nanoTime()
        val say = Runnable {
            paused = null
            try {
                if (!ttsReady) {
                    web.post { web.evaluateJavascript("window.__orbitVoiceEnd && window.__orbitVoiceEnd(" + jsString(id) + ",0)", null) }
                    return@Runnable
                }
                tts?.setSpeechRate(r)
                tts?.setPitch(p)
                // QUEUE_FLUSH: exactly one clause is in the engine at a time — the page sends the
                // next one only after this one reports done (+ its own pause). The id is echoed
                // back through window.__orbitVoiceEnd when the clause is done.
                tts?.speak(text, TextToSpeech.QUEUE_FLUSH, Bundle(), id)
            } catch (_: Exception) {}
        }
        main.post {
            try {
                if (tts?.isSpeaking == true) {
                    // The page sent the next phrase while the previous one is still audible (its
                    // estimated length was a little short). Starting now would cut a word off, so
                    // wait for the engine to finish; the page's own safety timer covers engines
                    // that never report "done".
                    paused?.let { main.removeCallbacks(it) }
                    paused = say
                    waitForIdle?.let { main.removeCallbacks(it) }
                    val waiter: Runnable = object : Runnable {
                        override fun run() {
                            if (paused !== say) return
                            if (tts?.isSpeaking == true) main.postDelayed(this, 60)
                            else { paused = null; main.postDelayed(say, pause) }
                        }
                    }
                    waitForIdle = waiter
                    main.postDelayed(waiter, 60)
                    return@post
                }
                lastDoneAt = 0L
                // any later speak() replaces the waiting one (a stop/reset cancels it)
                paused?.let { main.removeCallbacks(it) }
                paused = say
                val speakMs = (text.length * 72L).coerceAtLeast(400L)
                main.postDelayed(say, speakMs + pause)
            } catch (_: Exception) {}
        }
    }

    /** 新的回复开始朗读前调用：丢掉还排在队列里的话 */
    @JavascriptInterface
    fun reset() {
        main.post { paused?.let { main.removeCallbacks(it) }; waitForIdle?.let { main.removeCallbacks(it) }; paused = null; waitForIdle = null; try { tts?.stop() } catch (_: Exception) {} }
    }

    @JavascriptInterface
    fun stop() {
        main.post { paused?.let { main.removeCallbacks(it) }; waitForIdle?.let { main.removeCallbacks(it) }; paused = null; waitForIdle = null; try { tts?.stop() } catch (_: Exception) {} }
    }

    @JavascriptInterface
    fun isAvailable(): Boolean = ttsReady

    @JavascriptInterface
    fun startListening() {
        if (!SpeechRecognizer.isRecognitionAvailable(ctx)) {
            val m = if (zh()) "这台手机没有语音识别" else "Voice input isn't available on this device"
            main.post { web.evaluateJavascript("window.__tideSpeechError(${jsString(m)})", null) }
            return
        }
        if (!hasMicPermission()) { onNeedMicPermission(); return }

        main.post {
            try {
                recognizer?.destroy()
                recognizer = SpeechRecognizer.createSpeechRecognizer(ctx).apply {
                    setRecognitionListener(object : RecognitionListener {
                        override fun onReadyForSpeech(params: Bundle?) {}
                        override fun onBeginningOfSpeech() {}
                        override fun onRmsChanged(rmsdB: Float) {}
                        override fun onBufferReceived(buffer: ByteArray?) {}
                        override fun onEndOfSpeech() {}
                        override fun onError(error: Int) {
                            val msg = when (error) {
                                SpeechRecognizer.ERROR_NO_MATCH -> ""
                                SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> ""
                                SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> if (zh()) "缺少麦克风权限" else "Microphone permission is needed"
                                SpeechRecognizer.ERROR_NETWORK -> if (zh()) "语音识别需要联网" else "Voice input needs a connection on this device"
                                else -> if (zh()) "没听清，再说一次" else "Didn't catch that — try again"
                            }
                            if (msg.isNotEmpty()) {
                                web.evaluateJavascript("window.__tideSpeechError(${jsString(msg)})", null)
                            }
                            web.evaluateJavascript("window.__tideSpeechEnd()", null)
                        }
                        override fun onResults(results: Bundle?) {
                            val list = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                            val text = list?.firstOrNull() ?: ""
                            if (text.isNotBlank()) {
                                web.evaluateJavascript("window.__tideSpeech(${jsString(text)})", null)
                            }
                            web.evaluateJavascript("window.__tideSpeechEnd()", null)
                        }
                        override fun onPartialResults(partialResults: Bundle?) {}
                        override fun onEvent(eventType: Int, params: Bundle?) {}
                    })

                    val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                        putExtra(RecognizerIntent.EXTRA_LANGUAGE, langTag)
                        putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false)
                        putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
                    }
                    startListening(intent)
                }
            } catch (e: Exception) {
                web.evaluateJavascript("window.__tideSpeechError(${jsString(if (zh()) "语音启动失败" else "Couldn't start voice input")})", null)
            }
        }
    }

    @JavascriptInterface
    fun stopListening() {
        main.post { try { recognizer?.stopListening() } catch (_: Exception) {} }
    }

    private fun hasMicPermission(): Boolean =
        ctx.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) ==
            android.content.pm.PackageManager.PERMISSION_GRANTED

    fun destroy() {
        try { tts?.shutdown() } catch (_: Exception) {}
        try { recognizer?.destroy() } catch (_: Exception) {}
        tts = null
        recognizer = null
    }
}
