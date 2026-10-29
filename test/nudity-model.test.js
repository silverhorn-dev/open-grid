import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../server/app.js';
import { createStore } from '../server/database.js';
import { nudityModelClasses, parseNudityConfig } from '../server/nudity-model.js';

async function appWith(options) {
    const store = createStore(':memory:');
    const app = await buildApp({ store, buildVersion: 'test', buildTimestamp: '2026-10-29T00:00:00.000Z', ...options });
    return { app, close: async () => { await app.close(); store.close(); } };
}

// Optionale Modelle wie nach scripts/nudity-models/fetch.sh (Inhalt egal, der Router prueft nur Dateien).
function optionalModels({ bumble = true, nudenet = true } = {}) {
    const directory = mkdtempSync(join(tmpdir(), 'og-nudity-'));
    if (bumble) {
        mkdirSync(join(directory, 'bumble'));
        writeFileSync(join(directory, 'bumble', 'model.json'), JSON.stringify({ format: 'graph-model', modelTopology: {}, weightsManifest: [{ paths: ['group1-shard1of1.bin'], weights: [] }] }));
        writeFileSync(join(directory, 'bumble', 'group1-shard1of1.bin'), Buffer.from([1, 2, 3]));
    }
    if (nudenet) {
        mkdirSync(join(directory, 'nudenet'));
        writeFileSync(join(directory, 'nudenet', '320n.onnx'), Buffer.from('onnx'));
    }
    return directory;
}

test('nudity config: defaults, off, unknown model, threshold range', () => {
    assert.deepEqual(parseNudityConfig({}), { model: 'nsfwjs', threshold: 0.7, classes: [] });
    assert.equal(parseNudityConfig({ model: 'OFF' }).model, 'off');
    for (const model of ['nsfwjs-mid', 'nsfwjs-inception', 'bumble', 'nudenet']) assert.equal(parseNudityConfig({ model }).model, model);
    assert.equal(parseNudityConfig({ model: 'unknown' }).model, 'nsfwjs');
    assert.equal(parseNudityConfig({ threshold: '0.85' }).threshold, 0.85);
    assert.equal(parseNudityConfig({ threshold: '0.2' }).threshold, 0.7);
    assert.equal(parseNudityConfig({ threshold: 'abc' }).threshold, 0.7);
});

test('nudity classes are checked against the active model', () => {
    assert.deepEqual(nudityModelClasses('nsfwjs', ['porn', ' Sexy', 'unknown', 'Porn'].map(value => value.trim())), ['Porn', 'Sexy']);
    assert.deepEqual(nudityModelClasses('nsfwjs', ['nothing']), ['Porn', 'Hentai']);
    assert.deepEqual(nudityModelClasses('nudenet', ['Porn']), ['MALE_GENITALIA_EXPOSED', 'FEMALE_GENITALIA_EXPOSED', 'FEMALE_BREAST_EXPOSED', 'ANUS_EXPOSED', 'BUTTOCKS_EXPOSED']);
    assert.deepEqual(nudityModelClasses('nudenet', ['male_genitalia_exposed']), ['MALE_GENITALIA_EXPOSED']);
    assert.deepEqual(nudityModelClasses('bumble', []), ['Lewd']);
});

test('router serves the nsfwjs models itself and announces them in /api/config', async t => {
    const { app, close } = await appWith({ nudityThreshold: '0.8', nudityClasses: 'Porn', nudityModelDir: join(tmpdir(), 'og-no-models'), nudityBuiltInModels: false });
    t.after(close);
    const config = (await app.inject({ method: 'GET', url: '/api/config' })).json();
    assert.equal(config.nudity.model, 'nsfwjs');
    assert.equal(config.nudity.kind, 'nsfwjs');
    assert.equal(config.nudity.combine, 'sum');
    assert.equal(config.nudity.threshold, 0.8);
    assert.deepEqual(config.nudity.classes, ['Porn']);
    assert.equal(config.nudity.size, 224);
    assert.match(config.nudity.library, /^\/vendor\/nsfwjs\/[\d.]+\/nsfwjs\.min\.js$/);
    assert.deepEqual(Object.keys(config.nudity.models).sort(), ['nsfwjs', 'nsfwjs-inception', 'nsfwjs-mid'], 'optional models only when installed');

    const library = await app.inject({ method: 'GET', url: config.nudity.library });
    assert.equal(library.statusCode, 200);
    assert.match(library.headers['content-type'], /javascript/);

    // Alle drei: Manifest + jedes Gewichte-Teil, Groesse passt zum Manifest.
    assert.equal(config.nudity.models['nsfwjs-inception'].size, 299);
    assert.equal(config.nudity.models['nsfwjs-mid'].type, 'graph');
    for (const model of Object.values(config.nudity.models)) {
        const response = await app.inject({ method: 'GET', url: `${model.modelUrl}model.json` });
        assert.equal(response.statusCode, 200);
        const manifest = response.json();
        assert.ok(manifest.modelTopology);
        let expected = 0;
        let actual = 0;
        for (const group of manifest.weightsManifest) {
            expected += group.weights.reduce((sum, entry) => {
                const count = entry.shape.reduce((product, value) => product * value, 1);
                const bytes = entry.quantization ? { uint8: 1, uint16: 2, float16: 2 }[entry.quantization.dtype] : 4;
                return sum + count * bytes;
            }, 0);
            for (const path of group.paths) {
                const shard = await app.inject({ method: 'GET', url: `${model.modelUrl}${path}` });
                assert.equal(shard.statusCode, 200, path);
                actual += shard.rawPayload.length;
            }
        }
        assert.equal(actual, expected, model.modelUrl);
    }
    assert.equal((await app.inject({ method: 'GET', url: `${config.nudity.modelUrl}nope` })).statusCode, 404);
});

test('optional models (bumble, nudenet) are served from NUDITY_MODEL_DIR', async t => {
    const directory = optionalModels();
    const { app, close } = await appWith({ nudityModel: 'nudenet', nudityModelDir: directory });
    t.after(async () => { await close(); rmSync(directory, { recursive: true, force: true }); });
    const config = (await app.inject({ method: 'GET', url: '/api/config' })).json();
    assert.equal(config.nudity.model, 'nudenet');
    assert.equal(config.nudity.kind, 'nudenet');
    assert.equal(config.nudity.combine, 'max');
    assert.ok(config.nudity.classes.includes('MALE_GENITALIA_EXPOSED'));
    assert.equal(config.nudity.classes.includes('FACE_MALE'), false);
    assert.deepEqual(Object.keys(config.nudity.models).sort(), ['bumble', 'nsfwjs', 'nsfwjs-inception', 'nsfwjs-mid', 'nudenet']);

    const onnx = await app.inject({ method: 'GET', url: config.nudity.modelUrl });
    assert.equal(onnx.statusCode, 200);
    assert.equal(onnx.body, 'onnx');
    for (const file of ['ort.wasm.min.js', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
        const response = await app.inject({ method: 'GET', url: `${config.nudity.runtimeUrl}${file}` });
        assert.equal(response.statusCode, 200, file);
    }
    assert.equal(config.nudity.library, `${config.nudity.runtimeUrl}ort.wasm.min.js`);

    const bumble = config.nudity.models.bumble;
    assert.equal(bumble.size, 480);
    assert.deepEqual(bumble.defaultClasses, ['Lewd']);
    assert.match(bumble.library, /^\/vendor\/tfjs\/[\d.]+\/tf\.es2017\.min\.js$/);
    assert.equal((await app.inject({ method: 'GET', url: bumble.library })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: `${bumble.modelUrl}model.json` })).statusCode, 200);
    assert.deepEqual([...(await app.inject({ method: 'GET', url: `${bumble.modelUrl}group1-shard1of1.bin` })).rawPayload], [1, 2, 3]);
    assert.equal((await app.inject({ method: 'GET', url: `${bumble.modelUrl}LICENSE` })).statusCode, 404, 'only files from the manifest');
});

test('the converted Bumble model in models/ is served completely', async t => {
    const { app, close } = await appWith({ nudityModel: 'bumble', nudityModelDir: join(tmpdir(), 'og-no-models') });
    t.after(close);
    const config = (await app.inject({ method: 'GET', url: '/api/config' })).json();
    assert.equal(config.nudity.model, 'bumble');
    assert.deepEqual(config.nudity.classes, ['Lewd']);
    const manifest = (await app.inject({ method: 'GET', url: `${config.nudity.modelUrl}model.json` })).json();
    assert.equal(manifest.format, 'graph-model');
    let expected = 0;
    let actual = 0;
    for (const group of manifest.weightsManifest) {
        expected += group.weights.reduce((sum, entry) => {
            const count = entry.shape.reduce((product, value) => product * value, 1);
            const bytes = entry.quantization ? { uint8: 1, uint16: 2, float16: 2 }[entry.quantization.dtype] : { float32: 4, int32: 4 }[entry.dtype];
            return sum + count * bytes;
        }, 0);
        for (const path of group.paths) actual += (await app.inject({ method: 'GET', url: `${config.nudity.modelUrl}${path}` })).rawPayload.length;
    }
    assert.equal(actual, expected);
});

test('a selected but missing optional model falls back to nsfwjs', async t => {
    const directory = optionalModels({ bumble: false, nudenet: false });
    const { app, close } = await appWith({ nudityModel: 'bumble', nudityModelDir: directory, nudityBuiltInModels: false });
    t.after(async () => { await close(); rmSync(directory, { recursive: true, force: true }); });
    const config = (await app.inject({ method: 'GET', url: '/api/config' })).json();
    assert.equal(config.nudity.model, 'nsfwjs');
    assert.deepEqual(config.nudity.classes, ['Porn', 'Hentai']);
});

test('only the nudity worker may compile WebAssembly', async t => {
    const { app, close } = await appWith({});
    t.after(close);
    const worker = await app.inject({ method: 'GET', url: '/client/app/nudity-worker.js' });
    assert.match(worker.headers['content-security-policy'], /script-src 'self' 'wasm-unsafe-eval'/);
    const page = await app.inject({ method: 'GET', url: '/' });
    assert.doesNotMatch(page.headers['content-security-policy'], /wasm-unsafe-eval/);
});

test('NUDITY_MODEL=off: no model routes, config says off', async t => {
    const { app, close } = await appWith({ nudityModel: 'off' });
    t.after(close);
    const config = (await app.inject({ method: 'GET', url: '/api/config' })).json();
    assert.deepEqual(config.nudity, { model: 'off' });
});
