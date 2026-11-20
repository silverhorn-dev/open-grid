// ================= VERSCHRIFTLICHUNG IM WORKER (Board T38 C) =================
// Whisper (onnx-community/whisper-base, q8) ueber transformers.js und onnxruntime-web (WASM, ein Thread). Bibliothek,
// Laufzeit und Modell kommen vom eigenen Router (/api/config `stt`, server/stt-model.js), nie von jsDelivr oder
// huggingface.co. Eingabe: Float32Array, 16 kHz mono; Ausgabe: Text. Das Audio verlaesst das Geraet nicht.
// Als Modul-Worker gestartet (stt.js), damit die ESM-Bibliothek per import() laedt.
let transcriberPromise = null;
let loadedConfigKey = null;

async function transcriber(config, onProgress) {
    const key = `${config.library}|${config.model}`;
    if (!transcriberPromise || loadedConfigKey !== key) {
        loadedConfigKey = key;
        transcriberPromise = (async () => {
            const { pipeline, env } = await import(config.library);
            env.allowRemoteModels = false;
            env.allowLocalModels = true;
            env.localModelPath = config.modelBase;
            // Modell nach dem ersten Laden im Cache des Browsers (vom eigenen Router, ca. 77 MB).
            env.useBrowserCache = true;
            env.backends.onnx.wasm.wasmPaths = config.wasmPaths;
            // Mehrere Threads braeuchten SharedArrayBuffer (Cross-Origin-Isolation); einer reicht.
            env.backends.onnx.wasm.numThreads = 1;
            env.backends.onnx.wasm.proxy = false;
            return pipeline('automatic-speech-recognition', config.model, {
                device: 'wasm',
                dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
                progress_callback: onProgress
            });
        })().catch(error => {
            transcriberPromise = null;
            throw error;
        });
    }
    return transcriberPromise;
}

self.addEventListener('message', async event => {
    const { id, config, audio, language } = event.data || {};
    try {
        const run = await transcriber(config, progress => {
            if (progress?.status === 'progress') self.postMessage({ id, progress: { file: progress.file, loaded: progress.loaded, total: progress.total } });
        });
        self.postMessage({ id, working: true });
        const result = await run(audio, {
            chunk_length_s: 30,
            stride_length_s: 5,
            task: 'transcribe',
            ...(language ? { language } : {})
        });
        const text = (Array.isArray(result) ? result.map(part => part.text).join(' ') : result?.text || '').replace(/\s+/g, ' ').trim();
        self.postMessage({ id, text });
    } catch (error) {
        self.postMessage({ id, error: error?.message || String(error) });
    }
});
