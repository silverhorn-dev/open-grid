import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// ================= NACKTBILD-MODELL (Board T3) =================
// Der Router liefert das Erkennungsmodell selbst aus (keine fremden Server, Regel 1). Modell: NSFWJS
// MobileNetV2 (Code und Modell MIT; Klassen Drawing, Hentai, Neutral, Porn, Sexy; Eingabe 224x224). Das
// npm-Paket packt Modell und Gewichte als JS-Module; hier werden daraus beim ersten Abruf normale
// TF.js-Dateien (model.json + Gewichte). Die App laedt sie nur, wenn der Nutzer den Filter einschaltet.
//
// Konfiguration (Betreiber):
//   NUDITY_MODEL      'nsfwjs' (Standard) oder 'off' (kein Modell, der Filter sagt das)
//   NUDITY_THRESHOLD  ab welchem Wert unscharf (0.5-0.95, Standard 0.7)
//   NUDITY_CLASSES    welche Klassen zaehlen (Komma-Liste, Standard "Porn,Hentai")
// Der Nutzer-Standard fuer den Schalter kommt weiter aus CLIENT_DEFAULTS.nudityFilter.
export const NUDITY_MODEL_CLASSES = ['Drawing', 'Hentai', 'Neutral', 'Porn', 'Sexy'];
const DEFAULT_THRESHOLD = 0.7;
const DEFAULT_CLASSES = ['Porn', 'Hentai'];

export function parseNudityConfig({ model, threshold, classes } = {}) {
    const name = String(model ?? 'nsfwjs').trim().toLowerCase();
    const parsedThreshold = Number(threshold);
    const wanted = String(classes ?? '').split(',').map(value => value.trim())
        .map(value => NUDITY_MODEL_CLASSES.find(known => known.toLowerCase() === value.toLowerCase()))
        .filter(Boolean);
    return {
        model: name === 'off' ? 'off' : 'nsfwjs',
        threshold: Number.isFinite(parsedThreshold) && parsedThreshold >= 0.5 && parsedThreshold <= 0.95 ? parsedThreshold : DEFAULT_THRESHOLD,
        classes: wanted.length ? [...new Set(wanted)] : DEFAULT_CLASSES
    };
}

// Routen fuer Bibliothek und Modell; Pfade tragen die Paketversion (lange cachebar).
export async function registerNudityModelRoutes(app, config) {
    if (config.model !== 'nsfwjs') return null;
    const require = createRequire(import.meta.url);
    let root;
    try {
        // Das Paket gibt package.json nicht frei ("exports"); Wurzel ueber den Einstieg dist/cjs/index.js.
        root = join(dirname(require.resolve('nsfwjs')), '..', '..');
    } catch {
        app.log.warn('NUDITY_MODEL=nsfwjs, but the nsfwjs package is missing: nudity filter without model.');
        return null;
    }
    const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
    const base = `/vendor/nsfwjs/${version}`;
    const modelDirectory = join(root, 'dist', 'models', 'mobilenet_v2');
    let modelJson = null;
    let weights = null;
    const loadModel = () => {
        if (modelJson) return;
        const topology = require(join(modelDirectory, 'model.min.js'));
        modelJson = JSON.stringify(typeof topology === 'string' ? JSON.parse(topology) : topology);
        weights = Buffer.from(require(join(modelDirectory, 'group1-shard1of1.min.js')), 'base64');
    };
    const longCache = reply => reply.header('Cache-Control', 'public, max-age=31536000, immutable');

    app.get(`${base}/nsfwjs.min.js`, async (_request, reply) => {
        longCache(reply).type('text/javascript; charset=utf-8');
        return readFile(join(root, 'dist', 'browser', 'nsfwjs.min.js'));
    });
    app.get(`${base}/mobilenet_v2/model.json`, async (_request, reply) => {
        loadModel();
        longCache(reply).type('application/json; charset=utf-8');
        return modelJson;
    });
    app.get(`${base}/mobilenet_v2/group1-shard1of1`, async (_request, reply) => {
        loadModel();
        longCache(reply).type('application/octet-stream');
        return weights;
    });
    return { library: `${base}/nsfwjs.min.js`, modelUrl: `${base}/mobilenet_v2/`, size: 224 };
}
