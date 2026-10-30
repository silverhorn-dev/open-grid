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
        Number, Math, Map, Set, WeakSet, WeakMap,
        createImageBitmap: async canvas => ({ score: canvas.score, close() {} }),
        window: { confirm: () => true }
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

test('a viewer without canvas clicks (snap viewer) can reveal a blurred image itself', async () => {
    const { context } = loadNudity();
    context.state.nudityFilter = true;
    const canvas = fakeCanvas();
    let redraws = 0;
    assert.equal(context.revealBlurredImage(canvas), false, 'nothing blurred yet');
    context.drawBlurredImage(canvas, { width: 800, height: 600 }, 'snap-blob', () => { redraws += 1; });
    assert.equal(context.revealBlurredImage(canvas), true);
    assert.equal(redraws, 1);
    assert.equal(canvas.dataset.nudityBlurred, undefined);
    assert.equal(context.revealBlurredImage(canvas), false, 'only once');
    context.registerNudityClassifier({ id: 'fake', classify: async () => 1 });
    assert.equal(await context.shouldBlurImage({}, 'snap-blob'), false, 'stays revealed');
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

test('warning before sending: on by default, asks only on a hit, never blocks when the check fails', async () => {
    const { context, records } = loadNudity();
    await context.loadNuditySettings();
    assert.equal(context.state.nudityWarnBeforeSend, true, 'on by default');
    let asked = [];
    context.window.confirm = message => { asked.push(message); return false; };
    assert.equal(await context.confirmNudeSend([{ score: 0.9 }]), true, 'no model, no question');
    context.registerNudityClassifier({ id: 'fake', classify: async bitmap => { if (bitmap.score === 'fail') throw new Error('no wasm'); return bitmap.score; } });
    assert.equal(await context.confirmNudeSend([{ score: 0.1 }]), true, 'harmless: sent without a question');
    assert.equal(asked.length, 0);
    assert.equal(await context.confirmNudeSend([{ score: 0.9 }]), false, 'hit: asks, "cancel" stops sending');
    assert.equal(asked[0], context.t('nudity.sendWarningOne'));
    context.window.confirm = message => { asked.push(message); return true; };
    assert.equal(await context.confirmNudeSend([{ score: 0.9 }, { score: 0.1 }, { score: 0.95 }]), true);
    assert.equal(asked.at(-1), context.t('nudity.sendWarningMany', { count: 2, total: 3 }));
    asked = [];
    assert.equal(await context.confirmNudeSend([{ score: 'fail' }]), true, 'a failed check never blocks sending');
    assert.equal(asked.length, 0);

    await context.updateNudityWarnBeforeSend(false);
    assert.equal(records.get('nudity-settings').warnBeforeSend, false);
    assert.equal(await context.confirmNudeSend([{ score: 0.99 }]), true, 'switched off');
    const operator = loadNudity({ defaults: { nudityWarnBeforeSend: false } });
    await operator.context.loadNuditySettings();
    assert.equal(operator.context.state.nudityWarnBeforeSend, false, 'operator default applies');
});

test('mandatory scan (router choice): forced filter, marked images from under-18s, own flag when sending', async () => {
    const { context } = loadNudity();
    context.registerNudityClassifier({ id: 'fake', classify: async bitmap => bitmap.score });
    context.state.nudityFilter = false;
    const mode = (required, ageGroup) => {
        context.state.appConfig = { nudity: { required } };
        context.state.ageGroup = ageGroup;
    };

    mode('off', 'minor');
    assert.equal(context.nudityScanForced(), false);
    assert.equal(await context.shouldBlurImage({ score: 0.9 }, 'a'), false, 'own choice: off');

    mode('minors', 'adult');
    assert.equal(context.nudityScanForced(), false, 'adults keep their choice');
    mode('minors', 'minor');
    assert.equal(context.nudityScanForced(), true);
    assert.equal(await context.shouldBlurImage({ score: 0.9 }, 'b'), 'nude', 'under 18: always checked');
    assert.equal(context.outgoingNudityScanFlag(), false, 'flag only in minor-chats');

    mode('minor-chats', 'minor');
    assert.equal(context.outgoingNudityScanFlag(), true, 'images from under-18s carry the flag');
    mode('minor-chats', 'adult');
    assert.equal(context.nudityScanForced(), false);
    assert.equal(await context.shouldBlurImage({ score: 0.9 }, 'c'), false, 'normal images: own choice');
    context.markForcedNudityScan('from-minor');
    assert.equal(await context.shouldBlurImage({ score: 0.9 }, 'from-minor'), 'nude', 'images from under-18s: always checked');

    mode('everyone', null);
    assert.equal(context.nudityScanForced(), true);
});

test('a redraw while an image is still being checked joins the running check instead of queueing it again', async () => {
    const { context } = loadNudity({ stored: { id: 'nudity-settings', enabled: true } });
    await context.loadNuditySettings();
    let calls = 0;
    let finish;
    context.registerNudityClassifier({ id: 'slow', classify: () => { calls += 1; return new Promise(resolve => { finish = resolve; }); } });
    const first = context.shouldBlurImage({}, 'img-a');
    const second = context.shouldBlurImage({}, 'img-a');
    await new Promise(resolve => setTimeout(resolve, 0));
    finish(0.1);
    assert.deepEqual([await first, await second], [false, false]);
    assert.equal(calls, 1, 'one check for both draws');
    assert.equal(await context.shouldBlurImage({}, 'img-a'), false);
    assert.equal(calls, 1, 'afterwards from the cache');
});
