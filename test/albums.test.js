import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

async function createIdentity() {
    const keyPair = await globalThis.crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
    return { keyPair, jwkPublic: await globalThis.crypto.subtle.exportKey('jwk', keyPair.publicKey) };
}

function loadAlbums({ identity = null, peerKeys = {}, time = { now: 3 * 60000 + 1000, epochMs: 60000 } } = {}) {
    const sent = [];
    const records = new Map();
    const clock = { ...time };
    const context = {
        state: {
            myProfile: { id: 'me', gallery: [{ id: 'img_public', version: 1 }] },
            albums: {
                alb_1: {
                    id: 'alb_1',
                    ownerId: 'me',
                    name: 'Urlaub',
                    items: [{ id: 'albimg_a', version: 1 }],
                    acl: ['peer-allowed'],
                    secret: Buffer.alloc(32, 7).toString('base64'),
                    keyVersion: 1
                }
            },
            albumViewer: null,
            albumKeys: {},
            albumKeyPushes: {},
            albumKeyPushTimer: null,
            pendingAlbumRequests: {},
            pendingImageRequests: {},
            myKeys: identity
        },
        getPeerIdentityKey: async peerId => peerKeys[peerId] || null,
        databaseRequest: async (store, _mode, run) => run({ get: id => records.get(`${store}:${id}`) }),
        window: { crypto: globalThis.crypto },
        bytesToBase64: bytes => Buffer.from(bytes).toString('base64'),
        base64ToBytes: value => new Uint8Array(Buffer.from(value, 'base64')),
        TextEncoder,
        TextDecoder,
        setTimeout,
        clearTimeout,
        isSafeInlineImage: value => typeof value === 'string' && value.startsWith('data:image/'),
        loadMedia: async id => (id === 'albimg_a' ? { data: 'data:image/jpeg;base64,AAAA', version: 1 } : null),
        cacheMediaPayload: async (id, payload) => records.set(`media:${id}`, payload),
        fetchServerTime: async () => {
            const epoch = Math.floor(clock.now / clock.epochMs);
            return { now: clock.now, epochMs: clock.epochMs, epoch, epochEndsAt: (epoch + 1) * clock.epochMs };
        },
        isGalleryVisibleTo: () => true,
        logDebug: () => {},
        logBackgroundError: () => () => {},
        sendSecurePayload: async (peerId, payload) => sent.push({ peerId, payload }),
        putDatabaseRecord: async (store, value) => records.set(`${store}:${value.id}`, value),
        deleteDatabaseRecord: async (store, id) => records.delete(`${store}:${id}`),
        getAllDatabaseRecords: async store => [...records.entries()]
            .filter(([key]) => key.startsWith(`${store}:`))
            .map(([, value]) => value),
        renderMediaModalMessage: () => {},
        renderAlbumManager: () => {},
        document: { getElementById: () => null },
        Date
    };
    vm.runInNewContext(readFileSync(new URL('../client/app/albums.js', import.meta.url), 'utf8'), context);
    return { context, sent, records, clock };
}

test('serves album images only to peers on the access list', () => {
    const { context } = loadAlbums();
    assert.equal(context.canPeerAccessImage('peer-allowed', 'albimg_a'), true);
    assert.equal(context.canPeerAccessImage('peer-other', 'albimg_a'), false);
    assert.equal(context.canPeerAccessImage('peer-other', 'img_public'), true);
    assert.equal(context.canPeerAccessImage('peer-allowed', 'unknown'), false);
});

test('answers album requests according to the access list', async () => {
    const { context, sent } = loadAlbums();
    await context.handleAlbumRequest('peer-allowed', 'alb_1');
    await context.handleAlbumRequest('peer-other', 'alb_1');
    await context.handleAlbumRequest('peer-allowed', 'alb_missing');
    assert.equal(sent[0].payload.type, 'ALBUM_RESPONSE');
    assert.deepEqual(JSON.parse(JSON.stringify(sent[0].payload.album)), {
        id: 'alb_1',
        name: 'Urlaub',
        keyVersion: 1,
        items: [{ id: 'albimg_a', version: 1 }]
    });
    assert.equal(sent[1].payload.type, 'ALBUM_DENIED');
    assert.equal(sent[2].payload.type, 'ALBUM_DENIED');
});

test('revoking access blocks further image requests and notifies the peer', async () => {
    const { context, sent } = loadAlbums();
    await context.revokeAlbumAccess('alb_1', 'peer-allowed');
    assert.equal(context.canPeerAccessImage('peer-allowed', 'albimg_a'), false);
    assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1))), { peerId: 'peer-allowed', payload: { type: 'ALBUM_REVOKED', albumId: 'alb_1' } });
});

test('accepts only requested album responses and drops revoked albums', async () => {
    const { context, records } = loadAlbums();
    await context.handleAlbumResponse('peer-owner', { album: { id: 'alb_x', name: 'Fremd', items: [] } });
    assert.equal(context.state.albums.alb_x, undefined);

    context.state.pendingAlbumRequests['peer-owner:alb_x'] = true;
    await context.handleAlbumResponse('peer-owner', {
        album: { id: 'alb_x', name: 'Fremd', items: [{ id: 'albimg_x', version: 2 }, { id: 5 }] }
    });
    assert.equal(context.state.albums.alb_x.ownerId, 'peer-owner');
    assert.equal(context.state.albums.alb_x.items.length, 1);
    assert.equal(context.findReceivedAlbumItem('peer-owner', 'albimg_x').version, 2);
    assert.equal(context.findReceivedAlbumItem('peer-other', 'albimg_x'), undefined);

    // Ein anderer Peer kann das Album nicht entfernen, nur der Besitzer.
    await context.forgetReceivedAlbum('peer-other', 'alb_x');
    assert.ok(context.state.albums.alb_x);
    await context.forgetReceivedAlbum('peer-owner', 'alb_x');
    assert.equal(context.state.albums.alb_x, undefined);
    assert.equal(records.has('albums:alb_x'), false);
});

test('albums v2: own key + source key + rolling source key, current and next epoch', async () => {
    const [ownerIdentity, viewerIdentity, strangerIdentity] = await Promise.all([createIdentity(), createIdentity(), createIdentity()]);
    const owner = loadAlbums({ identity: ownerIdentity, peerKeys: { 'peer-allowed': viewerIdentity.jwkPublic } });
    await owner.context.serveAlbumImage('peer-allowed', 'albimg_a');
    const encrypted = owner.sent.at(-1).payload.encrypted;

    await owner.context.pushAlbumKeys('peer-allowed', owner.context.state.albums.alb_1);
    const operation = owner.sent.at(-1).payload.operation;
    assert.equal(operation.type, 'ALBUM_KEYS');
    assert.deepEqual([...operation.bundles.map(bundle => bundle.epoch)], [3, 4], 'current + next epoch');
    assert.equal(JSON.stringify(operation).includes('AAAA'), false, 'no image data in the bundle');
    const sentCount = owner.sent.length;
    await owner.context.pushAlbumKeys('peer-allowed', owner.context.state.albums.alb_1);
    assert.equal(owner.sent.length, sentCount, 'no second push in the same epoch');

    const receivedAlbum = { id: 'alb_1', ownerId: 'peer-owner', name: 'Urlaub', keyVersion: 1, items: [{ id: 'albimg_a', version: 1 }] };
    const viewer = loadAlbums({ identity: viewerIdentity, peerKeys: { 'peer-owner': ownerIdentity.jwkPublic } });
    viewer.context.state.albums = { alb_1: receivedAlbum };
    assert.equal(await viewer.context.handleAlbumKeysOperation('peer-owner', operation), true);
    assert.equal(await viewer.context.loadAlbumKeys('alb_1'), true);
    assert.equal(await viewer.context.decryptAlbumImage('alb_1', 'albimg_a', encrypted), 'data:image/jpeg;base64,AAAA');

    // Naechste Epoche: das vorab gelieferte Buendel reicht, der Besitzer muss nicht online sein.
    viewer.clock.now = 4 * 60000 + 1000;
    viewer.context.expireAlbumKeys('alb_1', false);
    assert.equal(await viewer.context.loadAlbumKeys('alb_1'), true);
    assert.ok(await viewer.context.decryptAlbumImage('alb_1', 'albimg_a', encrypted));

    // Danach ist Schluss, bis neue Buendel kommen.
    viewer.clock.now = 5 * 60000 + 1000;
    viewer.context.expireAlbumKeys('alb_1', false);
    assert.equal(await viewer.context.loadAlbumKeys('alb_1'), false);
    assert.equal(await viewer.context.decryptAlbumImage('alb_1', 'albimg_a', encrypted), null);

    // Ein Dritter mit eigenem Schluessel kann das Buendel nicht oeffnen.
    const stranger = loadAlbums({ identity: strangerIdentity, peerKeys: { 'peer-owner': ownerIdentity.jwkPublic } });
    stranger.context.state.albums = { alb_1: { ...receivedAlbum } };
    await stranger.context.handleAlbumKeysOperation('peer-owner', operation);
    assert.equal(await stranger.context.loadAlbumKeys('alb_1'), false);

    // Buendel eines anderen Absenders gelten nicht fuer dieses Album.
    const spoofed = loadAlbums({ identity: viewerIdentity, peerKeys: { 'peer-evil': ownerIdentity.jwkPublic } });
    spoofed.context.state.albums = { alb_1: { ...receivedAlbum } };
    await spoofed.context.handleAlbumKeysOperation('peer-evil', operation);
    assert.equal(await spoofed.context.loadAlbumKeys('alb_1'), false);
    viewer.context.expireAlbumKeys('alb_1', false);
});

test('the owner sets key lifetime and epochs ahead per album', async () => {
    const [ownerIdentity, viewerIdentity] = await Promise.all([createIdentity(), createIdentity()]);
    const quarter = 15 * 60000;
    const owner = loadAlbums({ identity: ownerIdentity, peerKeys: { 'peer-allowed': viewerIdentity.jwkPublic }, time: { now: 10 * quarter + 5000, epochMs: 60000 } });
    const album = owner.context.state.albums.alb_1;
    album.keyEpochMinutes = 15;
    album.keyEpochsAhead = 2;
    await owner.context.serveAlbumImage('peer-allowed', 'albimg_a');
    const encrypted = owner.sent.at(-1).payload.encrypted;
    await owner.context.pushAlbumKeys('peer-allowed', album);
    const { bundles } = owner.sent.at(-1).payload.operation;
    assert.deepEqual([...bundles.map(bundle => bundle.epoch)], [10, 11, 12], 'current + 2 ahead in 15 min epochs');
    assert.ok(bundles.every(bundle => bundle.epochMs === quarter));
    assert.equal(bundles[0].epochEndsAt, 11 * quarter);

    const viewer = loadAlbums({ identity: viewerIdentity, peerKeys: { 'peer-owner': ownerIdentity.jwkPublic }, time: { now: 12 * quarter + 1000, epochMs: 60000 } });
    viewer.context.state.albums = { alb_1: { id: 'alb_1', ownerId: 'peer-owner', name: 'Urlaub', keyVersion: 1, items: [{ id: 'albimg_a', version: 1 }] } };
    await viewer.context.handleAlbumKeysOperation('peer-owner', owner.sent.at(-1).payload.operation);
    assert.equal(await viewer.context.loadAlbumKeys('alb_1'), true, 'third bundle covers 30-45 min later');
    assert.ok(await viewer.context.decryptAlbumImage('alb_1', 'albimg_a', encrypted));
    viewer.context.expireAlbumKeys('alb_1', false);
    viewer.clock.now = 13 * quarter + 1000;
    assert.equal(await viewer.context.loadAlbumKeys('alb_1'), false);

    // Neue Alben uebernehmen den Standard aus den Einstellungen.
    owner.context.state.albumDefaults = { epochMinutes: 1440, epochsAhead: 3 };
    owner.context.document = { getElementById: id => (id === 'new-album-name' ? { value: 'Neu' } : null) };
    await owner.context.createAlbum();
    const created = Object.values(owner.context.state.albums).find(entry => entry.name === 'Neu');
    assert.equal(created.keyEpochMinutes, 1440);
    assert.equal(created.keyEpochsAhead, 3);
});

test('revoking access bumps the album key version', async () => {
    const { context } = loadAlbums();
    await context.revokeAlbumAccess('alb_1', 'peer-allowed');
    assert.equal(context.state.albums.alb_1.keyVersion, 2);
    const keyBefore = await context.deriveAlbumImageKey({ ...context.state.albums.alb_1, keyVersion: 1 }, 'albimg_a', 'peer-x');
    const keyAfter = await context.deriveAlbumImageKey(context.state.albums.alb_1, 'albimg_a', 'peer-x');
    const raw = async key => Buffer.from(await globalThis.crypto.subtle.exportKey('raw', key)).toString('hex');
    assert.notEqual(await raw(keyBefore), await raw(keyAfter));
});

test('album records are sealed at rest and old plaintext records get migrated', async () => {
    const { context, records } = loadAlbums();
    const key = await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    context.state.storageKey = key;
    context.encryptStoredProfile = async value => {
        const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
        const ciphertext = await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(value)));
        return { iv: Buffer.from(iv).toString('base64'), ciphertext: Buffer.from(ciphertext).toString('base64') };
    };
    context.decryptStoredProfile = async sealed => JSON.parse(new TextDecoder().decode(await globalThis.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: Buffer.from(sealed.iv, 'base64') }, key, Buffer.from(sealed.ciphertext, 'base64'))));

    // Alter Klartext-Datensatz mit Geheimnis.
    records.set('albums:alb_1', { ...context.state.albums.alb_1 });
    await context.loadAlbums();
    const stored = records.get('albums:alb_1');
    assert.ok(stored.sealed, 'record is sealed after loading');
    assert.equal(JSON.stringify(stored).includes(context.state.albums.alb_1.secret), false, 'secret no longer in clear text');
    assert.equal(stored.secret, undefined);

    // Erneut laden: entschluesselt wieder dasselbe Album.
    context.state.albums = {};
    await context.loadAlbums();
    assert.equal(context.state.albums.alb_1.name, 'Urlaub');
    assert.equal(context.state.albums.alb_1.secret, Buffer.alloc(32, 7).toString('base64'));
});
