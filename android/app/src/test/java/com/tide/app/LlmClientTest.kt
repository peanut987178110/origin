package com.tide.app

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.net.InetAddress
import java.net.ServerSocket
import kotlin.concurrent.thread

/**
 * LlmClient 单元测试（在电脑上跑，不需要手机）
 *
 * 用 ServerSocket 手写一个本地假服务（单测编译期看不到 JDK 的 com.sun.net.httpserver），模拟 DeepSeek 等服务商的返回：
 *   · SSE 流式分片、[DONE]、各家格式差异（data: 有无空格、reasoning_content）
 *   · 401 / 402 / 429 错误体
 *   · Authorization 头是否正确带上
 * 这些是真机上最容易出错、又最难调试的部分。
 */
class LlmClientTest {

    private lateinit var server: ServerSocket
    private var base = ""
    @Volatile private var lastAuth: String? = null
    @Volatile private var lastBody: String = ""
    private val routes = HashMap<String, Triple<Int, String, String>>()

    /** 注册一个路由：路径 → (状态码, Content-Type, 响应体) */
    private fun respond(path: String, code: Int, contentType: String, body: String) {
        routes[path] = Triple(code, contentType, body)
    }

    @Before fun up() {
        server = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
        base = "http://127.0.0.1:${server.localPort}/v1"
        thread(isDaemon = true) {
            while (!server.isClosed) {
                val sock = try { server.accept() } catch (_: Exception) { break }
                sock.use { s ->
                    val inp = s.getInputStream().bufferedReader(Charsets.UTF_8)
                    val path = inp.readLine()?.split(" ")?.getOrNull(1) ?: return@use
                    var len = 0; var auth: String? = null
                    while (true) {
                        val h = inp.readLine() ?: break
                        if (h.isEmpty()) break
                        val k = h.substringBefore(":").trim().lowercase(); val v = h.substringAfter(":").trim()
                        if (k == "content-length") len = v.toInt()
                        if (k == "authorization") auth = v
                    }
                    val buf = CharArray(len); var n = 0
                    while (n < len) { val r = inp.read(buf, n, len - n); if (r < 0) break; n += r }
                    lastAuth = auth; lastBody = String(buf, 0, n)
                    val (code, type, body) = routes[path] ?: Triple(404, "text/plain", "not found")
                    val bytes = body.toByteArray(Charsets.UTF_8)
                    val out = s.getOutputStream()
                    val crlf = "\r\n"
                    val head = "HTTP/1.1 $code X" + crlf + "Content-Type: $type" + crlf +
                        "Content-Length: ${bytes.size}" + crlf + "Connection: close" + crlf + crlf
                    out.write(head.toByteArray())
                    out.write(bytes); out.flush()
                }
            }
        }
    }

    @After fun down() { server.close() }

    private class Collect : LlmClient.StreamCallback {
        val text = StringBuilder(); var done = false; var error: String? = null
        override fun onText(text: String) { this.text.append(text) }
        override fun onDone() { done = true }
        override fun onError(message: String) { error = message }
    }

    // ---------------- 解析 ----------------

    @Test fun parse_standardChunk() {
        val e = LlmClient.parseSseLine("""data: {"choices":[{"delta":{"content":"你好"}}]}""")
        assertEquals(LlmClient.SseEvent.Text("你好"), e)
    }

    @Test fun parse_noSpaceAfterData() {
        val e = LlmClient.parseSseLine("""data:{"choices":[{"delta":{"content":"嗯"}}]}""")
        assertEquals(LlmClient.SseEvent.Text("嗯"), e)
    }

    @Test fun parse_done() {
        assertEquals(LlmClient.SseEvent.Done, LlmClient.parseSseLine("data: [DONE]"))
    }

    @Test fun parse_reasoningChunkIsSkipped_notShownAsNull() {
        // DeepSeek-R1：思考阶段 content 为 null，只有 reasoning_content
        val e = LlmClient.parseSseLine("""data: {"choices":[{"delta":{"content":null,"reasoning_content":"想一想"}}]}""")
        assertNull(e)
    }

    @Test fun parse_roleOnlyAndKeepAliveAndGarbage() {
        assertNull(LlmClient.parseSseLine("""data: {"choices":[{"delta":{"role":"assistant"}}]}"""))
        assertNull(LlmClient.parseSseLine(": keep-alive"))
        assertNull(LlmClient.parseSseLine(""))
        assertNull(LlmClient.parseSseLine("data: {not json"))
    }

    @Test fun parse_errorInStream() {
        val e = LlmClient.parseSseLine("""data: {"error":{"message":"rate limited"}}""")
        assertEquals(LlmClient.SseEvent.Error("rate limited"), e)
    }

    @Test fun endpoint_rules() {
        assertTrue(LlmClient.isAllowedEndpoint("https://api.deepseek.com/v1"))
        assertTrue(LlmClient.isAllowedEndpoint("http://192.168.1.8:11434/v1"))
        assertTrue(LlmClient.isAllowedEndpoint("http://10.10.1.52:11434/v1"))
        assertTrue(LlmClient.isAllowedEndpoint("http://172.20.0.3/v1"))
        assertFalse(LlmClient.isAllowedEndpoint("http://8.8.8.8/v1"))        // 公网明文
        assertFalse(LlmClient.isAllowedEndpoint("http://172.40.0.1/v1"))     // 不是私有段
        assertFalse(LlmClient.isAllowedEndpoint("http://api.example.com/v1"))
        assertFalse(LlmClient.isAllowedEndpoint("ftp://x"))
        assertFalse(LlmClient.isAllowedEndpoint("not a url"))
    }

    @Test fun urls_trimSlash() {
        assertEquals("https://a.com/v1/chat/completions", LlmClient.chatUrl("https://a.com/v1/"))
        assertEquals("https://a.com/v1/models", LlmClient.modelsUrl("https://a.com/v1"))
    }

    // ---------------- 真实 HTTP ----------------

    @Test fun stream_happyPath_withAuthHeader() {
        respond("/v1/chat/completions", 200, "text/event-stream", """
            data: {"choices":[{"delta":{"role":"assistant"}}]}

            data: {"choices":[{"delta":{"content":"听你说"}}]}

            data:{"choices":[{"delta":{"content":"这个，"}}]}

            data: {"choices":[{"delta":{"content":"我心里也沉了一下。"}}]}

            data: [DONE]

        """.trimIndent())
        val c = Collect()
        LlmClient().stream(base, "sk-test-123", """{"model":"x","messages":[]}""", c)
        assertNull(c.error)
        assertTrue(c.done)
        assertEquals("听你说这个，我心里也沉了一下。", c.text.toString())
        assertEquals("Bearer sk-test-123", lastAuth)
        assertTrue(lastBody.contains("\"model\":\"x\""))
    }

    @Test fun stream_withoutDoneMarker_stillCompletes() {
        respond("/v1/chat/completions", 200, "text/event-stream",
            "data: {\"choices\":[{\"delta\":{\"content\":\"好\"}}]}\n\n")
        val c = Collect()
        LlmClient().stream(base, null, "{}", c)
        assertTrue(c.done); assertEquals("好", c.text.toString())
        assertNull(lastAuth)   // 本地 Ollama 不需要 Key，就不能带空的 Authorization
    }

    @Test fun stream_401_givesReadableError() {
        respond("/v1/chat/completions", 401, "application/json",
            """{"error":{"message":"Authentication Fails, Your api key: ****abcd is invalid","type":"authentication_error"}}""")
        val c = Collect()
        LlmClient().stream(base, "bad", "{}", c)
        assertFalse(c.done)
        assertTrue(c.error!!.startsWith("HTTP 401"))
        assertTrue(c.error!!.contains("invalid"))
    }

    @Test fun complete_returnsContent() {
        respond("/v1/chat/completions", 200, "application/json",
            """{"choices":[{"message":{"role":"assistant","content":"在的，今天怎么样？"}}]}""")
        assertEquals("在的，今天怎么样？", LlmClient().complete(base, "k", "{}"))
    }

    @Test fun complete_402_throwsWithMessage() {
        respond("/v1/chat/completions", 402, "application/json", """{"error":{"message":"Insufficient Balance"}}""")
        val msg = try { LlmClient().complete(base, "k", "{}"); "" } catch (e: Exception) { e.message ?: "" }
        assertTrue(msg.contains("402")); assertTrue(msg.contains("Insufficient Balance"))
    }

    @Test fun listModels_parsesIds() {
        respond("/v1/models", 200, "application/json",
            """{"object":"list","data":[{"id":"deepseek-chat"},{"id":"deepseek-reasoner"}]}""")
        assertEquals(listOf("deepseek-chat", "deepseek-reasoner"), LlmClient().listModels(base, "k"))
    }
}
