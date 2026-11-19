package org.opengrid.app

import android.content.Context
import org.json.JSONObject

// Letzter Renderer-Ausfall (WebView): die PWA zeigt ihn im Debug-Log (Bruecke "capabilities"), damit sich
// Abstuerze ohne Logcat eingrenzen lassen.
object CrashLog {
    private const val PREFS = "opengrid"
    private const val KEY = "renderer-gone"

    fun rendererGone(context: Context, where: String, crashed: Boolean) {
        val entry = JSONObject().put("at", System.currentTimeMillis()).put("where", where).put("crashed", crashed)
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, entry.toString()).apply()
    }

    fun last(context: Context): JSONObject? =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null)?.let { runCatching { JSONObject(it) }.getOrNull() }
}
