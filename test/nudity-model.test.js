import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../server/app.js';
import { createStore } from '../server/database.js';
import { parseNudityConfig } from '../server/nudity-model.js';

async function appWith(options) {
    const store = createStore(':memory:');
    const app = await buildApp({ store, buildVersion: 'test', buildTimestamp: '2026-10-29T00:00:00.000Z', ...options });
    return { app, close: async () => { await app.close(); store.close(); } };
}

test('nudity config: defaults, off, threshold range and known classes only', () => {
    assert.deepEqual(parseNudityConfig({}), { model: 'nsfwjs', threshold: 0.7, classes: ['Porn', 'Hentai'] });
    assert.equal(parseNudityConfig({ model: 'OFF' }).model, 'off');
    assert.equal(parseNudityConfig({ model: 'nsfwjs-inception' }).model, 'nsfwjs-inception');
    assert.equal(parseNudityConfig({ model: 'nsfwjs-mid' }).model, 'nsfwjs-mid');
    assert.equal(parseNudityConfig({ model: 'unknown' }).model, 'nsfwjs');
    assert.equal(parseNudityConfig({ threshold: '0.85' }).threshold, 0.85);
    assert.equal(parseNudityConfig({ threshold: '0.2' }).threshold, 0.7);
    assert.equal(parseNudityConfig({ threshold: 'abc' }).threshold, 0.7);
    assert.deepEqual(parseNudityConfig({ classes: 'porn, Sexy,unknown,Porn' }).classes, ['Porn', 'Sexy']);
    assert.deepEqual(parseNudityConfig({ classes: 'nothing' }).classes, ['Porn', 'Hentai']);
});

test('router serves the nudity model itself and announces it in /api/config', async t => {
    const { app, close } = await appWith({ nudityThreshold: '0.8', nudityClasses: 'Porn' });
    t.after(close);
    const config = (await app.inject({ method: 'GET', url: '/api/config' })).json();
    assert.equal(config.nudity.model, 'nsfwjs');
    assert.equal(config.nudity.threshold, 0.8);
    assert.deepEqual(config.nudity.classes, ['Porn']);
    assert.equal(config.nudity.size, 224);
    assert.match(config.nudity.library, /^\/vendor\/nsfwjs\/[\d.]+\/nsfwjs\.min\.js$/);

    const library = await app.inject({ method: 'GET', url: config.nudity.library });
    assert.equal(library.statusCode, 200);
    assert.match(library.headers['content-type'], /javascript/);

    // Alle drei Modelle: Manifest + jedes Gewichte-Teil, Groesse passt zum Manifest.
    assert.deepEqual(Object.keys(config.nudity.models).sort(), ['nsfwjs', 'nsfwjs-inception', 'nsfwjs-mid']);
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

test('NUDITY_MODEL picks the active model', async t => {
    const { app, close } = await appWith({ nudityModel: 'nsfwjs-inception' });
    t.after(close);
    const config = (await app.inject({ method: 'GET', url: '/api/config' })).json();
    assert.equal(config.nudity.model, 'nsfwjs-inception');
    assert.equal(config.nudity.size, 299);
    assert.match(config.nudity.modelUrl, /\/inception_v3\/$/);
});

test('NUDITY_MODEL=off: no model routes, config says off', async t => {
    const { app, close } = await appWith({ nudityModel: 'off' });
    t.after(close);
    const config = (await app.inject({ method: 'GET', url: '/api/config' })).json();
    assert.deepEqual(config.nudity, { model: 'off' });
});
