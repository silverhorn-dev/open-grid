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

    const model = await app.inject({ method: 'GET', url: `${config.nudity.modelUrl}model.json` });
    assert.equal(model.statusCode, 200);
    const manifest = model.json();
    assert.ok(manifest.modelTopology);
    assert.deepEqual(manifest.weightsManifest[0].paths, ['group1-shard1of1']);
    const weights = await app.inject({ method: 'GET', url: `${config.nudity.modelUrl}group1-shard1of1` });
    assert.equal(weights.statusCode, 200);
    const expectedBytes = manifest.weightsManifest[0].weights.reduce((sum, entry) => {
        const count = entry.shape.reduce((product, value) => product * value, 1);
        const bytes = entry.quantization ? { uint8: 1, uint16: 2, float16: 2 }[entry.quantization.dtype] : 4;
        return sum + count * bytes;
    }, 0);
    assert.equal(weights.rawPayload.length, expectedBytes);
});

test('NUDITY_MODEL=off: no model routes, config says off', async t => {
    const { app, close } = await appWith({ nudityModel: 'off' });
    t.after(close);
    const config = (await app.inject({ method: 'GET', url: '/api/config' })).json();
    assert.deepEqual(config.nudity, { model: 'off' });
});
