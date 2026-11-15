package com.tide.app

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale
import java.util.concurrent.Executors

/**
 * 潮汐 v5 · 页面 ↔ 潮汐服务端 的桥
 * ============================================================
 * 和 v3 的 LlmBridge 最大的区别：手机里不再有任何模型厂商的 API Key。
 * 手机只持有"潮汐服务端发的设备 token"，模型 Key 只在服务器的环境变量里。
 *
 * 为什么由原生层发请求而不是页面 fetch：
 *   页面跑在 https://appassets.androidplatform.net，直接请求服务端会被 CORS 拦；
 *   token 存在加密存储里，页面拿不到明文（只进不出，和 v3 的 Key 一样）。
 *
 * 服务端地址来自 BuildConfig.TIDE_SERVER（构建时注入），用户不需要配置任何东西。
 */
class TideApi(private val ctx: Context, private val web: WebView, private val keys: KeyStore) {

    private val pool = Executors.newFixedThreadPool(2)
    private val main = Handler(Looper.getMainLooper())
    private val base = BuildConfig.TIDE_SERVER.trimEnd('/')

    @Volatile private var closed = false
    fun close() { closed = true; pool.shutdown() }

    private fun js(s: String): String = JSONObject.quote(s)

    private fun reply(id: String, status: Int, body: String) {
        val code = "window.__tideApi && window.__tideApi(" + js(id) + "," + status + "," + js(body) + ")"
        main.post { if (!closed) try { web.evaluateJavascript(code, null) } catch (_: Exception) {} }
    }

    private fun token(): String? = keys.get(TOKEN_SLOT)

    /** 地区：只取系统设置的国家代码（不用定位权限），用来选热线 */
    @JavascriptInterface fun country(): String = Locale.getDefault().country.uppercase(Locale.ROOT)
    @JavascriptInterface fun systemLang(): String = if (Locale.getDefault().language == "zh") "zh" else "en"
    @JavascriptInterface fun hasToken(): Boolean = token() != null
    @JavascriptInterface fun serverHost(): String = try { URL(base).host } catch (_: Exception) { "" }

    /** 第一次启动：静默注册，拿到 token 存进加密存储；页面只拿到 deviceId 和实验分组 */
    @JavascriptInterface
    fun register(lang: String, id: String) {
        pool.execute {
            val body = JSONObject().put("country", country()).put("lang", lang).toString()
            val (status, text) = http("POST", "/v1/register", body, null)
            if (status == 200) {
                try {
                    val o = JSONObject(text)
                    keys.save(TOKEN_SLOT, o.getString("token"))
                    o.remove("token")                         // token 不回传页面
                    reply(id, status, o.toString())
                    return@execute
                } catch (_: Exception) {}
            }
            reply(id, status, text)
        }
    }

    /** 通用请求：method + path + body。只允许 /v1/ 下的接口。 */
    @JavascriptInterface
    fun call(method: String, path: String, body: String, id: String) {
        if (!path.startsWith("/v1/") || path.contains("..")) { reply(id, 400, "{\"error\":\"bad_path\"}"); return }
        val m = method.uppercase(Locale.ROOT)
        if (m !in setOf("GET", "POST", "DELETE")) { reply(id, 400, "{\"error\":\"bad_method\"}"); return }
        pool.execute {
            val (status, text) = http(m, path, body.ifBlank { null }, token())
            if (status == 401) keys.clear(TOKEN_SLOT)       // token 失效：清掉，下次重新静默注册
            if (m == "DELETE" && path == "/v1/me" && status == 200) keys.clear(TOKEN_SLOT)
            reply(id, status, text)
        }
    }

    /** 晚间关怀：页面传来服务端给的提醒内容，原生层在用户的晚间时段排一次通知 */
    @JavascriptInterface
    fun scheduleNudge(title: String, body: String, hourLocal: Int) {
        CareNotifier.schedule(ctx, title, body, hourLocal.coerceIn(18, 23))
    }
    @JavascriptInterface fun cancelNudge() = CareNotifier.cancel(ctx)
    @JavascriptInterface fun notificationsAllowed(): Boolean = CareNotifier.allowed(ctx)
    @JavascriptInterface fun requestNotifications() { (ctx as? MainActivity)?.requestNotifications() }
    @JavascriptInterface fun lastNudgeOpened(): Boolean = CareNotifier.consumeOpened(ctx)

    private fun http(method: String, path: String, body: String?, tok: String?): Pair<Int, String> {
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(base + path).openConnection() as HttpURLConnection).apply {
                requestMethod = method
                connectTimeout = 10_000
                readTimeout = 40_000
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                setRequestProperty("X-Tide-Client", "android/" + BuildConfig.VERSION_NAME)
                if (tok != null) setRequestProperty("Authorization", "Bearer $tok")
                if (body != null && method != "GET") {
                    doOutput = true
                    OutputStreamWriter(outputStream, Charsets.UTF_8).use { it.write(body) }
                }
            }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else (conn.errorStream ?: conn.inputStream)
            val text = BufferedReader(InputStreamReader(stream, Charsets.UTF_8)).use { it.readText() }
            code to text
        } catch (e: Exception) {
            0 to JSONObject().put("error", "network").put("detail", e.javaClass.simpleName).toString()
        } finally {
            try { conn?.disconnect() } catch (_: Exception) {}
        }
    }

    companion object { const val TOKEN_SLOT = "tide_server_token" }
}
