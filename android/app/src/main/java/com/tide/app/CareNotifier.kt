package com.tide.app

import android.Manifest
import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import java.util.Calendar

/**
 * 潮汐 v5 · 晚间关怀提醒
 * ============================================================
 * 规则（对应 docs/09 ADR-12，和 server /v1/nudge 一起看）：
 *   · 只给 A/B 实验的 nudge 组发；control 组服务端返回空，这里根本不会被调用
 *   · 一天最多一条：新排的一条会覆盖旧的（同一个 requestCode）
 *   · 内容只能是"用户说过的、有日期的具体事情"，由服务端生成
 *   · 用非精确闹钟（setAndAllowWhileIdle），不申请 SCHEDULE_EXACT_ALARM：
 *     晚几分钟送达没关系，多申请一个权限不值得
 *   · Android 13+ 没有通知权限就静默不发，不反复弹权限框
 */
object CareNotifier {
    private const val CHANNEL = "tide_care"
    private const val REQ = 4201
    private const val PREFS = "tide_care"

    fun allowed(ctx: Context): Boolean {
        if (Build.VERSION.SDK_INT >= 33 &&
            ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return false
        return NotificationManagerCompat.from(ctx).areNotificationsEnabled()
    }

    fun schedule(ctx: Context, title: String, body: String, hourLocal: Int) {
        val intent = Intent(ctx, CareReceiver::class.java)
            .putExtra("title", title.take(40)).putExtra("body", body.take(200))
        val pi = PendingIntent.getBroadcast(ctx, REQ, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val cal = Calendar.getInstance().apply {
            set(Calendar.HOUR_OF_DAY, hourLocal); set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0)
            if (timeInMillis <= System.currentTimeMillis()) add(Calendar.DAY_OF_YEAR, 1)
        }
        val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, cal.timeInMillis, pi)
    }

    /** Orbit: schedule one proactive message at an absolute time (the page already applied
     *  timezone, quiet hours and frequency caps). Same request code → replaces the previous one,
     *  so there is never more than one pending proactive notification. */
    fun scheduleAt(ctx: Context, title: String, body: String, atMillis: Long) {
        val intent = Intent(ctx, CareReceiver::class.java)
            .putExtra("title", title.take(40)).putExtra("body", body.take(200))
        val pi = PendingIntent.getBroadcast(ctx, REQ, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMillis.coerceAtLeast(System.currentTimeMillis() + 1000), pi)
    }

    fun cancel(ctx: Context) {
        val pi = PendingIntent.getBroadcast(ctx, REQ, Intent(ctx, CareReceiver::class.java),
            PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE) ?: return
        (ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager).cancel(pi)
    }

    /** 用户是否点开了上一条提醒（页面读一次就清掉，用来上报 nudge_opened） */
    fun consumeOpened(ctx: Context): Boolean {
        val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val v = p.getBoolean("opened", false)
        if (v) p.edit().putBoolean("opened", false).apply()
        return v
    }

    internal fun markOpened(ctx: Context) =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean("opened", true).apply()

    internal fun show(ctx: Context, title: String, body: String) {
        if (!allowed(ctx)) return
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Evening check-in", NotificationManager.IMPORTANCE_DEFAULT))
        }
        val open = Intent(ctx, MainActivity::class.java).putExtra("from_nudge", true)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val pi = PendingIntent.getActivity(ctx, REQ + 1, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val n = NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title).setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(pi).setAutoCancel(true).build()
        try { NotificationManagerCompat.from(ctx).notify(REQ, n) } catch (_: SecurityException) {}
    }
}

class CareReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        CareNotifier.show(ctx, intent.getStringExtra("title") ?: "Tide", intent.getStringExtra("body") ?: "")
    }
}
