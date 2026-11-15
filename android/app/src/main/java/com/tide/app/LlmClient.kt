package com.tide.app

import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL

/**
 * 潮汐 · 大模型客户端（OpenAI 兼容协议）
 * ============================================================
 * 为什么只做一套协议：
 *   DeepSeek、通义千问（兼容模式）、Kimi、智谱、豆包（火山方舟）、
 *   硅基流动、OpenAI、本机 Ollama（/v1）都支持
 *   POST {base}/chat/completions + SSE 流式返回。
 *   一套代码覆盖全部服务商，换服务商 = 换 base URL + Key + 模型名。
 *
 * 为什么是纯 Kotlin、不依赖 Android：
 *   这样能在电脑上直接跑单元测试（见 src/test/.../LlmClientTest.kt），
 *   不用真机也能验证"流式解析、鉴权、错误处理"这些最容易出错的部分。
 */
class LlmClient(
    private val connectTimeoutMs: Int = 20_000,
    private val readTimeoutMs: Int = 180_000
) {

    interface StreamCallback {
        fun onText(text: String)
        fun onDone()
        fun onError(message: String)
    }

    sealed class SseEvent {
        data class Text(val text: String) : SseEvent()
        object Done : SseEvent()
        data class Error(val message: String) : SseEvent()
    }

    companion object {
        fun chatUrl(base: String) = base.trim().trimEnd('/') + "/chat/completions"
        fun modelsUrl(base: String) = base.trim().trimEnd('/') + "/models"

        /**
         * 明文 http 只允许私有地址（10.x / 192.168.x / 172.16–31.x）。
         * 情绪对话是最敏感的数据，不能明文发到公网。
         */
        fun isAllowedEndpoint(base: String): Boolean {
            val u = try { URL(base.trim()) } catch (_: Exception) { return false }
            if (u.protocol == "https") return true
            if (u.protocol != "http") return false
            val p = u.host.split(".").mapNotNull { it.toIntOrNull() }
            if (p.size != 4) return false
            return p[0] == 10 || (p[0] == 192 && p[1] == 168) || (p[0] == 172 && p[1] in 16..31)
        }

        /**
         * 解析一行 SSE。
         * 兼容各家差异："data: {...}" 和 "data:{...}" 都要认；
         * DeepSeek-R1 这类推理模型先吐 reasoning_content，content 为 null —— 跳过，不能显示成 "null"。
         */
        fun parseSseLine(raw: String): SseEvent? {
            val line = raw.trim()
            if (line.isEmpty() || line.startsWith(":")) return null
            if (!line.startsWith("data:")) return null
            val payload = line.removePrefix("data:").trim()
            if (payload == "[DONE]") return SseEvent.Done
            return try {
                val o = JSONObject(payload)
                if (o.has("error")) return SseEvent.Error(errorMessage(o))
                val choices = o.optJSONArray("choices") ?: return null
                if (choices.length() == 0) return null
                val delta = choices.getJSONObject(0).optJSONObject("delta") ?: return null
                if (!delta.has("content") || delta.isNull("content")) return null
                val text = delta.getString("content")
                if (text.isEmpty()) null else SseEvent.Text(text)
            } catch (_: Exception) {
                null
            }
        }

        /** 从各家的错误体里抠出人能看懂的那句 */
        fun errorMessage(o: JSONObject): String {
            val e = o.opt("error")
            return when (e) {
                is JSONObject -> e.optString("message").ifBlank { e.toString() }
                is String -> e
                else -> o.optString("message").ifBlank { o.toString() }
            }.take(300)
        }

        fun errorFromBody(code: Int, body: String): String {
            val msg = try { errorMessage(JSONObject(body)) } catch (_: Exception) { body.take(200) }
            return "HTTP $code ${msg.trim()}".trim()
        }
    }

    private fun open(url: String, method: String, apiKey: String?): HttpURLConnection =
        (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = connectTimeoutMs
            readTimeout = readTimeoutMs
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
            if (!apiKey.isNullOrBlank()) setRequestProperty("Authorization", "Bearer " + apiKey.trim())
        }

    private fun readAll(conn: HttpURLConnection, ok: Boolean): String {
        val s = (if (ok) conn.inputStream else (conn.errorStream ?: conn.inputStream)) ?: return ""
        return s.bufferedReader(Charsets.UTF_8).use { it.readText() }
    }

    /** 流式对话：逐行读 SSE，文字片段即时回调 */
    fun stream(base: String, apiKey: String?, bodyJson: String, cb: StreamCallback) {
        var conn: HttpURLConnection? = null
        try {
            conn = open(chatUrl(base), "POST", apiKey).apply {
                doOutput = true
                setRequestProperty("Accept", "text/event-stream")
            }
            OutputStreamWriter(conn.outputStream, Charsets.UTF_8).use { it.write(bodyJson) }

            val code = conn.responseCode
            if (code !in 200..299) {
                cb.onError(errorFromBody(code, readAll(conn, false)))
                return
            }
            BufferedReader(InputStreamReader(conn.inputStream, Charsets.UTF_8)).use { reader ->
                while (true) {
                    val line = reader.readLine() ?: break
                    when (val ev = parseSseLine(line)) {
                        is SseEvent.Text -> cb.onText(ev.text)
                        is SseEvent.Error -> { cb.onError(ev.message); return }
                        SseEvent.Done -> { cb.onDone(); return }
                        null -> {}
                    }
                }
            }
            cb.onDone()   // 有的服务商不发 [DONE]，流结束也算完成
        } catch (e: Exception) {
            cb.onError(e.message ?: e.javaClass.simpleName)
        } finally {
            try { conn?.disconnect() } catch (_: Exception) {}
        }
    }

    /** 非流式：返回模型回复正文（连接测试、记忆抽取用） */
    fun complete(base: String, apiKey: String?, bodyJson: String): String {
        var conn: HttpURLConnection? = null
        try {
            conn = open(chatUrl(base), "POST", apiKey).apply { doOutput = true }
            OutputStreamWriter(conn.outputStream, Charsets.UTF_8).use { it.write(bodyJson) }
            val code = conn.responseCode
            val body = readAll(conn, code in 200..299)
            if (code !in 200..299) throw RuntimeException(errorFromBody(code, body))
            val o = JSONObject(body)
            if (o.has("error")) throw RuntimeException(errorMessage(o))
            val choices = o.optJSONArray("choices") ?: JSONArray()
            if (choices.length() == 0) return ""
            val msg = choices.getJSONObject(0).optJSONObject("message") ?: return ""
            return if (msg.isNull("content")) "" else msg.optString("content", "")
        } finally {
            try { conn?.disconnect() } catch (_: Exception) {}
        }
    }

    /** 拉取模型列表：GET {base}/models → data[].id */
    fun listModels(base: String, apiKey: String?): List<String> {
        var conn: HttpURLConnection? = null
        try {
            conn = open(modelsUrl(base), "GET", apiKey)
            val code = conn.responseCode
            val body = readAll(conn, code in 200..299)
            if (code !in 200..299) throw RuntimeException(errorFromBody(code, body))
            val arr = JSONObject(body).optJSONArray("data") ?: return emptyList()
            return (0 until arr.length()).mapNotNull { arr.optJSONObject(it)?.optString("id") }
                .filter { it.isNotBlank() }
        } finally {
            try { conn?.disconnect() } catch (_: Exception) {}
        }
    }
}
