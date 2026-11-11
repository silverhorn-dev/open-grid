package org.opengrid.app

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

// Benachrichtigungen (documentation/ANDROID-APP.md, "Hintergrund und Benachrichtigungen"): die WebView kennt
// weder Web Push noch die Notification-API, darum zeigt die App sie nativ an. Inhalt (Titel/Text) kommt von der
// PWA ueber die Bruecke; bei "Kompakte Meldung" schickt die PWA nur "Neue Nachrichten".
object Notifications {
    const val CHANNEL_MESSAGES = "messages"
    const val CHANNEL_BACKGROUND = "background"
    const val EXTRA_OPEN_CHAT = "org.opengrid.app.OPEN_CHAT"
    const val KEEP_ALIVE_ID = 1

    fun ensureChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_MESSAGES, context.getString(R.string.channel_messages), NotificationManager.IMPORTANCE_HIGH)
        )
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_BACKGROUND, context.getString(R.string.channel_background), NotificationManager.IMPORTANCE_MIN).apply {
                setShowBadge(false)
            }
        )
    }

    fun allowed(context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= 33 &&
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return false
        return NotificationManagerCompat.from(context).areNotificationsEnabled()
    }

    // Tippen oeffnet die App (und, wenn angegeben, den Chat).
    fun openAppIntent(context: Context, peerId: String?, requestCode: Int): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        if (!peerId.isNullOrBlank()) intent.putExtra(EXTRA_OPEN_CHAT, peerId)
        return PendingIntent.getActivity(context, requestCode, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    fun show(context: Context, title: String, body: String, tag: String, peerId: String?): Boolean {
        if (!allowed(context)) return false
        ensureChannels(context)
        val notification = NotificationCompat.Builder(context, CHANNEL_MESSAGES)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title.take(120))
            .setContentText(body.take(300))
            .setStyle(NotificationCompat.BigTextStyle().bigText(body.take(300)))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(openAppIntent(context, peerId, tag.hashCode()))
            .build()
        try {
            NotificationManagerCompat.from(context).notify(tag.take(100), 0, notification)
        } catch (_: SecurityException) {
            return false
        }
        return true
    }

    fun clear(context: Context) {
        NotificationManagerCompat.from(context).cancelAll()
    }
}
