import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { I18N_STUBS } from './i18n-stubs.js';

const bytesToBase64 = bytes => Buffer.from(bytes).toString('base64');
const base64ToBytes = text => new Uint8Array(Buffer.from(text, 'base64'));

function loadTransfer({ nodeId = 'node_new', stores = {}, local = {} } = {}) {
    const data = Object.fromEntries(['localProfile', 'profiles', 'messages', 'chatOperations', 'keys', 'media', 'albums', 'statusUpdates']
        .map(name => [name, new Map((stores[name] || []).map(record => [record.id ?? record.slot ?? record.operationId, record]))]));
    const storage = new Map(Object.entries(local));
    const localStorage = {
        get length() { return storage.size; },
        key: index => [...storage.keys()][index] ?? null,
        getItem: key => (storage.has(key) ? storage.get(key) : null),
        setItem: (key, value) => storage.set(key, String(value))
    };
    const keyOf = record => record.id ?? record.slot ?? record.operationId;
    const context = {
        state: { nodeId, storageKey: { fake: true }, myProfile: { id: nodeId }, myKeys: { jwkPublic: { x: 'pub' }, jwkEcdsaPublic: { x: 'sig' } } },
        window: { crypto: globalThis.crypto, localStorage },
        db: {},
        TextEncoder, TextDecoder, Blob, Response, CompressionStream, DecompressionStream, JSON,
        bytesToBase64, base64ToBytes,
        // Versiegeln im Test: lesbares JSON statt AES (die Logik drumherum ist, was zaehlt).
        encryptStoredProfile: async plain => ({ ciphertext: Buffer.from(JSON.stringify(plain)).toString('base64'), iv: 'iv' }),
        decryptStoredProfile: async sealed => JSON.parse(Buffer.from(sealed.ciphertext, 'base64').toString()),
        getAllDatabaseRecords: async name => [...data[name].values()],
        putDatabaseRecord: async (name, value) => data[name].set(keyOf(value), value),
        databaseRequest: async (name, _mode, run) => run({ clear: () => data[name].clear() }),
        cacheOwnProfile: async () => true,
        logDebug: () => {}
    };
    vm.runInNewContext(readFileSync(new URL('../client/app/transfer.js', import.meta.url), 'utf8'), Object.assign(context, I18N_STUBS));
    return { context, data, storage };
}

test('only device-independent key records and local settings travel', () => {
    const { context } = loadTransfer();
    assert.equal(context.transferKeepsKeyRecord({ id: 'identity-key' }), false);
    assert.equal(context.transferKeepsKeyRecord({ id: 'router-auth', token: 'x' }), false);
    assert.equal(context.transferKeepsKeyRecord({ id: 'profile-cache' }), false);
    assert.equal(context.transferKeepsKeyRecord({ id: 'snap-settings', views: 1 }), true);
    class CryptoKey {}
    assert.equal(context.containsCryptoKey({ id: 'session', key: new CryptoKey() }), true);
    assert.equal(context.transferKeepsLocalKey('opengrid-theme'), true);
    assert.equal(context.transferKeepsLocalKey('opengrid-node-id'), false);
    assert.equal(context.transferKeepsLocalKey('opengrid-router-auth-token'), false);
    assert.equal(context.transferKeepsLocalKey('hiddenByPeers'), true);
    assert.equal(context.transferKeepsLocalKey('somethingElse'), false);
});

test('rewrites the old node id everywhere, also inside composite ids', () => {
    const { context } = loadTransfer();
    const rewritten = context.rewriteTransferIds({ senderId: 'node_old', id: 'put:node_old:1', list: ['node_old', 'node_peer'] }, 'node_old', 'node_new');
    assert.deepEqual(JSON.parse(JSON.stringify(rewritten)), { senderId: 'node_new', id: 'put:node_new:1', list: ['node_new', 'node_peer'] });
});

test('seals and opens a bundle with a password key (gzip round trip)', async () => {
    const { context } = loadTransfer();
    const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
    const key = await context.transferKeyFromPassword('correct horse', salt, 1000);
    const bundle = { format: 'opengrid-transfer', version: 1, nodeId: 'node_old', stores: { messages: [{ id: 'm1', text: 'hallo'.repeat(200) }] } };
    const sealed = await context.sealTransferBundle(bundle, key);
    assert.equal(sealed.gzip, true);
    assert.ok(!sealed.ciphertext.includes('hallo'));
    assert.deepEqual(JSON.parse(JSON.stringify(await context.openTransferBundle(sealed, key))), bundle);
    const wrong = await context.transferKeyFromPassword('wrong', salt, 1000);
    await assert.rejects(context.openTransferBundle(sealed, wrong));
});

test('collects, unseals and re-applies data under the new node id', async () => {
    const seal = plain => ({ ciphertext: Buffer.from(JSON.stringify(plain)).toString('base64'), iv: 'iv' });
    const old = loadTransfer({
        nodeId: 'node_old',
        stores: {
            localProfile: [{ slot: 'current', version: 3, ...seal({ id: 'node_old', isMe: true, version: 3, fields: { displayName: 'Alt' } }) }],
            messages: [{ id: 'm1', peerId: 'node_peer', senderId: 'node_old', text: 'hi' }],
            albums: [{ id: 'alb1', sealed: seal({ id: 'alb1', ownerId: 'node_old', items: [] }) }],
            keys: [{ id: 'identity-key', privateKey: 'secret' }, { id: 'router-auth', token: 't' }, { id: 'snap-settings', views: 2 }]
        },
        local: { 'opengrid-theme': 'dark', 'opengrid-node-id': 'node_old', 'opengrid-router-auth-token': 'tok' }
    });
    old.context.state.myProfile.id = 'node_old';
    const bundle = JSON.parse(JSON.stringify(await old.context.collectTransferBundle()));
    assert.equal(bundle.nodeId, 'node_old');
    assert.deepEqual(bundle.stores.keys.map(record => record.id), ['snap-settings'], 'device keys stay behind');
    assert.equal(bundle.stores.localProfile[0].__plain.fields.displayName, 'Alt', 'unsealed for the trip');
    assert.equal(bundle.stores.localProfile[0].ciphertext, undefined);
    assert.deepEqual(bundle.local, { 'opengrid-theme': 'dark' });

    const fresh = loadTransfer({
        nodeId: 'node_new',
        stores: { keys: [{ id: 'identity-key', privateKey: 'new' }], messages: [{ id: 'stale', peerId: 'x' }] }
    });
    await fresh.context.applyTransferBundle(bundle);
    assert.equal(fresh.data.keys.get('identity-key').privateKey, 'new', 'own keys stay');
    assert.equal(fresh.data.keys.get('snap-settings').views, 2);
    assert.equal(fresh.data.keys.get('transfer-imported').from, 'node_old');
    assert.equal(fresh.data.messages.has('stale'), false, 'store replaced');
    assert.equal(fresh.data.messages.get('m1').senderId, 'node_new');
    const album = JSON.parse(Buffer.from(fresh.data.albums.get('alb1').sealed.ciphertext, 'base64').toString());
    assert.equal(album.ownerId, 'node_new', 'resealed with the new id');
    assert.equal(fresh.context.state.myProfile.id, 'node_new');
    assert.equal(fresh.context.state.myProfile.version, 4, 'version bumped to re-sign');
    assert.equal(fresh.storage.get('opengrid-theme'), 'dark');
    assert.equal(fresh.storage.has('opengrid-router-auth-token'), false);
    await assert.rejects(fresh.context.applyTransferBundle({ format: 'nope' }), /format/);
});

test('transfer codes round-trip through base64url and are found inside links', () => {
    const { context } = loadTransfer();
    const key = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const code = `AAAAAAAAAAAAAAAAAAAAAA.${context.toBase64Url(key)}`;
    assert.match(code, /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
    const parsed = context.parseTransferCode(`https://grid.example/transfer#${code}`);
    assert.equal(parsed.id, 'AAAAAAAAAAAAAAAAAAAAAA');
    assert.deepEqual([...parsed.key], [...key]);
    assert.equal(context.parseTransferCode('kein code'), null);
});
