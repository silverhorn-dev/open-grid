package org.opengrid.app

import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.webkit.WebView
import android.webkit.WebViewClient

// Kern auf Abruf (documentation/ANDROID-APP.md, K4): eine unsichtbare WebView mit /core.html (dieselbe PWA in der
// Rolle "core": Router-Verbindung, P2P, Abgleich, Benachrichtigungen). Sie laeuft, solange die Oberflaeche offen ist
// oder etwas passiert (Weck-Signal, Verkehr), und wird nach IDLE_MS Ruhe zerstoert - es laeuft also nicht dauernd
// ein Browser im Hintergrund. Nur auf dem Haupt-Thread benutzen.
@SuppressLint("StaticFieldLeak")
object CoreHost {
    private const val IDLE_MS = 3 * 60_000L
    private const val CHECK_MS = 30_000L
    private val handler = Handler(Looper.getMainLooper())
    private var webView: WebView? = null
    private var bridge: Bridge? = null
    private var origin: String? = null
    private var uiAttached = false
    private var lastActive = 0L
    private var ready = false
    private val check = Runnable { stopIfIdle() }

    fun isRunning() = webView != null

    @SuppressLint("SetJavaScriptEnabled")
    fun wake(context: Context, routerOrigin: String) {
        lastActive = SystemClock.elapsedRealtime()
        if (webView != null && origin == routerOrigin) {
            schedule()
            return
        }
        stop()
        val app = context.applicationContext
        val view = WebView(app)
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
            userAgentString = "$userAgentString OpenGridApp/${BuildConfig.VERSION_NAME} OpenGridCore/1"
        }
        // Nur der Router; nichts oeffnet sich aus dem Kern heraus.
        view.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: android.webkit.WebResourceRequest) =
                !RouterAddress.sameOrigin(request.url.toString(), routerOrigin)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) view.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
        val coreBridge = Bridge(routerOrigin, app)
        Bridge.install(view, coreBridge)
        webView = view
        bridge = coreBridge
        origin = routerOrigin
        ready = false
        view.loadUrl("$routerOrigin/core.html")
        schedule()
    }

    // Vom Kern ueber die Bruecke (alle 20 s): Verkehr in letzter Zeit? Profil + Verbindung bereit?
    fun report(active: Boolean, isReady: Boolean) {
        if (active) lastActive = SystemClock.elapsedRealtime()
        ready = isReady
    }

    fun setUiAttached(context: Context, attached: Boolean, routerOrigin: String?) {
        uiAttached = attached
        if (attached && routerOrigin != null && BackgroundSettings.enabled(context)) wake(context, routerOrigin)
        // Oberflaeche zu und der Kern war ohne Profil (gerade erst eingerichtet): neu laden, dann verbindet er sich.
        if (!attached && webView != null && !ready && routerOrigin != null) {
            stop()
            wake(context, routerOrigin)
        }
        if (!attached) lastActive = SystemClock.elapsedRealtime()
        schedule()
    }

    private fun schedule() {
        handler.removeCallbacks(check)
        if (webView != null) handler.postDelayed(check, CHECK_MS)
    }

    private fun stopIfIdle() {
        if (!uiAttached && SystemClock.elapsedRealtime() - lastActive > IDLE_MS) stop() else schedule()
    }

    fun stop() {
        handler.removeCallbacks(check)
        webView?.let {
            it.stopLoading()
            it.destroy()
        }
        webView = null
        bridge = null
        ready = false
    }
}
