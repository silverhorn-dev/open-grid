package org.opengrid.app

import android.content.Context
import android.net.Uri
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

// Bruecke zur PWA (documentation/ANDROID-APP.md, Phase 2; Gegenstueck: client/app/native.js).
// Nur der Router-Ursprung bekommt `window.OpenGridNative`; Nachrichten sind JSON-Texte:
// Anfrage { v, id, type, data }, Antwort { v, id, ok, result | error }, Ereignis { v, event, data }.
// Die Bruecke gibt es auch im Kern ohne Fenster (CoreHost): Fenster-Dinge (Bildschirmschutz, Teilen, Rechte-
// Dialoge) gehen an das aktuelle Fenster (`handler`, ggf. null), Benachrichtigungen und Hintergrund-
// Einstellungen erledigt die Bruecke selbst mit dem App-Kontext.
class Bridge(
    private val origin: String,
    context: Context
) : WebViewCompat.WebMessageListener {

    interface Handler {
        fun setSecureScreen(on: Boolean)
        fun takeShare(): JSONObject?
        // Android 13+: Recht fuer Benachrichtigungen erfragen; Ergebnis spaeter ueber `done`.
        fun requestNotificationPermission(done: (Boolean) -> Unit)
        // Systemdialog "Akku-Optimierung aus" fuer diese App (fuer "immer im Hintergrund").
        fun askBatteryExemption()
        // Mikrofon fuer Sprachnachrichten (VoiceRecorder); Ergebnis spaeter ueber `done`.
        fun requestMicrophonePermission(done: (Boolean) -> Unit)
    }

    companion object {
        const val PROTOCOL = 1
        const val OBJECT_NAME = "OpenGridNative"
        // Muss zu NATIVE_REQUEST_TYPES / NATIVE_EVENT_TYPES in client/app/native.js passen (test/android-app.test.js).
        val REQUEST_TYPES = listOf("capabilities", "secureScreen", "takeShare", "notify", "notifications", "background", "inbox", "coreStatus", "replyResult", "recordAudio")
        val EVENT_TYPES = listOf("shareReady", "openChat", "notificationReply")

        fun install(webView: WebView, bridge: Bridge): Boolean {
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return false
            WebViewCompat.addWebMessageListener(webView, OBJECT_NAME, setOf(bridge.origin), bridge)
            return true
        }
    }

    private val appContext = context.applicationContext
    var handler: Handler? = null
    private var replyProxy: JavaScriptReplyProxy? = null

    override fun onPostMessage(
        view: WebView,
        message: WebMessageCompat,
        sourceOrigin: Uri,
        isMainFrame: Boolean,
        replyProxy: JavaScriptReplyProxy
    ) {
        // Doppelt gesichert: addWebMessageListener filtert schon nach Ursprung; Frames bekommen nichts.
        if (!isMainFrame || !RouterAddress.sameOrigin(sourceOrigin.toString(), origin)) return
        this.replyProxy = replyProxy
        val request = try {
            JSONObject(message.data ?: return)
        } catch (_: Exception) {
            return
        }
        val id = request.optLong("id", -1)
        if (id < 0) return
        val data = request.optJSONObject("data")
        val reply = { ok: Boolean, result: Any? ->
            val response = JSONObject().put("v", PROTOCOL).put("id", id).put("ok", ok)
            if (ok) response.put("result", result ?: JSONObject.NULL) else response.put("error", result?.toString() ?: "failed")
            replyProxy.postMessage(response.toString())
        }
        try {
            when (request.optString("type")) {
                "capabilities" -> reply(true, capabilities())
                "secureScreen" -> {
                    val on = data?.optBoolean("on", false) ?: false
                    handler?.setSecureScreen(on)
                    reply(true, JSONObject().put("on", on))
                }
                "takeShare" -> reply(true, handler?.takeShare())
                "notify" -> reply(true, JSONObject().put("shown", Notifications.show(
                    appContext,
                    data?.optString("title").orEmpty().ifBlank { "OpenGrid" },
                    data?.optString("body").orEmpty(),
                    data?.optString("tag").orEmpty().ifBlank { "opengrid" },
                    data?.optString("peerId")?.takeIf { it.isNotBlank() && it != "null" },
                    data?.optBoolean("reply", false) ?: false
                )))
                "notifications" -> {
                    val current = Notifications.allowed(appContext)
                    val activity = handler
                    if (data?.optBoolean("request", false) == true && !current && activity != null) {
                        activity.requestNotificationPermission { granted -> reply(true, JSONObject().put("granted", granted)) }
                    } else {
                        reply(true, JSONObject().put("granted", current))
                    }
                }
                "background" -> {
                    // "Im Hintergrund erreichbar" (Posteingang + Kern auf Abruf).
                    if (data?.has("enabled") == true) {
                        val enabled = data.optBoolean("enabled", true)
                        BackgroundSettings.setEnabled(appContext, enabled)
                        if (enabled) InboxService.start(appContext) else InboxService.stop(appContext)
                    }
                    if (data?.optBoolean("askBattery", false) == true) handler?.askBatteryExemption()
                    reply(true, JSONObject()
                        .put("enabled", BackgroundSettings.enabled(appContext))
                        .put("batteryUnrestricted", BackgroundSettings.batteryUnrestricted(appContext)))
                }
                "inbox" -> {
                    // Zugangsdaten fuer den Posteingang (Node-ID + Router-Token), von Oberflaeche oder Kern.
                    val nodeId = data?.optString("nodeId").orEmpty()
                    val token = data?.optString("authToken").orEmpty()
                    if (nodeId.isBlank() || token.isBlank() || nodeId.length > 200 || token.length > 400) throw IllegalArgumentException("Invalid inbox credentials")
                    if (BackgroundSettings.setCredentials(appContext, nodeId, token)) InboxService.stop(appContext)
                    InboxService.start(appContext)
                    reply(true, JSONObject().put("enabled", BackgroundSettings.enabled(appContext)))
                }
                "coreStatus" -> {
                    val active = data?.optBoolean("active", false) ?: false
                    val ready = data?.optBoolean("ready", false) ?: false
                    android.os.Handler(android.os.Looper.getMainLooper()).post { CoreHost.report(active, ready) }
                    reply(true, null)
                }
                "replyResult" -> {
                    // Kern hat die Antwort aus der Benachrichtigung gesendet (oder nicht).
                    val replyId = data?.optString("replyId").orEmpty()
                    val ok = data?.optBoolean("ok", false) ?: false
                    android.os.Handler(android.os.Looper.getMainLooper()).post { CoreHost.replyResult(replyId, ok) }
                    reply(true, null)
                }
                "recordAudio" -> handleRecordAudio(data?.optString("action").orEmpty(), reply)
                else -> reply(false, "Unknown type")
            }
        } catch (error: Exception) {
            reply(false, error.message ?: "failed")
        }
    }

    // Sprachnachricht nativ aufnehmen (VoiceRecorder): start | split | stop | cancel. Nur das Fenster nimmt auf
    // (der Kern hat kein Fenster und fragt nie nach dem Mikrofon). Kodieren im Hintergrund, Antwort im Haupt-Thread.
    private val main = android.os.Handler(android.os.Looper.getMainLooper())

    private fun handleRecordAudio(action: String, reply: (Boolean, Any?) -> Unit) {
        val activity = handler
        when (action) {
            "start" -> {
                if (activity == null) return reply(false, "No window")
                val begin = {
                    try {
                        VoiceRecorder.start(appContext)
                        CrashLog.event(appContext, "voice: native recording started")
                        reply(true, JSONObject().put("mime", VoiceRecorder.mimeType))
                    } catch (error: Exception) {
                        CrashLog.event(appContext, "voice: native start failed (${error.javaClass.simpleName})")
                        reply(false, "start failed")
                    }
                }
                if (appContext.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == android.content.pm.PackageManager.PERMISSION_GRANTED) begin()
                else activity.requestMicrophonePermission { granted -> if (granted) begin() else reply(false, "denied") }
            }
            "split", "stop" -> {
                val finished = try {
                    VoiceRecorder.finish()
                } catch (_: Exception) {
                    null
                }
                if (action == "split") {
                    try {
                        VoiceRecorder.start(appContext)
                    } catch (_: Exception) {
                        return reply(false, "split failed")
                    }
                }
                Thread {
                    val result = JSONObject().put("data", finished?.first ?: JSONObject.NULL).put("durationMs", finished?.second ?: 0)
                    main.post { reply(true, result) }
                }.start()
            }
            "cancel" -> {
                VoiceRecorder.cancel()
                reply(true, null)
            }
            else -> reply(false, "Unknown action")
        }
    }

    private fun capabilities(): JSONObject = JSONObject()
        .put("protocol", PROTOCOL)
        .put("versionName", BuildConfig.VERSION_NAME)
        .put("versionCode", BuildConfig.VERSION_CODE)
        .put("secureScreen", true)
        .put("share", true)
        .put("notifications", true)
        .put("background", true)
        .put("core", true)
        // Sprachnachrichten nimmt die App selbst auf (WebView-Mikrofon beendet den Renderer, VoiceRecorder.kt).
        .put("audioRecorder", true)
        .put("rendererGone", CrashLog.last(appContext) ?: JSONObject.NULL)
        .put("nativeEvents", CrashLog.events(appContext))

    fun sendEvent(event: String, data: JSONObject? = null) {
        if (event !in EVENT_TYPES) return
        val message = JSONObject().put("v", PROTOCOL).put("event", event).put("data", data ?: JSONObject.NULL)
        replyProxy?.postMessage(message.toString())
    }
}
