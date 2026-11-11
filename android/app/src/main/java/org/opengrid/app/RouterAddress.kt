package org.opengrid.app

import android.content.Context
import android.net.Uri

// Die App laedt genau einen Ursprung (Schema + Host + Port): den eigenen Router.
object RouterAddress {
    private const val PREFS = "router"
    private const val KEY_ORIGIN = "origin"

    // Eingabe -> "https://host[:port]" oder null. Ohne Schema gilt https; http nur im Debug-Build fuer
    // den Emulator-Host (Service Worker und WebRTC brauchen sonst einen sicheren Kontext).
    fun normalize(input: String?, allowCleartextDebug: Boolean = BuildConfig.DEBUG): String? {
        val text = input?.trim().orEmpty()
        if (text.isEmpty() || text.length > 300) return null
        val uri = Uri.parse(if (text.contains("://")) text else "https://$text")
        val scheme = uri.scheme?.lowercase() ?: return null
        val host = uri.host?.lowercase()?.takeIf { it.isNotEmpty() } ?: return null
        if (uri.userInfo != null) return null
        val cleartextOk = allowCleartextDebug && (host == "10.0.2.2" || host == "localhost")
        if (scheme != "https" && !(scheme == "http" && cleartextOk)) return null
        val port = if (uri.port == -1 || (scheme == "https" && uri.port == 443)) "" else ":${uri.port}"
        return "$scheme://$host$port"
    }

    // opengrid://connect?url=<router> (Einrichtung) und opengrid://open?url=<seite des routers>.
    fun fromDeepLink(uri: Uri?): String? {
        if (uri?.scheme != "opengrid") return null
        if (uri.host != "connect" && uri.host != "open") return null
        return uri.getQueryParameter("url")
    }

    // Anmeldeseite von Cloudflare Access (Router hinter einem Cloudflare-Tunnel mit Zugriffsregeln):
    // bleibt in der WebView, damit das Anmelde-Cookie dort landet und der Rueckweg zum Router klappt.
    // Die Bruecke und Rechte gelten weiter nur fuer den Router-Ursprung.
    fun isAccessLogin(url: String?): Boolean {
        if (url == null) return false
        val uri = Uri.parse(url)
        val host = uri.host?.lowercase() ?: return false
        return uri.scheme?.lowercase() == "https" && host.endsWith(".cloudflareaccess.com")
    }

    fun sameOrigin(url: String?, origin: String): Boolean {
        if (url == null) return false
        val uri = Uri.parse(url)
        val scheme = uri.scheme?.lowercase() ?: return false
        val host = uri.host?.lowercase() ?: return false
        val port = if (uri.port == -1 || (scheme == "https" && uri.port == 443) || (scheme == "http" && uri.port == 80)) "" else ":${uri.port}"
        return "$scheme://$host$port" == origin
    }

    fun load(context: Context): String? =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_ORIGIN, null)

    fun save(context: Context, origin: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_ORIGIN, origin).apply()
    }
}
