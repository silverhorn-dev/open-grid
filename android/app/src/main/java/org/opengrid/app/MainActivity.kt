package org.opengrid.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

// Huelle (documentation/ANDROID-APP.md, Phase 1): zeigt die PWA des eigenen Routers in einer WebView.
// Nur der Router-Ursprung wird hier geladen und bekommt Rechte und die Bruecke; alles andere oeffnet
// im Browser.
class MainActivity : ComponentActivity(), Bridge.Handler {
    private var origin: String? = null
    private var webView: WebView? = null
    private var bridge: Bridge? = null
    private lateinit var shareInbox: ShareInbox
    private var updateChecked = false

    private var pendingPermission: PermissionRequest? = null
    private var pendingGeolocation: Pair<String, GeolocationPermissions.Callback>? = null
    private var fileCallback: ValueCallback<Array<Uri>>? = null

    private val mediaPermissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
        val request = pendingPermission ?: return@registerForActivityResult
        pendingPermission = null
        val allowed = request.resources.filter { resource ->
            androidPermissionsFor(resource).all { granted[it] == true || hasPermission(it) }
        }
        if (allowed.isEmpty()) request.deny() else request.grant(allowed.toTypedArray())
    }

    private val locationPermission = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
        val (requestOrigin, callback) = pendingGeolocation ?: return@registerForActivityResult
        pendingGeolocation = null
        callback.invoke(requestOrigin, granted.values.any { it }, false)
    }

    private val fileChooser = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val callback = fileCallback ?: return@registerForActivityResult
        fileCallback = null
        callback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        shareInbox = ShareInbox(contentResolver)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // Modals der PWA haengen an der History (client/app/router.js): Zurueck schliesst sie.
                val view = webView
                if (view != null && view.canGoBack()) view.goBack() else finish()
            }
        })
        val saved = RouterAddress.load(this)
        if (saved == null) {
            showSetup(RouterAddress.fromDeepLink(intent.data))
            return
        }
        startWebApp(saved, savedInstanceState)
        handleIntent(intent, fresh = savedInstanceState == null)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent, fresh = false)
    }

    private fun handleIntent(intent: Intent, fresh: Boolean) {
        val current = origin ?: return
        if (shareInbox.accept(intent)) {
            // Laeuft die Seite schon, holt sie den Inhalt sofort ab; sonst beim Start (handleNativeShare).
            if (!fresh) bridge?.sendEvent("shareReady")
            return
        }
        val linked = RouterAddress.fromDeepLink(intent.data)
        val target = intent.data?.takeIf { it.scheme == "https" }?.toString() ?: linked ?: return
        if (RouterAddress.sameOrigin(target, current)) {
            webView?.loadUrl(target)
            return
        }
        val other = RouterAddress.normalize(target) ?: return
        if (intent.data?.host == "connect") confirmRouterSwitch(other)
    }

    // ----- Einrichtung -----

    private fun showSetup(prefill: String?) {
        val padding = (24 * resources.displayMetrics.density).toInt()
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(padding, padding, padding, padding)
        }
        val title = TextView(this).apply {
            setText(R.string.setup_title)
            textSize = 22f
        }
        val help = TextView(this).apply {
            setText(R.string.setup_help)
            setPadding(0, padding / 2, 0, padding / 2)
        }
        val input = EditText(this).apply {
            setHint(R.string.setup_hint)
            setSingleLine()
            inputType = EditorInfo.TYPE_CLASS_TEXT or EditorInfo.TYPE_TEXT_VARIATION_URI
            imeOptions = EditorInfo.IME_ACTION_GO
            setText(prefill.orEmpty())
        }
        val error = TextView(this).apply { setTextColor(getColor(R.color.accent)) }
        val connect = Button(this).apply { setText(R.string.setup_connect) }
        val submit = {
            val normalized = RouterAddress.normalize(input.text.toString())
            if (normalized == null) {
                error.setText(R.string.setup_invalid)
            } else {
                RouterAddress.save(this, normalized)
                startWebApp(normalized, null)
            }
        }
        connect.setOnClickListener { submit() }
        input.setOnEditorActionListener { _, _, _ -> submit(); true }
        listOf(title, help, input, error, connect).forEach {
            layout.addView(it, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        setContentView(layout)
    }

    private fun confirmRouterSwitch(next: String) {
        if (next == origin) return
        AlertDialog.Builder(this)
            .setTitle(R.string.setup_confirm_title)
            .setMessage("$next\n\n${getString(R.string.setup_confirm_switch)}")
            .setPositiveButton(R.string.action_switch_router) { _, _ ->
                RouterAddress.save(this, next)
                recreate()
            }
            .setNegativeButton(R.string.action_cancel, null)
            .show()
    }

    // ----- WebView -----

    @SuppressLint("SetJavaScriptEnabled")
    private fun startWebApp(routerOrigin: String, savedInstanceState: Bundle?) {
        origin = routerOrigin
        val view = WebView(this)
        webView = view
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(false)
            setGeolocationEnabled(true)
            // Kennung fuer die PWA (zusaetzlich zur Bruecke), z. B. fuer Statistik im Debug-Log.
            userAgentString = "$userAgentString OpenGridApp/${BuildConfig.VERSION_NAME}"
        }
        val appBridge = Bridge(routerOrigin, this)
        bridge = appBridge
        Bridge.install(view, appBridge)
        view.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (RouterAddress.sameOrigin(url.toString(), routerOrigin)) return false
                if (RouterAddress.isAccessLogin(url.toString())) return false
                openExternal(url)
                return true
            }

            // Erst wenn der Router selbst geladen ist (nach einer Anmeldung bei Cloudflare Access), nach Updates fragen.
            override fun onPageFinished(view: WebView, url: String?) {
                if (RouterAddress.sameOrigin(url, routerOrigin)) checkForUpdate(routerOrigin)
            }
        }
        view.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread { handlePermissionRequest(request, routerOrigin) }
            }

            override fun onGeolocationPermissionsShowPrompt(requestOrigin: String, callback: GeolocationPermissions.Callback) {
                if (!RouterAddress.sameOrigin(requestOrigin, routerOrigin)) {
                    callback.invoke(requestOrigin, false, false)
                    return
                }
                val permissions = arrayOf(Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION)
                if (permissions.any { hasPermission(it) }) {
                    callback.invoke(requestOrigin, true, false)
                    return
                }
                pendingGeolocation = requestOrigin to callback
                locationPermission.launch(permissions)
            }

            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                return try {
                    fileChooser.launch(params.createIntent())
                    true
                } catch (_: ActivityNotFoundException) {
                    fileCallback = null
                    false
                }
            }
        }
        setContentView(view)
        if (savedInstanceState == null || view.restoreState(savedInstanceState) == null) view.loadUrl(routerOrigin)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView?.saveState(outState)
    }

    override fun onDestroy() {
        webView?.destroy()
        webView = null
        super.onDestroy()
    }

    private fun openExternal(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (_: ActivityNotFoundException) {
            // Kein Browser: Link bleibt ungeoeffnet.
        }
    }

    // ----- Rechte (nur fuer den Router) -----

    private fun androidPermissionsFor(resource: String): List<String> = when (resource) {
        PermissionRequest.RESOURCE_VIDEO_CAPTURE -> listOf(Manifest.permission.CAMERA)
        PermissionRequest.RESOURCE_AUDIO_CAPTURE -> listOf(Manifest.permission.RECORD_AUDIO)
        else -> emptyList()
    }

    private fun hasPermission(permission: String) = checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    private fun handlePermissionRequest(request: PermissionRequest, routerOrigin: String) {
        val supported = setOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE, PermissionRequest.RESOURCE_AUDIO_CAPTURE)
        if (!RouterAddress.sameOrigin(request.origin.toString(), routerOrigin) || request.resources.none { it in supported }) {
            request.deny()
            return
        }
        val resources = request.resources.filter { it in supported }
        val missing = resources.flatMap { androidPermissionsFor(it) }.filterNot { hasPermission(it) }
        if (missing.isEmpty()) {
            request.grant(resources.toTypedArray())
            return
        }
        pendingPermission?.deny()
        pendingPermission = request
        mediaPermissions.launch(missing.toTypedArray())
    }

    // ----- Bridge.Handler -----

    override fun setSecureScreen(on: Boolean) {
        // Snaps, Alben, Bilder, Profile aus dem Grid und Flirt-Chats: keine Bildschirmfotos/-aufnahmen.
        if (on) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
    }

    override fun capabilities(): JSONObject = JSONObject()
        .put("protocol", Bridge.PROTOCOL)
        .put("versionName", BuildConfig.VERSION_NAME)
        .put("versionCode", BuildConfig.VERSION_CODE)
        .put("secureScreen", true)
        .put("share", true)

    override fun takeShare(): JSONObject? = shareInbox.take()

    // ----- Update vom Router (/api/config -> android.versionCode) -----

    private fun checkForUpdate(routerOrigin: String) {
        if (updateChecked) return
        updateChecked = true
        thread(name = "update-check", isDaemon = true) {
            val android = try {
                val connection = URL("$routerOrigin/api/config").openConnection() as HttpURLConnection
                connection.connectTimeout = 10000
                connection.readTimeout = 10000
                // Hinter Cloudflare Access: Anmelde-Cookie der WebView mitschicken; Umleitung zur Anmeldung = kein Ergebnis.
                CookieManager.getInstance().getCookie(routerOrigin)?.let { connection.setRequestProperty("Cookie", it) }
                connection.instanceFollowRedirects = false
                if (connection.responseCode != HttpURLConnection.HTTP_OK) null
                else connection.inputStream.bufferedReader().use { JSONObject(it.readText()) }.optJSONObject("android")
            } catch (_: Exception) {
                null
            } ?: return@thread
            val versionCode = android.optInt("versionCode", 0)
            if (!android.optBoolean("available") || versionCode <= BuildConfig.VERSION_CODE) return@thread
            val versionName = android.optString("versionName").ifBlank { versionCode.toString() }
            runOnUiThread {
                if (isFinishing) return@runOnUiThread
                AlertDialog.Builder(this)
                    .setTitle(R.string.update_title)
                    .setMessage(getString(R.string.update_message, versionName))
                    .setPositiveButton(R.string.update_download) { _, _ -> openExternal(Uri.parse("$routerOrigin/app/opengrid.apk")) }
                    .setNegativeButton(R.string.update_later, null)
                    .show()
            }
        }
    }
}
