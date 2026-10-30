import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, test } from 'node:test';
import { buildApp, renderFeatureBlocks } from '../server/app.js';
import { createStore } from '../server/database.js';

const apps = [];
afterEach(async () => {
    while (apps.length) {
        const { app, store } = apps.pop();
        await app.close();
        store.close();
    }
});

async function startApp(options = {}) {
    const store = createStore(':memory:');
    const app = await buildApp({ store, buildVersion: 'x', buildTimestamp: 'y', nudityModelDir: join(tmpdir(), 'og-no-models'), ...options });
    apps.push({ app, store });
    return app;
}

const get = async (app, url) => app.inject({ method: 'GET', url });
const FEATURE_FILES = {
    nudity: ['client/app/nudity.js', 'client/app/nudity-model.js'],
    safety: ['client/app/safety.js'],
    agetest: ['client/app/age-test.js']
};

test('switched off parts are not shipped: no markup, no script, 404', async () => {
    const app = await startApp({ nudityModel: 'off', ageEudiTest: 'false' });
    const config = (await get(app, '/api/config')).json();
    assert.deepEqual(config.features, []);
    const html = (await get(app, '/')).body;
    for (const marker of ['safety-modal', 'safety-card', 'age-test-card', 'nudity-filter-toggle', 'nudity-test-input', 'app/safety.js', 'app/nudity.js', 'app/nudity-model.js', 'app/age-test.js', 'feature:']) {
        assert.equal(html.includes(marker), false, marker);
    }
    assert.ok(html.includes('app/features.js'), 'placeholders are always there');
    for (const file of ['safety.js', 'nudity.js', 'nudity-model.js', 'nudity-worker.js', 'age-test.js']) {
        assert.equal((await get(app, `/client/app/${file}`)).statusCode, 404, file);
    }
    const serviceWorker = (await get(app, '/sw.js')).body;
    for (const file of ['safety.js', 'nudity.js', 'nudity-worker.js', 'age-test.js']) assert.equal(serviceWorker.includes(`/client/app/${file}?`), false, `not precached: ${file}`);
    assert.ok(serviceWorker.includes('/client/app/features.js?'));
});

test('switched on parts are shipped with their markup', async () => {
    const app = await startApp({ safety: { ageCheck: 'confirm' } });
    assert.deepEqual((await get(app, '/api/config')).json().features.sort(), ['agetest', 'nudity', 'safety']);
    const html = (await get(app, '/')).body;
    for (const marker of ['id="safety-modal"', 'id="safety-card"', 'id="age-test-card"', 'id="nudity-filter-toggle"', 'app/safety.js', 'app/nudity.js', 'app/age-test.js']) {
        assert.ok(html.includes(marker), marker);
    }
    assert.equal(html.includes('feature:'), false, 'markers are removed');
    assert.equal((await get(app, '/client/app/safety.js')).statusCode, 200);
    assert.equal((await get(app, '/client/app/nudity-worker.js')).statusCode, 200);
});

test('feature blocks in index.html are balanced and strip cleanly', () => {
    const template = readFileSync('index.html', 'utf8');
    const opened = [...template.matchAll(/<!-- feature:([a-z]+) -->/g)].map(match => match[1]);
    const closed = [...template.matchAll(/<!-- \/feature:([a-z]+) -->/g)].map(match => match[1]);
    assert.deepEqual(opened, closed);
    assert.deepEqual([...new Set(opened)].sort(), Object.keys(FEATURE_FILES).sort());
    const all = renderFeatureBlocks(template, new Set(Object.keys(FEATURE_FILES)));
    assert.equal(all.includes('feature:'), false);
    const none = renderFeatureBlocks(template, new Set());
    assert.equal(none.includes('feature:'), false);
    // Gleich viele <div> und </div>: keine halben Bloecke.
    const count = (text, pattern) => (text.match(pattern) || []).length;
    assert.equal(count(none, /<div\b/g), count(none, /<\/div>/g));
    assert.equal(count(none, /<label\b/g), count(none, /<\/label>/g));
});

test('every function the rest of the app calls from a switchable part has a placeholder', () => {
    const placeholders = readFileSync('client/app/features.js', 'utf8');
    const featureFiles = new Set(Object.values(FEATURE_FILES).flat());
    const others = [
        ...readdirSync('client').filter(file => file.endsWith('.js')).map(file => `client/${file}`),
        ...readdirSync('client/app').filter(file => file.endsWith('.js')).map(file => `client/app/${file}`)
    ].filter(file => !featureFiles.has(file) && !file.endsWith('features.js') && !file.endsWith('sw.js') && !file.endsWith('admin.js') && !file.endsWith('nudity-worker.js'));
    const sources = others.map(file => readFileSync(file, 'utf8').replace(/\/\/.*$/gm, ''));
    for (const file of featureFiles) {
        const names = [...readFileSync(file, 'utf8').matchAll(/^(?:async )?function ([A-Za-z0-9_]+)/gm)].map(match => match[1]);
        for (const name of names) {
            const used = sources.some(source => new RegExp(`(?<!typeof )\\b${name}\\b(?! === 'function')`).test(source)
                && !new RegExp(`typeof ${name} === 'function'`).test(source));
            if (used) assert.match(placeholders, new RegExp(`function ${name}\\(`), `${name} (${file}) needs a placeholder in features.js`);
        }
    }
});
