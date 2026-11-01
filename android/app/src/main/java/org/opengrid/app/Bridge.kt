package org.opengrid.app

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
class Bridge(
    private val origin: String,
    private val handler: Handler
) : WebViewCompat.WebMessageListener {

    interface Handler {
        fun setSecureScreen(on: Boolean)
        fun capabilities(): JSONObject
        fun takeShare(): JSONObject?
    }

    companion object {
        const val PROTOCOL = 1
        const val OBJECT_NAME = "OpenGridNative"
        // Muss zu NATIVE_REQUEST_TYPES / NATIVE_EVENT_TYPES in client/app/native.js passen (test/native.test.js).
        val REQUEST_TYPES = listOf("capabilities", "secureScreen", "takeShare")
        val EVENT_TYPES = listOf("shareReady")

        fun install(webView: WebView, bridge: Bridge): Boolean {
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return false
            WebViewCompat.addWebMessageListener(webView, OBJECT_NAME, setOf(bridge.origin), bridge)
            return true
        }
    }

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
        val response = JSONObject().put("v", PROTOCOL).put("id", id)
        try {
            val result: Any? = when (request.optString("type")) {
                "capabilities" -> handler.capabilities()
                "secureScreen" -> {
                    val on = request.optJSONObject("data")?.optBoolean("on", false) ?: false
                    handler.setSecureScreen(on)
                    JSONObject().put("on", on)
                }
                "takeShare" -> handler.takeShare()
                else -> throw IllegalArgumentException("Unknown type")
            }
            response.put("ok", true).put("result", result ?: JSONObject.NULL)
        } catch (error: Exception) {
            response.put("ok", false).put("error", error.message ?: "failed")
        }
        replyProxy.postMessage(response.toString())
    }

    fun sendEvent(event: String, data: JSONObject? = null) {
        if (event !in EVENT_TYPES) return
        val message = JSONObject().put("v", PROTOCOL).put("event", event).put("data", data ?: JSONObject.NULL)
        replyProxy?.postMessage(message.toString())
    }
}
