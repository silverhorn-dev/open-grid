package org.opengrid.app

import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.RemoteInput
import androidx.core.app.ServiceCompat

// Antwort aus der Benachrichtigung (Board T38): die Aktion "Antworten" startet diesen kurzen Vordergrund-Dienst
// (Start aus einer Benachrichtigung ist erlaubt). Er weckt den Kern (CoreHost), der sendet die Nachricht wie eine
// normale (Ende-zu-Ende verschluesselt, P2P oder Zwischenspeicher) und meldet das Ergebnis; danach verschwindet die
// Benachrichtigung bzw. zeigt "nicht gesendet". Der Text bleibt nur im Speicher.
class ReplyService : Service() {
    companion object {
        const val EXTRA_PEER = "org.opengrid.app.REPLY_PEER"
        const val EXTRA_TAG = "org.opengrid.app.REPLY_TAG"
        const val KEY_TEXT = "reply_text"
        private const val NOTIFICATION_ID = 3
        private const val TIMEOUT_MS = 60_000L
    }

    private val handler = Handler(Looper.getMainLooper())
    private var open = 0

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Notifications.ensureChannels(this)
        val working = NotificationCompat.Builder(this, Notifications.CHANNEL_BACKGROUND)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(R.string.reply_sending))
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .build()
        val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
        ServiceCompat.startForeground(this, NOTIFICATION_ID, working, type)

        val peerId = intent?.getStringExtra(EXTRA_PEER).orEmpty()
        val tag = intent?.getStringExtra(EXTRA_TAG).orEmpty()
        val text = intent?.let { RemoteInput.getResultsFromIntent(it)?.getCharSequence(KEY_TEXT)?.toString() }.orEmpty().trim()
        val origin = RouterAddress.load(this)
        if (peerId.isBlank() || text.isBlank() || origin == null) {
            if (tag.isNotBlank()) Notifications.showReplyFailed(this, tag, peerId)
            finishOne()
            return START_NOT_STICKY
        }
        CrashLog.event(this, "notification reply: queued")
        open++
        var done = false
        val finish = { ok: Boolean ->
            if (!done) {
                done = true
                CrashLog.event(this, "notification reply: ${if (ok) "sent" else "failed"}")
                if (ok) Notifications.cancel(this, tag) else Notifications.showReplyFailed(this, tag, peerId)
                open--
                finishOne()
            }
        }
        CoreHost.queueReply(this, origin, peerId, text.take(2000)) { ok -> handler.post { finish(ok) } }
        handler.postDelayed({ finish(false) }, TIMEOUT_MS)
        return START_NOT_STICKY
    }

    private fun finishOne() {
        if (open <= 0) {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }
}
