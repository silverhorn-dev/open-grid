import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// ================= NACKTBILD-MODELLE (Board T3) =================
// Der Router liefert die Erkennungsmodelle selbst aus (keine fremden Server, Regel 1); die App laedt
// eins erst, wenn der Nutzer den Filter einschaltet, und rechnet im Web Worker.
//
// Modelle:
//   nsfwjs, nsfwjs-mid, nsfwjs-inception  NSFWJS (MIT), im npm-Paket enthalten; Klassen Drawing,
//       Hentai, Neutral, Porn, Sexy. Gemessen 2026-10-29 (Nutzer): erkennt ein maennliches Nacktbild
//       (Badezimmer-Selfie) nicht (Neutral 85 %), die Trainingsdaten sind ueberwiegend weiblich.
//   bumble   Bumble Private Detector (Apache-2.0), gebaut fuer ungefragte Nacktbilder in Dating-Apps;
//       umgewandelt im Repository unter models/bumble (~51 MB).
//   nudenet  NudeNet 320n (AGPL-3.0, YOLOv8), erkennt Koerperteile einzeln (u. a. MALE_GENITALIA_EXPOSED);
//       ~12 MB, das Docker-Image laedt es beim Bauen nach models/nudenet; braucht onnxruntime-web
//       (optionalDependencies, WASM ~15 MB).
// Gesucht wird in NUDITY_MODEL_DIR (Vorrang) und danach in models/ des Projekts (models/README.md).
//
// Konfiguration (Betreiber):
//   NUDITY_MODEL      aktives Modell (Standard nsfwjs) oder 'off'; fehlt ein optionales Modell, gilt nsfwjs
//   NUDITY_THRESHOLD  ab welchem Wert unscharf (0.5-0.95, Standard 0.7)
//   NUDITY_CLASSES    welche Klassen des aktiven Modells zaehlen (Komma-Liste, Standard je Modell)
//   NUDITY_MODEL_DIR  eigener Ordner fuer Modelle (Standard: data/nudity-models neben der Datenbank)
export const NSFWJS_CLASSES = ['Drawing', 'Hentai', 'Neutral', 'Porn', 'Sexy'];
export const NUDENET_CLASSES = [
    'FEMALE_GENITALIA_COVERED', 'FACE_FEMALE', 'BUTTOCKS_EXPOSED', 'FEMALE_BREAST_EXPOSED',
    'FEMALE_GENITALIA_EXPOSED', 'MALE_BREAST_EXPOSED', 'ANUS_EXPOSED', 'FEET_EXPOSED',
    'BELLY_COVERED', 'FEET_COVERED', 'ARMPITS_COVERED', 'ARMPITS_EXPOSED', 'FACE_MALE',
    'BELLY_EXPOSED', 'MALE_GENITALIA_EXPOSED', 'ANUS_COVERED', 'FEMALE_BREAST_COVERED',
    'BUTTOCKS_COVERED'
];

// combine: wie aus den Klassen ein Wert wird. 'sum' fuer sich ausschliessende Klassen (Wahrscheinlichkeiten),
// 'max' fuer den Detektor (jede Klasse ist eine eigene Fundstelle).
export const NUDITY_MODELS = {
    nsfwjs: { kind: 'nsfwjs', directory: 'mobilenet_v2', size: 224, type: 'layers', classes: NSFWJS_CLASSES, defaultClasses: ['Porn', 'Hentai'], combine: 'sum' },
    'nsfwjs-mid': { kind: 'nsfwjs', directory: 'mobilenet_v2_mid', size: 224, type: 'graph', classes: NSFWJS_CLASSES, defaultClasses: ['Porn', 'Hentai'], combine: 'sum' },
    'nsfwjs-inception': { kind: 'nsfwjs', directory: 'inception_v3', size: 299, type: 'layers', classes: NSFWJS_CLASSES, defaultClasses: ['Porn', 'Hentai'], combine: 'sum' },
    bumble: { kind: 'bumble', directory: 'bumble', size: 480, classes: ['Lewd'], defaultClasses: ['Lewd'], combine: 'sum' },
    nudenet: {
        kind: 'nudenet', directory: 'nudenet', size: 320, classes: NUDENET_CLASSES, combine: 'max',
        defaultClasses: ['MALE_GENITALIA_EXPOSED', 'FEMALE_GENITALIA_EXPOSED', 'FEMALE_BREAST_EXPOSED', 'ANUS_EXPOSED', 'BUTTOCKS_EXPOSED']
    }
};
const DEFAULT_MODEL = 'nsfwjs';
const DEFAULT_THRESHOLD = 0.7;

export function parseNudityConfig({ model, threshold, classes } = {}) {
    const name = String(model ?? DEFAULT_MODEL).trim().toLowerCase();
    const parsedThreshold = Number(threshold);
    return {
        model: name === 'off' ? 'off' : (NUDITY_MODELS[name] ? name : DEFAULT_MODEL),
        threshold: Number.isFinite(parsedThreshold) && parsedThreshold >= 0.5 && parsedThreshold <= 0.95 ? parsedThreshold : DEFAULT_THRESHOLD,
        // Rohliste; gegen die Klassen des aktiven Modells geprueft in nudityModelClasses().
        classes: String(classes ?? '').split(',').map(value => value.trim()).filter(Boolean)
    };
}

// Nur Klassen, die das Modell kennt (Gross-/Kleinschreibung egal); keine gueltige -> Standard des Modells.
export function nudityModelClasses(modelId, wanted = []) {
    const model = NUDITY_MODELS[modelId];
    if (!model) return [];
    const known = wanted.map(value => model.classes.find(entry => entry.toLowerCase() === String(value).toLowerCase())).filter(Boolean);
    return known.length ? [...new Set(known)] : model.defaultClasses;
}

const longCache = reply => reply.header('Cache-Control', 'public, max-age=31536000, immutable');

function packageRoot(require, name) {
    try {
        // Manche Pakete geben package.json nicht frei ("exports"); Wurzel ueber den Einstieg suchen.
        // dist/cjs traegt oft ein eigenes package.json ohne Namen: bis zum package.json mit passendem Namen.
        let directory = dirname(require.resolve(name));
        while (dirname(directory) !== directory) {
            const file = join(directory, 'package.json');
            if (existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).name === name) return directory;
            directory = dirname(directory);
        }
        return null;
    } catch {
        return null;
    }
}

async function packageVersion(root) {
    return JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
}

// NSFWJS: Bibliothek + drei Modelle aus dem npm-Paket. Das Paket packt Topologie und Gewichte-Teile
// als JS-Module (Base64); beim ersten Abruf werden daraus model.json und binaere Teile.
async function registerNsfwjs(app, require) {
    const root = packageRoot(require, 'nsfwjs');
    if (!root) return {};
    const base = `/vendor/nsfwjs/${await packageVersion(root)}`;
    app.get(`${base}/nsfwjs.min.js`, async (_request, reply) => {
        longCache(reply).type('text/javascript; charset=utf-8');
        return readFile(join(root, 'dist', 'browser', 'nsfwjs.min.js'));
    });
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
    for (const [id, model] of Object.entries(NUDITY_MODELS).filter(([, entry]) => entry.kind === 'nsfwjs')) {
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
        models[id] = { library: `${base}/nsfwjs.min.js`, modelUrl: `${base}/${model.directory}/` };
    }
    return models;
}

// Feste Dateiliste aus einem Ordner ausliefern; der Pfad traegt einen Hash der Hauptdatei (lange cachebar).
async function serveModelFiles(app, { directory, route, files, main }) {
    const hash = createHash('sha256').update(await readFile(join(directory, main))).digest('hex').slice(0, 12);
    const base = `/vendor/nudity-models/${route}/${hash}`;
    for (const file of files) {
        app.get(`${base}/${file}`, async (_request, reply) => {
            longCache(reply).type(file.endsWith('.json') ? 'application/json; charset=utf-8' : 'application/octet-stream');
            return readFile(join(directory, file));
        });
    }
    return `${base}/`;
}

// Bumble: TF.js-Graph-Modell (model.json + Teile) aus NUDITY_MODEL_DIR/bumble, Bibliothek = TF.js.
// Erster Ordner, der die Hauptdatei enthaelt.
function findModelDirectory(modelDirectories, name, main) {
    return modelDirectories.map(base => join(base, name)).find(directory => existsSync(join(directory, main))) || null;
}

async function registerBumble(app, require, modelDirectories, log) {
    const directory = findModelDirectory(modelDirectories, 'bumble', 'model.json');
    if (!directory) return {};
    const tfRoot = packageRoot(require, '@tensorflow/tfjs');
    if (!tfRoot) {
        log.warn('Bumble model found, but @tensorflow/tfjs is missing.');
        return {};
    }
    const manifest = JSON.parse(await readFile(join(directory, 'model.json'), 'utf8'));
    const files = ['model.json', ...manifest.weightsManifest.flatMap(group => group.paths)];
    if (files.some(file => !/^[\w.-]+$/.test(file) || !existsSync(join(directory, file)))) {
        log.warn(`Bumble model in ${directory} is incomplete.`);
        return {};
    }
    // ES2017-Build: ohne Babel-Polyfills, die per Function() an der CSP scheitern.
    const library = `/vendor/tfjs/${await packageVersion(tfRoot)}/tf.es2017.min.js`;
    app.get(library, async (_request, reply) => {
        longCache(reply).type('text/javascript; charset=utf-8');
        return readFile(join(tfRoot, 'dist', 'tf.es2017.min.js'));
    });
    const modelUrl = await serveModelFiles(app, { directory, route: 'bumble', files, main: 'model.json' });
    return { bumble: { library, modelUrl } };
}

// NudeNet: ONNX-Datei aus NUDITY_MODEL_DIR/nudenet, Laufzeit onnxruntime-web (WASM, ein Thread).
async function registerNudenet(app, require, modelDirectories, log) {
    const directory = findModelDirectory(modelDirectories, 'nudenet', '320n.onnx');
    if (!directory) return {};
    const ortRoot = packageRoot(require, 'onnxruntime-web');
    if (!ortRoot) {
        log.warn('NudeNet model found, but onnxruntime-web is missing (optional dependency).');
        return {};
    }
    const ortBase = `/vendor/onnxruntime-web/${await packageVersion(ortRoot)}/`;
    const ortFiles = {
        'ort.wasm.min.js': 'text/javascript; charset=utf-8',
        'ort-wasm-simd-threaded.mjs': 'text/javascript; charset=utf-8',
        'ort-wasm-simd-threaded.wasm': 'application/wasm'
    };
    for (const [file, type] of Object.entries(ortFiles)) {
        app.get(`${ortBase}${file}`, async (_request, reply) => {
            longCache(reply).type(type);
            return readFile(join(ortRoot, 'dist', file));
        });
    }
    const modelUrl = await serveModelFiles(app, { directory, route: 'nudenet', files: ['320n.onnx'], main: '320n.onnx' });
    return { nudenet: { library: `${ortBase}ort.wasm.min.js`, runtimeUrl: ortBase, modelUrl: `${modelUrl}320n.onnx` } };
}

// Routen fuer alle verfuegbaren Modelle; Rueckgabe = oeffentliche Beschreibung je Modell (fuer /api/config).
// Auch bei NUDITY_MODEL=off registriert: das Admin-Panel kann das Modell live einschalten.
export async function registerNudityModelRoutes(app, config, { modelDirectories = [] } = {}) {
    const require = createRequire(import.meta.url);
    const found = {
        ...await registerNsfwjs(app, require),
        ...await registerBumble(app, require, modelDirectories, app.log),
        ...await registerNudenet(app, require, modelDirectories, app.log)
    };
    const models = Object.fromEntries(Object.entries(found).map(([id, urls]) => {
        const { kind, size, type, classes, defaultClasses, combine } = NUDITY_MODELS[id];
        return [id, { kind, size, ...(type ? { type } : {}), classes, defaultClasses, combine, ...urls }];
    }));
    if (!Object.keys(models).length) {
        app.log.warn('No nudity model available: nudity filter without model.');
        return null;
    }
    if (config.model !== 'off' && !models[config.model]) app.log.warn(`NUDITY_MODEL=${config.model} is not installed (models/README.md); using nsfwjs.`);
    return { models };
}

// Gewaehltes Modell, sonst nsfwjs bzw. das erste verfuegbare.
function activeModel(config, assets) {
    if (assets.models[config.model]) return config.model;
    return assets.models[DEFAULT_MODEL] ? DEFAULT_MODEL : Object.keys(assets.models)[0];
}

// Fuer /api/config: aktives Modell (flach) + alle verfuegbaren (Testseite im Debug-Modus).
export function nudityPublicConfig(config, assets) {
    if (!assets || config.model === 'off') return { model: 'off' };
    const active = activeModel(config, assets);
    return {
        ...assets.models[active],
        model: active,
        threshold: config.threshold,
        classes: nudityModelClasses(active, config.classes),
        models: assets.models
    };
}
