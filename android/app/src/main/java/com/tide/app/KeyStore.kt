package com.tide.app

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKeys

/**
 * 潮汐 · API Key 加密存储
 * ============================================================
 * 设计：
 *   · Key 用 Android Keystore 派生的主密钥加密后存本地（EncryptedSharedPreferences）
 *   · Key **只进不出**：页面可以存、可以问"有没有"、可以拿到打码后的提示，
 *     但永远拿不到明文。发请求时由原生层自己取出来加到请求头。
 *     这样即使页面被注入脚本，也偷不走 Key。
 *   · 按「账号|服务商」分槽：同一台手机多个账号互不可见。
 *
 * 兜底：极少数机型的 Keystore 有 bug，加密初始化失败时退回应用私有存储
 *（其他 App 依然读不到，但没有加密）。这是可用性和安全性的取舍。
 */
class KeyStore(ctx: Context) {

    private val prefs: SharedPreferences = try {
        val alias = MasterKeys.getOrCreate(MasterKeys.AES256_GCM_SPEC)
        EncryptedSharedPreferences.create(
            "tide_api_keys",
            alias,
            ctx,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    } catch (_: Exception) {
        ctx.getSharedPreferences("tide_api_keys_fallback", Context.MODE_PRIVATE)
    }

    fun save(slot: String, key: String) {
        prefs.edit().putString(slot, key.trim()).apply()
    }

    fun get(slot: String): String? = prefs.getString(slot, null)?.takeIf { it.isNotBlank() }

    fun has(slot: String): Boolean = get(slot) != null

    fun clear(slot: String) {
        prefs.edit().remove(slot).apply()
    }

    /** 打码提示，如 sk-a****9f3c —— 让用户知道存的是哪个 Key，但看不到全貌 */
    fun hint(slot: String): String {
        val k = get(slot) ?: return ""
        return if (k.length <= 8) "****" else k.take(4) + "****" + k.takeLast(4)
    }
}
