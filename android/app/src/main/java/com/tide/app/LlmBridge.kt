package com.tide.app

import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import java.util.concurrent.Executors

/**
 * 潮汐 · 页面 ↔ 大模型 的桥
 * ============================================================
 * 页面只负责"说什么"（拼提示词、组 messages），
 * 原生层负责"怎么发"（加 Key、发 HTTPS、读流），原因：
 *   1. 跨域：WebView 页面直接请求 api.deepseek.com 会被浏览器 CORS 拦
 *   2. Key 安全：Key 存在加密存储里，只在原生层出现，页面拿不到
 *   3. 流式：原生逐行读 SSE，字一个个回传，不用等整段
 *
 * 回调约定（页面里定义）：
 *   window.__tideChunk(cbId, text, done, err)  流式分片
 *   window.__tideResult(id, ok, payload)       一次性请求的结果
 */
class LlmBridge(private val web: WebView, private val keys: KeyStore) {

    private val pool = Executors.newFixedThreadPool(3)
    private val main = Handler(Looper.getMainLooper())
    private val client = LlmClient()

    private fun js(s: String): String =
        "'" + s.replace("\\", "\\\\").replace("'", "\\'")
            .replace("\n", "\\n").replace("\r", "\\r")
            .replace("\u2028", "\\u2028").replace("\u2029", "\\u2029") + "'"

    private fun eval(code: String) {
        main.post { try { web.evaluateJavascript(code, null) } catch (_: Exception) {} }
    }

    private fun chunk(cbId: String, text: String, done: Boolean, err: String?) =
        eval("window.__tideChunk(${js(cbId)}, ${js(text)}, $done, ${if (err == null) "null" else js(err)})")

    private fun result(id: String, ok: Boolean, payload: String) =
        eval("window.__tideResult(${js(id)}, $ok, ${js(payload)})")

    // ---------------- Key 管理（只进不出） ----------------

    @JavascriptInterface fun saveKey(slot: String, key: String) = keys.save(slot, key)
    @JavascriptInterface fun clearKey(slot: String) = keys.clear(slot)
    @JavascriptInterface fun hasKey(slot: String): Boolean = keys.has(slot)
    @JavascriptInterface fun keyHint(slot: String): String = keys.hint(slot)

    // ---------------- 请求 ----------------

    @JavascriptInterface
    fun stream(base: String, slot: String, bodyJson: String, cbId: String) {
        if (!LlmClient.isAllowedEndpoint(base)) {
            chunk(cbId, "", true, "公网地址必须用 https；http 只允许局域网地址"); return
        }
        val key = keys.get(slot)
        pool.execute {
            client.stream(base, key, bodyJson, object : LlmClient.StreamCallback {
                override fun onText(text: String) = chunk(cbId, text, false, null)
                override fun onDone() = chunk(cbId, "", true, null)
                override fun onError(message: String) = chunk(cbId, "", true, message)
            })
        }
    }

    /** 非流式请求：连接测试、记忆抽取 */
    @JavascriptInterface
    fun complete(base: String, slot: String, bodyJson: String, id: String) {
        if (!LlmClient.isAllowedEndpoint(base)) {
            result(id, false, "公网地址必须用 https；http 只允许局域网地址"); return
        }
        val key = keys.get(slot)
        pool.execute {
            try { result(id, true, client.complete(base, key, bodyJson)) }
            catch (e: Exception) { result(id, false, e.message ?: "请求失败") }
        }
    }

    @JavascriptInterface
    fun models(base: String, slot: String, id: String) {
        if (!LlmClient.isAllowedEndpoint(base)) {
            result(id, false, "公网地址必须用 https；http 只允许局域网地址"); return
        }
        val key = keys.get(slot)
        pool.execute {
            try { result(id, true, JSONArray(client.listModels(base, key)).toString()) }
            catch (e: Exception) { result(id, false, e.message ?: "获取失败") }
        }
    }
}
