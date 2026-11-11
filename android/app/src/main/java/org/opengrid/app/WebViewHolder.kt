package org.opengrid.app

import android.content.Context
import android.content.MutableContextWrapper
import android.view.ViewGroup
import android.webkit.WebView

// Eine WebView fuer die ganze App: sie ueberlebt das Schliessen des Fensters, solange der Hintergrund-Dienst
// laeuft (KeepAliveService), und wird beim naechsten Oeffnen ohne Neuladen wieder angezeigt.
object WebViewHolder {
    private var webView: WebView? = null
    private var context: MutableContextWrapper? = null
    private var origin: String? = null
    var bridge: Bridge? = null
        private set
    private var attached = false

    fun current(): WebView? = webView

    // Vorhandene WebView fuer diesen Router (dann ohne Neuladen) oder null.
    fun reuse(activity: Context, routerOrigin: String): WebView? {
        val view = webView ?: return null
        if (origin != routerOrigin) {
            destroy()
            return null
        }
        context?.baseContext = activity
        (view.parent as? ViewGroup)?.removeView(view)
        attached = true
        return view
    }

    fun create(activity: Context, routerOrigin: String, bridge: Bridge): WebView {
        destroy()
        val wrapper = MutableContextWrapper(activity)
        val view = WebView(wrapper)
        context = wrapper
        webView = view
        origin = routerOrigin
        this.bridge = bridge
        attached = true
        return view
    }

    // Fenster geht zu: mit laufendem Dienst behalten (an den App-Kontext haengen), sonst freigeben.
    fun detach(activity: Context, keep: Boolean) {
        val view = webView ?: return
        attached = false
        (view.parent as? ViewGroup)?.removeView(view)
        if (keep) context?.baseContext = activity.applicationContext else destroy()
    }

    fun releaseIfDetached() {
        if (!attached) destroy()
    }

    fun destroy() {
        webView?.let {
            (it.parent as? ViewGroup)?.removeView(it)
            it.destroy()
        }
        webView = null
        context = null
        origin = null
        bridge = null
        attached = false
    }
}
