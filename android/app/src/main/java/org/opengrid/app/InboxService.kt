package org.opengrid.app

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.webkit.CookieManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

// Posteingang (documentation/ANDROID-APP.md, K4 + R1): haelt dauerhaft nur eine schlanke WebSocket-Verbindung zum
// Router (REGISTER_INBOX) - ohne WebView, ohne JS. Der Router zaehlt sie nicht als online, sondern als
// "erreichbar"; kommt etwas (Verbindungswunsch, Zwischenspeicher, Tippen), schickt er WAKE und der Dienst startet
// den Kern (CoreHost). Inhalte sieht der Posteingang nie.
class InboxService : Service() {
    companion object {
        private const val ACTION_STOP = "org.opengrid.app.STOP_INBOX"

        fun start(context: Context) {
            if (!BackgroundSettings.enabled(context) || BackgroundSettings.credentials(context) == null || RouterAddress.load(context) == null) return
            val intent = Intent(context, InboxService::class.java)
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent) else context.startService(intent)
            } catch (_: Exception) {
                // Start aus dem Hintergrund verweigert: beim naechsten Oeffnen der App.
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, InboxService::class.java))
        }
    }

    private val handler = Handler(Looper.getMainLooper())
    private val client = OkHttpClient.Builder().pingInterval(25, TimeUnit.SECONDS).readTimeout(0, TimeUnit.MILLISECONDS).build()
    private var socket: WebSocket? = null
    private var backoffMs = 5_000L
    private var stopped = false
    private val reconnect = Runnable { connect() }
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            BackgroundSettings.setEnabled(this, false)
            stopSelf()
            return START_NOT_STICKY
        }
        Notifications.ensureChannels(this)
        val stopIntent = android.app.PendingIntent.getService(
            this, 1, Intent(this, InboxService::class.java).setAction(ACTION_STOP), android.app.PendingIntent.FLAG_IMMUTABLE
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
        stopped = false
        watchNetwork()
        if (socket == null) connect()
        return START_STICKY
    }

    private fun connect() {
        handler.removeCallbacks(reconnect)
        if (stopped) return
        val origin = RouterAddress.load(this)
        val credentials = BackgroundSettings.credentials(this)
        if (origin == null || credentials == null || !BackgroundSettings.enabled(this)) {
            stopSelf()
            return
        }
        socket?.cancel()
        val request = Request.Builder().url("${origin.replaceFirst("http", "ws")}/ws").apply {
            // Router hinter Cloudflare Access: Anmelde-Cookie der WebView mitschicken.
            CookieManager.getInstance().getCookie(origin)?.let { header("Cookie", it) }
        }.build()
        socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send(JSONObject().put("type", "REGISTER_INBOX").put("peerId", credentials.first).put("authToken", credentials.second).toString())
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val message = try { JSONObject(text) } catch (_: Exception) { return }
                when (message.optString("type")) {
                    "INBOX_REGISTERED" -> backoffMs = 5_000L
                    "WAKE" -> handler.post { CoreHost.wake(this@InboxService, origin) }
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = retry(webSocket, code == 1008)
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = retry(webSocket, false)
        })
    }

    private fun retry(webSocket: WebSocket, authFailed: Boolean) {
        if (socket != webSocket || stopped) return
        socket = null
        // Abgelehnt (Token falsch, Zugang abgelaufen): selten neu versuchen, die App liefert neue Daten beim Oeffnen.
        val delay = if (authFailed) 30 * 60_000L else backoffMs
        backoffMs = (backoffMs * 2).coerceAtMost(5 * 60_000L)
        handler.postDelayed(reconnect, delay)
    }

    private fun watchNetwork() {
        if (networkCallback != null) return
        val manager = getSystemService(ConnectivityManager::class.java) ?: return
        val callback = object : ConnectivityManager.NetworkCallback() {
            // Netz wieder da (oder gewechselt): sofort neu verbinden statt auf den Backoff zu warten.
            override fun onAvailable(network: Network) {
                handler.post {
                    backoffMs = 5_000L
                    if (socket == null) connect()
                }
            }
        }
        try {
            manager.registerDefaultNetworkCallback(callback)
            networkCallback = callback
        } catch (_: Exception) {
        }
    }

    override fun onDestroy() {
        stopped = true
        handler.removeCallbacks(reconnect)
        socket?.close(1000, "stopped")
        socket = null
        networkCallback?.let { getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(it) }
        networkCallback = null
        // Ohne Posteingang (abgeschaltet): auch der Kern geht, sobald die Oberflaeche zu ist.
        super.onDestroy()
    }
}
