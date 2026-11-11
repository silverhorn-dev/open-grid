package org.opengrid.app

import android.content.Context
import android.os.PowerManager

// Wie lange die App nach dem Schliessen aktiv bleibt (Minuten; 0 = gar nicht, -1 = immer).
object BackgroundSettings {
    const val DEFAULT_MINUTES = 60
    private val ALLOWED = setOf(0, 15, 60, 240, 480, -1)
    private const val PREFS = "opengrid"
    private const val KEY = "background-minutes"

    fun minutes(context: Context): Int =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getInt(KEY, DEFAULT_MINUTES).takeIf { it in ALLOWED } ?: DEFAULT_MINUTES

    fun setMinutes(context: Context, minutes: Int) {
        if (minutes !in ALLOWED) throw IllegalArgumentException("Unsupported duration")
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putInt(KEY, minutes).apply()
    }

    // Akku-Optimierung aus? Sonst kann Android die App im Doze trotz Dienst vom Netz trennen.
    fun batteryUnrestricted(context: Context): Boolean =
        context.getSystemService(PowerManager::class.java)?.isIgnoringBatteryOptimizations(context.packageName) == true
}
