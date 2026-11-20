package org.opengrid.app

import android.app.ActivityManager
import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

// Fehlersuche ohne Logcat: letzter Renderer-Ausfall (WebView) mit Prioritaet beim Ende und Speicherstand des Geraets,
// dazu die letzten Ereignisse der App (Lebenszyklus, Rechte-Dialoge, Antworten aus Benachrichtigungen). Die PWA zeigt
// beides im Debug-Log (Bruecke "capabilities"). Keine Inhalte.
object CrashLog {
    private const val PREFS = "opengrid"
    private const val KEY = "renderer-gone"
    private const val EVENTS = "native-events"
    private const val EVENT_LIMIT = 30

    fun rendererGone(context: Context, where: String, crashed: Boolean, priorityAtExit: Int = -1) {
        val memory = ActivityManager.MemoryInfo()
        runCatching { context.getSystemService(ActivityManager::class.java)?.getMemoryInfo(memory) }
        val entry = JSONObject().put("at", System.currentTimeMillis()).put("where", where).put("crashed", crashed)
            .put("priority", priorityAtExit)
            .put("availMb", memory.availMem / 1_000_000).put("totalMb", memory.totalMem / 1_000_000).put("lowMemory", memory.lowMemory)
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, entry.toString()).apply()
        event(context, "renderer gone ($where, ${if (crashed) "crash" else "killed"}, priority $priorityAtExit, free ${memory.availMem / 1_000_000} MB)")
    }

    fun last(context: Context): JSONObject? =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null)?.let { runCatching { JSONObject(it) }.getOrNull() }

    @Synchronized
    fun event(context: Context, text: String) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val list = runCatching { JSONArray(prefs.getString(EVENTS, "[]")) }.getOrDefault(JSONArray())
        list.put(JSONObject().put("at", System.currentTimeMillis()).put("text", text.take(200)))
        val trimmed = JSONArray()
        for (index in maxOf(0, list.length() - EVENT_LIMIT) until list.length()) trimmed.put(list.get(index))
        prefs.edit().putString(EVENTS, trimmed.toString()).apply()
    }

    fun events(context: Context): JSONArray =
        runCatching { JSONArray(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(EVENTS, "[]")) }.getOrDefault(JSONArray())
}
