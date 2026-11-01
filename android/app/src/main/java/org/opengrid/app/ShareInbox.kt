package org.opengrid.app

import android.content.ContentResolver
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject

// Geteilte Inhalte aus anderen Apps (wie share_target der PWA): liegen nur im Speicher, bis die
// Seite sie per Bruecke abholt (`takeShare`). Nichts geht an den Router.
class ShareInbox(private val resolver: ContentResolver) {
    companion object {
        private const val MAX_FILES = 20
        private const val MAX_FILE_BYTES = 15 * 1024 * 1024
        private const val MAX_TOTAL_BYTES = 40 * 1024 * 1024
    }

    private var pending: JSONObject? = null

    // true = es liegt etwas bereit.
    fun accept(intent: Intent): Boolean {
        if (intent.action != Intent.ACTION_SEND && intent.action != Intent.ACTION_SEND_MULTIPLE) return false
        val uris = sharedUris(intent)
        val files = JSONArray()
        var skipped = 0
        var total = 0
        for (uri in uris.take(MAX_FILES)) {
            val type = resolver.getType(uri) ?: ""
            val bytes = if (type.startsWith("image/")) readLimited(uri) else null
            if (bytes == null || total + bytes.size > MAX_TOTAL_BYTES) {
                skipped += 1
                continue
            }
            total += bytes.size
            files.put(JSONObject().put("type", type).put("data", Base64.encodeToString(bytes, Base64.NO_WRAP)))
        }
        skipped += (uris.size - MAX_FILES).coerceAtLeast(0)
        val text = intent.getStringExtra(Intent.EXTRA_TEXT)
        val title = intent.getStringExtra(Intent.EXTRA_SUBJECT)
        if (files.length() == 0 && text.isNullOrBlank() && skipped == 0) return false
        pending = JSONObject()
            .put("title", title ?: "")
            .put("text", text ?: "")
            .put("files", files)
            .put("skipped", skipped)
        return true
    }

    fun take(): JSONObject? = pending.also { pending = null }

    @Suppress("DEPRECATION")
    private fun sharedUris(intent: Intent): List<Uri> = when (intent.action) {
        Intent.ACTION_SEND -> listOfNotNull(
            if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
            else intent.getParcelableExtra(Intent.EXTRA_STREAM)
        )
        else -> (if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
        else intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)).orEmpty()
    }

    private fun readLimited(uri: Uri): ByteArray? = try {
        resolver.openInputStream(uri)?.use { stream ->
            val bytes = stream.readNBytesCompat(MAX_FILE_BYTES + 1)
            if (bytes.size > MAX_FILE_BYTES) null else bytes
        }
    } catch (_: Exception) {
        null
    }

    private fun java.io.InputStream.readNBytesCompat(limit: Int): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(64 * 1024)
        while (out.size() < limit) {
            val read = read(buffer, 0, minOf(buffer.size, limit - out.size()))
            if (read < 0) break
            out.write(buffer, 0, read)
        }
        return out.toByteArray()
    }
}
