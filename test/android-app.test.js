import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import vm from 'node:vm';
import { buildApp } from '../server/app.js';
import { buildAssetLinks, createApkSource, normalizeSignerFingerprint, parseAppSigners } from '../server/android-app.js';
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

const HEX = 'a1'.repeat(32);
const COLON = Array(32).fill('A1').join(':');

test('signer fingerprints are normalized to the assetlinks notation', () => {
    assert.equal(normalizeSignerFingerprint(HEX), COLON);
    assert.equal(normalizeSignerFingerprint(COLON.toLowerCase()), COLON);
    assert.equal(normalizeSignerFingerprint('a1'.repeat(20)), null, 'SHA-1 length is rejected');
    assert.equal(normalizeSignerFingerprint('zz'.repeat(32)), null);
    assert.deepEqual(parseAppSigners(''), []);
    assert.deepEqual(parseAppSigners(null), []);
    assert.deepEqual(parseAppSigners(`${HEX}, ${COLON}`), [COLON], 'comma text, duplicates removed');
    assert.deepEqual(parseAppSigners(`["${HEX}"]`), [COLON]);
    assert.throws(() => parseAppSigners('["nope"]'), /invalid SHA-256/);
    assert.throws(() => parseAppSigners('{"a":1}'), /list/);
    assert.equal(buildAssetLinks([]), null);
    assert.deepEqual(buildAssetLinks([COLON])[0].target, { namespace: 'android_app', package_name: 'org.opengrid.app', sha256_cert_fingerprints: [COLON] });
});

test('the router serves the APK with its version, or 404 without one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'og-apk-'));
    const apkPath = join(dir, 'opengrid.apk');
    const missing = await startApp({ androidApkPath: apkPath, androidAppSigners: HEX });
    assert.equal((await missing.inject({ method: 'GET', url: '/app/opengrid.apk' })).statusCode, 404);
    assert.deepEqual((await missing.inject({ method: 'GET', url: '/api/config' })).json().android, { available: false, signers: [COLON] });

    writeFileSync(apkPath, Buffer.from('PK fake apk'));
    writeFileSync(`${apkPath}.json`, JSON.stringify({ versionCode: 3, versionName: '0.3.0' }));
    const app = await startApp({ androidApkPath: apkPath });
    const download = await app.inject({ method: 'GET', url: '/app/opengrid.apk' });
    assert.equal(download.statusCode, 200);
    assert.equal(download.headers['content-type'], 'application/vnd.android.package-archive');
    assert.equal(download.body, 'PK fake apk');
    const android = (await app.inject({ method: 'GET', url: '/api/config' })).json().android;
    assert.equal(android.available, true);
    assert.equal(android.versionCode, 3);
    assert.equal(android.versionName, '0.3.0');
    assert.equal(android.url, '/app/opengrid.apk');
    assert.match(android.sha256, /^[0-9a-f]{64}$/);
});

test('APK metadata is cached and refreshed after the TTL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'og-apk-'));
    const apkPath = join(dir, 'opengrid.apk');
    let clock = 0;
    const source = createApkSource(apkPath, { now: () => clock });
    assert.equal((await source.publicInfo()).available, false);
    writeFileSync(apkPath, 'x');
    assert.equal((await source.publicInfo()).available, false, 'still cached');
    clock += 61 * 1000;
    const info = await source.publicInfo();
    assert.equal(info.available, true);
    assert.equal(info.versionCode, null, 'no metadata file');
});

// ----- Bruecke (client/app/native.js) -----

const nativeSource = readFileSync(new URL('../client/app/native.js', import.meta.url), 'utf8');
const bridgeSource = readFileSync(new URL('../android/app/src/main/java/org/opengrid/app/Bridge.kt', import.meta.url), 'utf8');

function kotlinList(name) {
    const match = bridgeSource.match(new RegExp(`val ${name} = listOf\\(([^)]*)\\)`));
    assert.ok(match, name);
    return [...match[1].matchAll(/"([^"]+)"/g)].map(entry => entry[1]);
}

test('bridge message types and protocol match the Android app', () => {
    const context = {};
    vm.runInNewContext(`${nativeSource}\nthis.out = { requests: NATIVE_REQUEST_TYPES, events: NATIVE_EVENT_TYPES, protocol: NATIVE_PROTOCOL_VERSION };`, context);
    assert.deepEqual([...context.out.requests], kotlinList('REQUEST_TYPES'));
    assert.deepEqual([...context.out.events], kotlinList('EVENT_TYPES'));
    assert.equal(String(context.out.protocol), bridgeSource.match(/const val PROTOCOL = (\d+)/)[1]);
});

function setupBridge(elements = []) {
    const sent = [];
    const frames = [];
    const port = { postMessage: text => sent.push(JSON.parse(text)) };
    const context = {
        window: { OpenGridNative: port },
        document: {
            body: {},
            documentElement: { classList: { add: () => {} } },
            querySelectorAll: () => elements
        },
        MutationObserver: class { observe() {} },
        requestAnimationFrame: callback => frames.push(callback),
        setTimeout: () => 0,
        clearTimeout: () => {},
        logDebug: () => {},
        JSON
    };
    vm.runInNewContext(`${nativeSource}\nthis.api = { initNativeBridge, handleNativeMessage, scheduleSecureScreenUpdate, isNativeApp, nativeCall };`, context);
    return { context, sent, frames, port, flush: () => frames.splice(0).forEach(frame => frame()) };
}

test('secure screen follows visible marked views, one call per change', () => {
    const element = { shown: false, checkVisibility() { return this.shown; } };
    const bridge = setupBridge([element]);
    bridge.context.api.initNativeBridge();
    assert.equal(bridge.context.api.isNativeApp(), true);
    bridge.flush();
    assert.deepEqual(bridge.sent.map(message => message.type), ['capabilities'], 'nothing secure shown: no call');
    element.shown = true;
    bridge.context.api.scheduleSecureScreenUpdate();
    bridge.context.api.scheduleSecureScreenUpdate();
    bridge.flush();
    const secure = bridge.sent.filter(message => message.type === 'secureScreen');
    assert.equal(secure.length, 1);
    assert.deepEqual({ ...secure[0].data }, { on: true });
    assert.equal(secure[0].v, 1);
    element.shown = false;
    bridge.context.api.scheduleSecureScreenUpdate();
    bridge.flush();
    assert.deepEqual(bridge.sent.filter(message => message.type === 'secureScreen').map(message => message.data.on), [true, false]);
});

test('bridge replies resolve the matching call, unknown types are refused', async () => {
    const bridge = setupBridge();
    bridge.context.api.initNativeBridge();
    const call = bridge.context.api.nativeCall('takeShare');
    const request = bridge.sent.at(-1);
    bridge.context.api.handleNativeMessage(JSON.stringify({ v: 1, id: request.id, ok: true, result: { text: 'hi' } }));
    assert.equal((await call).text, 'hi');
    const failing = bridge.context.api.nativeCall('secureScreen', { on: true });
    bridge.context.api.handleNativeMessage(JSON.stringify({ v: 1, id: bridge.sent.at(-1).id, ok: false, error: 'nope' }));
    await assert.rejects(failing, /nope/);
    await assert.rejects(bridge.context.api.nativeCall('readFiles'), /Unknown native call/);
    bridge.context.api.handleNativeMessage('not json');
});

test('notifications go to the app only while the page is hidden, compact by default; tapping opens the chat', async () => {
    const bridge = setupBridge();
    const opened = [];
    Object.assign(bridge.context, {
        state: { compactNotifications: null },
        t: key => key,
        databaseRequest: async () => ({ compactNotifications: false }),
        notificationEnabled: kind => kind !== 'profileView',
        chatScopeOf: () => 'discovery',
        getPeerPresentation: id => ({ name: id === 'alice' ? 'Alice' : 'Bob' }),
        messagePreview: message => message.text,
        openChatWithPeer: id => opened.push(id),
        switchTab: () => {},
        Date
    });
    vm.runInContext('this.api.notifyNative = notifyNative; this.api.notifyNativeMessage = notifyNativeMessage;', vm.createContext(bridge.context));
    // Die App bestaetigt Benachrichtigungen sofort.
    const post = bridge.port.postMessage;
    bridge.port.postMessage = text => {
        post(text);
        const message = JSON.parse(text);
        if (message.type === 'notify') queueMicrotask(() => bridge.context.api.handleNativeMessage(JSON.stringify({ v: 1, id: message.id, ok: true, result: { shown: true } })));
    };
    bridge.context.api.initNativeBridge();
    const caps = bridge.sent.find(message => message.type === 'capabilities');
    bridge.context.api.handleNativeMessage(JSON.stringify({ v: 1, id: caps.id, ok: true, result: { notifications: true } }));
    await new Promise(resolve => setImmediate(resolve));
    const notifies = () => bridge.sent.filter(message => message.type === 'notify').map(message => message.data);

    bridge.context.document.visibilityState = 'visible';
    bridge.context.api.notifyNativeMessage('alice', { senderId: 'alice', text: 'hi', createdAt: Date.now() });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(notifies().length, 0, 'visible page: in-app only');

    bridge.context.document.visibilityState = 'hidden';
    bridge.context.api.notifyNativeMessage('alice', { senderId: 'alice', text: 'hi', createdAt: Date.now() });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual({ ...notifies()[0] }, { title: 'Alice', body: 'hi', tag: 'chat-alice', peerId: 'alice' }, 'compact off: name and preview');
    bridge.context.api.notifyNativeMessage('alice', { senderId: 'alice', text: 'old', createdAt: Date.now() - 2 * 24 * 60 * 60 * 1000 });
    bridge.context.api.notifyNativeMessage('alice', { senderId: 'alice', text: 'held', held: true, createdAt: Date.now() });
    await bridge.context.api.notifyNative('profileView', { title: 'x', body: 'y' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(notifies().length, 1, 'old, held and muted kinds stay silent');

    bridge.context.state.compactNotifications = true;
    await bridge.context.api.notifyNative('match', { title: 'Match', body: 'mit Bob' });
    assert.deepEqual({ ...notifies().at(-1) }, { title: 'sw.newMessages', body: 'sw.tapToOpen', tag: 'opengrid-messages', peerId: null }, 'compact: no name or text');

    bridge.context.api.handleNativeMessage(JSON.stringify({ v: 1, event: 'openChat', data: { peerId: 'alice' } }));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(opened, ['alice']);
});

test('without the app nothing is installed', async () => {
    const context = { window: {}, document: {}, logDebug: () => {} };
    vm.runInNewContext(`${nativeSource}\ninitNativeBridge();\nthis.native = isNativeApp();`, context);
    assert.equal(context.native, false);
});

test('marked secure views exist in the markup', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    for (const id of ['profile-detail-modal', 'media-modal', 'image-viewer', 'video-viewer', 'secure-snap-viewer', 'status-viewer']) {
        assert.match(html, new RegExp(`id="${id}" data-secure-screen`), id);
    }
    const friends = readFileSync(new URL('../client/app/friends.js', import.meta.url), 'utf8');
    assert.ok(friends.includes("toggleAttribute('data-secure-screen', flirting)"), 'flirt chats are secure');
});
