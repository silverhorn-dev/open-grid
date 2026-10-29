import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// ================= NACKTBILD-MODELL (Board T3) =================
// Der Router liefert das Erkennungsmodell selbst aus (keine fremden Server, Regel 1). Modell: NSFWJS
// MobileNetV2 (Code und Modell MIT; Klassen Drawing, Hentai, Neutral, Porn, Sexy; Eingabe 224x224). Das
// npm-Paket packt Modell und Gewichte als JS-Module; hier werden daraus beim ersten Abruf normale
// TF.js-Dateien (model.json + Gewichte). Die App laedt sie nur, wenn der Nutzer den Filter einschaltet.
// Gemessen 2026-10-29 (Nutzer): MobileNetV2 erkannte ein maennliches Nacktbild (Badezimmer-Selfie)
// nicht (Neutral 85 %); deshalb waehlbar und auf der Testseite vergleichbar.
//
// Konfiguration (Betreiber):
//   NUDITY_MODEL      welches Modell gilt: 'nsfwjs' (MobileNetV2, ~2,6 MB, Standard), 'nsfwjs-mid'
//                     (MobileNetV2 Mid, ~4 MB), 'nsfwjs-inception' (InceptionV3, ~21 MB, 299x299) oder 'off'
//   NUDITY_THRESHOLD  ab welchem Wert unscharf (0.5-0.95, Standard 0.7)
//   NUDITY_CLASSES    welche Klassen zaehlen (Komma-Liste, Standard "Porn,Hentai")
// Der Nutzer-Standard fuer den Schalter kommt weiter aus CLIENT_DEFAULTS.nudityFilter.
export const NUDITY_MODEL_CLASSES = ['Drawing', 'Hentai', 'Neutral', 'Porn', 'Sexy'];
// Alle drei liefert der Router aus (die Testseite im Debug-Modus vergleicht sie); `NUDITY_MODEL` waehlt das aktive.
export const NUDITY_MODELS = {
    nsfwjs: { directory: 'mobilenet_v2', size: 224, type: 'layers' },
    'nsfwjs-mid': { directory: 'mobilenet_v2_mid', size: 224, type: 'graph' },
    'nsfwjs-inception': { directory: 'inception_v3', size: 299, type: 'layers' }
};
const DEFAULT_THRESHOLD = 0.7;
const DEFAULT_CLASSES = ['Porn', 'Hentai'];

export function parseNudityConfig({ model, threshold, classes } = {}) {
    const name = String(model ?? 'nsfwjs').trim().toLowerCase();
    const parsedThreshold = Number(threshold);
    const wanted = String(classes ?? '').split(',').map(value => value.trim())
        .map(value => NUDITY_MODEL_CLASSES.find(known => known.toLowerCase() === value.toLowerCase()))
        .filter(Boolean);
    return {
        model: name === 'off' ? 'off' : (NUDITY_MODELS[name] ? name : 'nsfwjs'),
        threshold: Number.isFinite(parsedThreshold) && parsedThreshold >= 0.5 && parsedThreshold <= 0.95 ? parsedThreshold : DEFAULT_THRESHOLD,
        classes: wanted.length ? [...new Set(wanted)] : DEFAULT_CLASSES
    };
}

// Routen fuer Bibliothek und Modell; Pfade tragen die Paketversion (lange cachebar).
export async function registerNudityModelRoutes(app, config) {
    if (!NUDITY_MODELS[config.model]) return null;
    const require = createRequire(import.meta.url);
    let root;
    try {
        // Das Paket gibt package.json nicht frei ("exports"); Wurzel ueber den Einstieg dist/cjs/index.js.
        root = join(dirname(require.resolve('nsfwjs')), '..', '..');
    } catch {
        app.log.warn(`NUDITY_MODEL=${config.model}, but the nsfwjs package is missing: nudity filter without model.`);
        return null;
    }
    const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
    const base = `/vendor/nsfwjs/${version}`;
    const longCache = reply => reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    app.get(`${base}/nsfwjs.min.js`, async (_request, reply) => {
        longCache(reply).type('text/javascript; charset=utf-8');
        return readFile(join(root, 'dist', 'browser', 'nsfwjs.min.js'));
    });

    // Das npm-Paket packt Topologie und Gewichte-Teile als JS-Module (Base64); beim ersten Abruf
    // werden daraus model.json und binaere Teile, danach im Speicher gehalten.
    const unpacked = new Map();
    const unpack = directory => {
        if (!unpacked.has(directory)) {
            const modelDirectory = join(root, 'dist', 'models', directory);
            const topology = require(join(modelDirectory, 'model.min.js'));
            const manifest = typeof topology === 'string' ? JSON.parse(topology) : topology;
            const shards = new Map(manifest.weightsManifest.flatMap(group => group.paths)
                .map(path => [path, Buffer.from(require(join(modelDirectory, `${path}.min.js`)), 'base64')]));
            unpacked.set(directory, { json: JSON.stringify(manifest), shards });
        }
        return unpacked.get(directory);
    };
    const models = {};
    for (const [id, model] of Object.entries(NUDITY_MODELS)) {
        app.get(`${base}/${model.directory}/model.json`, async (_request, reply) => {
            longCache(reply).type('application/json; charset=utf-8');
            return unpack(model.directory).json;
        });
        app.get(`${base}/${model.directory}/:shard`, async (request, reply) => {
            const shard = unpack(model.directory).shards.get(request.params.shard);
            if (!shard) return reply.code(404).send({ error: 'Not found' });
            longCache(reply).type('application/octet-stream');
            return shard;
        });
        models[id] = { modelUrl: `${base}/${model.directory}/`, size: model.size, type: model.type };
    }
    return { library: `${base}/nsfwjs.min.js`, models };
}
