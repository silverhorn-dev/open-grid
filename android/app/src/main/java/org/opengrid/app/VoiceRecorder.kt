package org.opengrid.app

import android.content.Context
import android.media.MediaRecorder
import android.os.Build
import android.os.SystemClock
import android.util.Base64
import java.io.File

// Sprachnachrichten in der App (Board T38): getUserMedia fuer das Mikrofon beendet in der Android-WebView den
// Renderer (gemessen 2026-11-20, Chrome 157 / Android 16, genug Speicher frei). Darum nimmt hier Android selbst auf
// (MediaRecorder: Opus in OGG ab Android 10, sonst AAC in MP4, mono, ca. 12 kbit/s) und gibt der PWA nur die fertige
// Datei als Data-URL. Ein Teil nach dem anderen ("split" fuer den zweiten Teil ab 60 s, wie im Browser). Die
// Dateien liegen nur kurz im Cache-Ordner der App und werden danach geloescht.
object VoiceRecorder {
    private var recorder: MediaRecorder? = null
    private var file: File? = null
    private var startedAt = 0L

    val mimeType: String
        get() = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) "audio/ogg;codecs=opus" else "audio/mp4"

    fun isRecording() = recorder != null

    @Suppress("DEPRECATION")
    fun start(context: Context) {
        cancel()
        val target = File(context.cacheDir, "voice-${SystemClock.elapsedRealtimeNanos()}.${if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) "ogg" else "m4a"}")
        val media = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) MediaRecorder(context) else MediaRecorder()
        try {
            media.setAudioSource(MediaRecorder.AudioSource.MIC)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                media.setOutputFormat(MediaRecorder.OutputFormat.OGG)
                media.setAudioEncoder(MediaRecorder.AudioEncoder.OPUS)
                media.setAudioSamplingRate(48_000)
            } else {
                media.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                media.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                media.setAudioSamplingRate(16_000)
            }
            media.setAudioChannels(1)
            // Wie im Browser (voice.js VOICE_BITRATE): 60 s passen so in eine Nachricht (VOICE_MAX_DATA_URL_LENGTH).
            media.setAudioEncodingBitRate(12_000)
            media.setOutputFile(target.absolutePath)
            media.prepare()
            media.start()
        } catch (error: Exception) {
            media.release()
            target.delete()
            throw error
        }
        recorder = media
        file = target
        startedAt = SystemClock.elapsedRealtime()
    }

    // Aktuellen Teil beenden: Data-URL + Dauer; zu kurz (MediaRecorder wirft) = null.
    fun finish(): Pair<String, Long>? {
        val media = recorder ?: return null
        val target = file
        val duration = SystemClock.elapsedRealtime() - startedAt
        recorder = null
        file = null
        val stopped = try {
            media.stop()
            true
        } catch (_: RuntimeException) {
            false
        } finally {
            media.release()
        }
        if (!stopped || target == null) {
            target?.delete()
            return null
        }
        return try {
            val bytes = target.readBytes()
            if (bytes.isEmpty()) null else Pair("data:$mimeType;base64,${Base64.encodeToString(bytes, Base64.NO_WRAP)}", duration)
        } finally {
            target.delete()
        }
    }

    fun cancel() {
        val media = recorder
        recorder = null
        if (media != null) {
            try {
                media.stop()
            } catch (_: RuntimeException) {
            }
            media.release()
        }
        file?.delete()
        file = null
    }
}
