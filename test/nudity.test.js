import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { I18N_STUBS } from './i18n-stubs.js';

function loadNudity({ stored = null, defaults = {} } = {}) {
    const records = new Map(stored ? [['nudity-settings', stored]] : []);
    const context = {
        state: {},
        document: { getElementById: () => null },
        databaseRequest: async (_store, _mode, run) => run({ get: id => records.get(id) }),
        putDatabaseRecord: async (_store, value) => records.set(value.id, value),
        clientDefault: (key, fallback) => (key in defaults ? defaults[key] : fallback),
        showToast: () => {},
        logDebug: () => {},
        Number, Math, Map, Set, WeakSet
    };
    vm.runInNewContext(readFileSync(new URL('../client/app/nudity.js', import.meta.url), 'utf8'), Object.assign(context, I18N_STUBS));
    return { context, records };
}

function fakeCanvas() {
    const calls = [];
    const listeners = [];
    const context2d = new Proxy({}, {
        get: (_target, name) => (typeof name === 'string' && ['drawImage', 'fillRect', 'fillText'].includes(name) ? (...args) => calls.push([name, ...args]) : undefined),
        set: (_target, name, value) => { calls.push([`set:${String(name)}`, value]); return true; }
    });
    return {
        width: 800, height: 600, dataset: {}, calls, listeners,
        getContext: () => context2d,
        setAttribute() {},
        addEventListener: (type, handler, capture) => listeners.push({ type, handler, capture })
    };
}

test('filter is off by default, the operator default and the own choice apply', async () => {
    const plain = loadNudity();
    await plain.context.loadNuditySettings();
    assert.equal(plain.context.state.nudityFilter, false);

    const operator = loadNudity({ defaults: { nudityFilter: true } });
    await operator.context.loadNuditySettings();
    assert.equal(operator.context.state.nudityFilter, true);

    const own = loadNudity({ stored: { id: 'nudity-settings', enabled: false }, defaults: { nudityFilter: true } });
    await own.context.loadNuditySettings();
    assert.equal(own.context.state.nudityFilter, false, 'own choice wins');
    await own.context.updateNudityFilter(true);
    assert.equal(own.records.get('nudity-settings').enabled, true);
});

test('without a model nothing is blurred, with a model above the threshold only', async () => {
    const { context } = loadNudity();
    context.state.nudityFilter = true;
    assert.equal(await context.shouldBlurImage({}, 'data:image/jpeg;base64,AA'), false, 'no classifier installed');

    let calls = 0;
    assert.equal(context.registerNudityClassifier({ id: 'fake', classify: async bitmap => { calls += 1; return bitmap.score; } }), true);
    assert.equal(context.registerNudityClassifier({ id: 'broken' }), false);
    assert.equal(await context.shouldBlurImage({ score: 0.95 }, 'nude'), 'nude');
    assert.equal(await context.shouldBlurImage({ score: 0.2 }, 'beach'), false);
    assert.equal(await context.shouldBlurImage({ score: 0.95 }, 'nude'), 'nude');
    assert.equal(calls, 2, 'scores are cached per image');

    context.state.nudityFilter = false;
    assert.equal(await context.shouldBlurImage({ score: 0.95 }, 'other'), false, 'switched off');
});

test('a failing model blurs as "not checked" and retries next time; the highest score of several models wins', async () => {
    const { context } = loadNudity();
    context.state.nudityFilter = true;
    let attempts = 0;
    context.registerNudityClassifier({ id: 'broken', classify: async () => { attempts += 1; throw new Error('no wasm'); } });
    assert.equal(await context.shouldBlurImage({}, 'a'), 'unchecked', 'fail closed instead of showing unchecked images');
    assert.equal(await context.shouldBlurImage({}, 'a'), 'unchecked');
    assert.equal(attempts, 2, 'a failure is not cached');
    context.registerNudityClassifier({ id: 'good', classify: async () => 0.8 });
    assert.equal(await context.shouldBlurImage({}, 'a'), 'nude');
    context.registerNudityClassifier({ id: 'low', classify: async () => 0.1 });
    assert.equal(await context.shouldBlurImage({}, 'b'), 'nude', 'one working model with a hit is enough');
});

test('blurred images are revealed by a tap that does not reach other click handlers', async () => {
    const { context } = loadNudity();
    context.state.nudityFilter = true;
    context.registerNudityClassifier({ id: 'fake', classify: async () => 1 });
    const canvas = fakeCanvas();
    let redraws = 0;
    context.drawBlurredImage(canvas, { width: 800, height: 600 }, 'nude', () => { redraws += 1; });
    assert.equal(canvas.dataset.nudityBlurred, 'true');
    assert.ok(canvas.calls.some(([name, text]) => name === 'fillText' && text === context.t('nudity.mightBeNude')));
    const unchecked = fakeCanvas();
    context.drawBlurredImage(unchecked, { width: 800, height: 600 }, 'x', () => {}, 'unchecked');
    assert.ok(unchecked.calls.some(([name, text]) => name === 'fillText' && text === context.t('nudity.notChecked')), 'says it could not be checked');
    assert.ok(canvas.calls.some(([name, value]) => name === 'set:filter' && String(value).startsWith('blur(')));
    assert.equal(canvas.listeners.length, 1);
    assert.equal(canvas.listeners[0].capture, true, 'runs before the viewer click handler');

    let stopped = false;
    canvas.listeners[0].handler({ preventDefault() {}, stopImmediatePropagation() { stopped = true; } });
    assert.equal(stopped, true);
    assert.equal(redraws, 1);
    assert.equal(canvas.dataset.nudityBlurred, undefined);
    assert.equal(await context.shouldBlurImage({}, 'nude'), false, 'revealed images stay visible, e.g. in the viewer');

    context.drawBlurredImage(canvas, { width: 800, height: 600 }, 'nude2', () => {});
    assert.equal(canvas.listeners.length, 1, 'one listener per canvas');
});
