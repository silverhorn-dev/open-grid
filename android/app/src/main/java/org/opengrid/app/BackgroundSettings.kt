package org.opengrid.app

import android.content.Context
import android.os.PowerManager

// "Im Hintergrund erreichbar" (Standard an) und die Zugangsdaten des Posteingangs (Node-ID + Router-Token, von der
// PWA ueber die Bruecke; bleiben im privaten App-Speicher).
object BackgroundSettings {
    private const val PREFS = "opengrid"
    private const val KEY_ENABLED = "reachable"
    private const val KEY_NODE = "inbox-node"
    private const val KEY_TOKEN = "inbox-token"

    fun enabled(context: Context): Boolean =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_ENABLED, true)

    fun setEnabled(context: Context, enabled: Boolean) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_ENABLED, enabled).apply()
    }

    fun credentials(context: Context): Pair<String, String>? {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val node = prefs.getString(KEY_NODE, null) ?: return null
        val token = prefs.getString(KEY_TOKEN, null) ?: return null
        return node to token
    }

    // true = neu oder geaendert.
    fun setCredentials(context: Context, nodeId: String, token: String): Boolean {
        if (credentials(context) == (nodeId to token)) return false
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_NODE, nodeId).putString(KEY_TOKEN, token).apply()
        return true
    }

    // Akku-Optimierung aus? Sonst kann Android die App im Ruhezustand (Doze) vom Netz trennen.
    fun batteryUnrestricted(context: Context): Boolean =
        context.getSystemService(PowerManager::class.java)?.isIgnoringBatteryOptimizations(context.packageName) == true
}
