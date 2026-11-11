package org.opengrid.app

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

// Haelt die App nach dem Schliessen eine einstellbare Zeit am Leben (Vordergrund-Dienst mit stiller Meldung):
// die PWA in der WebView bleibt verbunden, liefert Profilbilder und Originale per P2P aus, gleicht Chats ab
// und meldet neue Nachrichten (Notifications). Dauer in den Einstellungen der PWA (Bruecke "background").
class KeepAliveService : Service() {
    companion object {
        const val ACTION_KEEP = "org.opengrid.app.KEEP_ALIVE"
        const val ACTION_STOP = "org.opengrid.app.STOP_KEEP_ALIVE"
        private const val EXTRA_MINUTES = "minutes"
        var running = false
            private set
        // Sofort gesetzt (der Dienst startet asynchron): das Fenster darf die WebView dann behalten.
        var requested = false
            private set

        fun start(context: Context, minutes: Int) {
            if (minutes == 0) return
            requested = true
            val intent = Intent(context, KeepAliveService::class.java).setAction(ACTION_KEEP).putExtra(EXTRA_MINUTES, minutes)
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent) else context.startService(intent)
            } catch (_: Exception) {
                // Start aus dem Hintergrund verweigert (Android 12+): dann eben ohne.
                requested = false
            }
        }

        fun stop(context: Context) {
            requested = false
            if (!running) return
            context.stopService(Intent(context, KeepAliveService::class.java))
        }
    }

    private val handler = Handler(Looper.getMainLooper())
    private val finish = Runnable { stopSelf() }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        Notifications.ensureChannels(this)
        val stopIntent = android.app.PendingIntent.getService(
            this, 1, Intent(this, KeepAliveService::class.java).setAction(ACTION_STOP),
            android.app.PendingIntent.FLAG_IMMUTABLE
        )
        val notification = NotificationCompat.Builder(this, Notifications.CHANNEL_BACKGROUND)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(R.string.background_title))
            .setContentText(getString(R.string.background_text))
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setContentIntent(Notifications.openAppIntent(this, null, 2))
            .addAction(0, getString(R.string.background_stop), stopIntent)
            .build()
        val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
        ServiceCompat.startForeground(this, Notifications.KEEP_ALIVE_ID, notification, type)
        running = true
        handler.removeCallbacks(finish)
        val minutes = intent?.getIntExtra(EXTRA_MINUTES, 60) ?: 60
        // -1 = immer (bis "Beenden" oder bis das System den Dienst beendet).
        if (minutes > 0) handler.postDelayed(finish, minutes * 60_000L)
        return if (minutes < 0) START_STICKY else START_NOT_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacks(finish)
        running = false
        requested = false
        // Ohne sichtbares Fenster wird die WebView jetzt freigegeben (die App ist dann wirklich zu).
        WebViewHolder.releaseIfDetached()
        super.onDestroy()
    }
}
