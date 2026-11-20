// ================= STICKER: ROUTER (Board T39) =================
// S2 Ausschneiden: U^2-Net-p (xuebinqin/U-2-Net, Apache-2.0; ONNX aus rembg, MIT) rechnet im Browser
// (client/app/sticker-worker.js, onnxruntime-web WASM); der Router liefert Modell und Laufzeit nur aus.
// Modell: STICKER_MODEL_DIR (Standard data/sticker-models, sonst models/stickers im Image) mit u2netp.onnx.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { packageRoot, packageVersion } from './nudity-model.js';

export const CUTOUT_MODEL_FILE = 'u2netp.onnx';

export function findCutoutModel(directories) {
    return directories.filter(Boolean).map(directory => join(directory, CUTOUT_MODEL_FILE)).find(path => existsSync(path)) || null;
}

const immutable = reply => reply.header('cache-control', 'public, max-age=31536000, immutable');

// Laufzeit (onnxruntime-web aus node_modules) + Modell unter /vendor/stickers/<ort-version>/; null ohne beides.
export async function registerCutoutAssets(app, modelPath) {
    const require = createRequire(import.meta.url);
    const ortRoot = packageRoot(require, 'onnxruntime-web');
    if (!ortRoot || !modelPath) return null;
    const base = `/vendor/stickers/${await packageVersion(ortRoot)}/`;
    const files = {
        'ort.wasm.min.js': 'text/javascript; charset=utf-8',
        'ort-wasm-simd-threaded.mjs': 'text/javascript; charset=utf-8',
        'ort-wasm-simd-threaded.wasm': 'application/wasm'
    };
    for (const [file, type] of Object.entries(files)) {
        app.get(`${base}${file}`, async (_request, reply) => {
            immutable(reply).type(type);
            return readFile(join(ortRoot, 'dist', file));
        });
    }
    app.get(`${base}${CUTOUT_MODEL_FILE}`, async (_request, reply) => {
        immutable(reply).type('application/octet-stream');
        return readFile(modelPath);
    });
    return { library: `${base}ort.wasm.min.js`, runtimeUrl: base, modelUrl: `${base}${CUTOUT_MODEL_FILE}`, sizeMb: 4.6 };
}
