package com.tide.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewAssetLoader

/**
 * Orbit · Android shell (v6)
 * ============================================================
 *   MainActivity  —— lifecycle, back key, permissions
 *   OrbitEngine   —— window.AndroidOrbitAI : the on-device model (llama.cpp). Default and only brain.
 *   OrbitBridge   —— window.AndroidOrbit   : locale / timezone / notifications
 *   VoiceBridge   —— window.AndroidVoice   : system TTS + speech recognition
 *
 * v6 is local-first: the shell registers NO network bridge. v5 routed every page
 * transition and every message through a server that real phones could not reach,
 * which is why each step waited ~10 s before falling back. TideApi.kt / LlmClient.kt
 * stay in the repo as references for a future cloud mode, but are not registered.
 *
 * 为什么用 WebViewAssetLoader 而不是 file:///android_asset/
 * ------------------------------------------------------------------
 * file:// 有三个实际麻烦：
 *   ① localStorage 在部分系统版本上被限制，登录状态会丢
 *   ② Service Worker 在 file:// 下不注册，离线缓存失效
 *   ③ 没有正常的 origin，某些浏览器 API 直接报错
 * 用 https://appassets.androidplatform.net 加载同一份本地文件，
 * 就能拿到正常的 HTTPS origin，以上三条全解决，且不联网。
 *
 * 为什么用 WebView 而不是原生重写（如实说）
 * ------------------------------------------------------------------
 * 产品仍在验证阶段，界面一天改三次。WebView 让一次改动三端同步。
 * 代价是首屏慢 200–400ms、手感偏"网页"。
 * 一旦"每晚会不会来"这个假设被验证，就该重写为 Compose——
 * 那时才知道该优化哪里，而不是先花一个月做可能没人用的原生版。
 */
class MainActivity : AppCompatActivity() {

    private lateinit var web: WebView
    private lateinit var voice: VoiceBridge
    private lateinit var engine: OrbitEngine

    private val main = Handler(Looper.getMainLooper())

    // 麦克风权限：语音输入用。被拒也不影响文字聊天，所以不做强制引导。
    private val micLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) {
            web.evaluateJavascript("window.__tideMicGranted && window.__tideMicGranted()", null)
        } else {
            web.evaluateJavascript(
                "window.__tideSpeechError && window.__tideSpeechError(window.__micDeniedText || 'Microphone permission was denied')", null
            )
        }
    }

    // 通知权限：只有用户在设置里打开"晚间关怀"时才请求，不在启动时弹窗
    private val notifLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        web.evaluateJavascript("window.__tideNotifResult && window.__tideNotifResult(" + granted + ")", null)
    }

    fun requestNotifications() {
        if (android.os.Build.VERSION.SDK_INT >= 33) main.post { notifLauncher.launch(Manifest.permission.POST_NOTIFICATIONS) }
        else web.evaluateJavascript("window.__tideNotifResult && window.__tideNotifResult(true)", null)
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Debug builds only: lets tools/orbit_device_test.js drive the real page over CDP (adb forward).
        if (0 != (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE)) {
            WebView.setWebContentsDebuggingEnabled(true)
        }

        // 本地资源走虚拟域名：不联网，但有正常 origin
        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        web = WebView(this).apply {
            setBackgroundColor(Color.parseColor("#0b0a18"))
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true          // 账号 / 对话 / 记忆全在 localStorage
                databaseEnabled = true
                allowFileAccess = false           // 走 asset loader，不需要文件协议
                allowContentAccess = false
                cacheMode = WebSettings.LOAD_DEFAULT
                mediaPlaybackRequiresUserGesture = true
                textZoom = 100
                mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            }

            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView,
                    request: WebResourceRequest
                ): WebResourceResponse? {
                    val res = assetLoader.shouldInterceptRequest(request.url)
                    if (res != null) return res
                    // 非本地资源一律不加载
                    return if (request.url.host == "appassets.androidplatform.net") null
                           else WebResourceResponse("text/plain", "utf-8", null)
                }

                override fun shouldOverrideUrlLoading(
                    view: WebView,
                    request: WebResourceRequest
                ): Boolean = true   // 页面内不允许跳转，避免把人带出去
            }

            // VoiceBridge 需要 Context（申请权限、拿系统 TTS）和 WebView（回传识别结果）。
            // apply{} 里的 this 就是 WebView 本身。
            voice = VoiceBridge(this@MainActivity, this) {
                main.post { micLauncher.launch(Manifest.permission.RECORD_AUDIO) }
            }

            engine = OrbitEngine(this@MainActivity, this)
            addJavascriptInterface(engine, "AndroidOrbitAI")
            addJavascriptInterface(OrbitBridge(this@MainActivity), "AndroidOrbit")
            addJavascriptInterface(voice, "AndroidVoice")

            loadUrl("https://appassets.androidplatform.net/assets/index.html")
        }

        setContentView(web)

        window.statusBarColor = Color.parseColor("#0b0a18")
        window.navigationBarColor = Color.parseColor("#0b0a18")
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LAYOUT_STABLE

        // 返回键：先关抽屉 / 停录音，再退出。
        // 深夜单手半睡状态，误触直接退出很挫。
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                web.evaluateJavascript(HANDLE_BACK_JS) { result ->
                    if (result.contains("exit")) finish()
                }
            }
        })
    }

    override fun onPause() {
        super.onPause()
        try { voice.stop() } catch (_: Exception) {}
        try { voice.stopListening() } catch (_: Exception) {}
        web.onPause()
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
        // 从晚间关怀通知点进来：让页面上报 nudge_opened
        if (intent?.getBooleanExtra("from_nudge", false) == true) {
            intent.removeExtra("from_nudge")
            CareNotifier.markOpened(this)
        }
        web.evaluateJavascript("window.__orbitResumed && window.__orbitResumed()", null)
    }

    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
    }

    override fun onDestroy() {
        try { voice.destroy() } catch (_: Exception) {}
        engine.close()
        web.destroy()
        super.onDestroy()
    }

    companion object {
        /**
         * 返回键交给页面判断（window.__tideBack），因为"该关什么"只有页面知道：
         * 抽屉开着 → 关抽屉；正在录音 → 停录音；在设置子页 → 回聊天；否则 → 退出。
         */
        private const val HANDLE_BACK_JS = """
            (function(){
              try { return window.__orbitBack ? window.__orbitBack() : 'exit'; }
              catch(e) { return 'exit'; }
            })()
        """
    }
}
