package com.tide.app

import android.content.Context
import android.webkit.JavascriptInterface
import java.util.Locale
import java.util.TimeZone

/**
 * Orbit · device bridge (window.AndroidOrbit)
 * Locale / timezone for the onboarding defaults and proactive-message timing,
 * plus the notification hooks. No network access lives here — Orbit has none by default.
 */
class OrbitBridge(private val activity: MainActivity) {
    @JavascriptInterface fun country(): String = Locale.getDefault().country.uppercase(Locale.ROOT)
    @JavascriptInterface fun lang(): String = Locale.getDefault().language
    @JavascriptInterface fun timezone(): String = TimeZone.getDefault().id
    @JavascriptInterface fun appVersion(): String = BuildConfig.VERSION_NAME
    @JavascriptInterface fun abi(): String = android.os.Build.SUPPORTED_ABIS.firstOrNull() ?: ""
    @JavascriptInterface fun device(): String = android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL

    @JavascriptInterface fun notificationsAllowed(): Boolean = CareNotifier.allowed(activity)
    @JavascriptInterface fun requestNotifications() = activity.requestNotifications()
    @JavascriptInterface fun scheduleAt(title: String, body: String, atMillis: Double) =
        CareNotifier.scheduleAt(activity, title, body, atMillis.toLong())
    @JavascriptInterface fun cancelScheduled() = CareNotifier.cancel(activity)
    @JavascriptInterface fun lastNotificationOpened(): Boolean = CareNotifier.consumeOpened(activity)
}
