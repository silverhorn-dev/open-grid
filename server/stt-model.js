// ================= SPRACHNACHRICHTEN VERSCHRIFTLICHEN (Board T38 C) =================
// Whisper laeuft nur auf dem Geraet (client/app/stt-worker.js, transformers.js + onnxruntime-web WASM); der Router
// liefert Bibliothek, Laufzeit und Modell nur aus (keine fremden Server, Regel 1; Standard von transformers.js waeren
// jsDelivr und huggingface.co). Das Audio verlaesst das Geraet nie.
//
// Inhalt (Docker-Stufe "whisper", feste Pruefsummen) in STT_MODEL_DIR (Standard: data/stt-models, sonst models/whisper):
//   transformers.min.js                  transformers.js (Apache-2.0)
//   ort-wasm-simd-threaded.asyncify.mjs/.wasm  passende onnxruntime-web-Laufzeit (MIT)
//   whisper-base/                        onnx-community/whisper-base (Apache-2.0), quantisiert (q8), ca. 77 MB
//   VERSION.json                         { transformers, ort, model, commit }
//
// Konfiguration (Betreiber): STT_MODEL = whisper-base | off (Standard: whisper-base, wenn installiert).
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const STT_MODELS = { 'whisper-base': { sizeMb: 77 } };
const MODEL_FILES = [
    'config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json',
    'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx'
];
const RUNTIME_FILES = {
    'transformers.min.js': 'text/javascript; charset=utf-8',
    'ort-wasm-simd-threaded.asyncify.mjs': 'text/javascript; charset=utf-8',
    'ort-wasm-simd-threaded.asyncify.wasm': 'application/wasm'
};

export function parseSttModel(value) {
    const model = String(value ?? 'whisper-base').trim().toLowerCase();
    return model === 'off' || STT_MODELS[model] ? model : null;
}

export function findSttDirectory(directories, model) {
    return directories.filter(Boolean).find(directory => Object.keys(RUNTIME_FILES).every(file => existsSync(join(directory, file)))
        && MODEL_FILES.every(file => existsSync(join(directory, model, file)))) || null;
}

const contentType = file => (file.endsWith('.json') ? 'application/json; charset=utf-8' : 'application/octet-stream');

// Routen unter /vendor/whisper/<version>/ (lange gecacht); Rueckgabe = Beschreibung fuer /api/config oder null.
export async function registerSttRoutes(app, { directories, model }) {
    if (model === 'off') return null;
    const directory = findSttDirectory(directories, model);
    if (!directory) {
        app.log.info('No speech-to-text model installed (STT_MODEL); transcription is off.');
        return null;
    }
    const version = await readFile(join(directory, 'VERSION.json'), 'utf8').then(JSON.parse).catch(() => ({}));
    const id = String(version.transformers || 'local').replace(/[^\w.-]/g, '');
    const base = `/vendor/whisper/${id}/`;
    const cached = reply => reply.header('cache-control', 'public, max-age=31536000, immutable');
    for (const [file, type] of Object.entries(RUNTIME_FILES)) {
        app.get(`${base}${file}`, async (_request, reply) => {
            cached(reply).type(type);
            return readFile(join(directory, file));
        });
    }
    for (const file of MODEL_FILES) {
        app.get(`${base}models/${model}/${file}`, async (_request, reply) => {
            cached(reply).type(contentType(file));
            return readFile(join(directory, model, file));
        });
    }
    return { model, sizeMb: STT_MODELS[model].sizeMb, library: `${base}transformers.min.js`, wasmPaths: base, modelBase: `${base}models/` };
}
