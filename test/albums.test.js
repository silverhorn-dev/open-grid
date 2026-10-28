import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { I18N_STUBS } from './i18n-stubs.js';

async function createIdentity() {
    const keyPair = await globalThis.crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
    return { keyPair, jwkPublic: await globalThis.crypto.subtle.exportKey('jwk', keyPair.publicKey) };
}

function loadAlbums({ identity = null, peerKeys = {}, signingKeys = {}, withSwarm = false, time = { now: 3 * 60000 + 1000, epochMs: 60000 } } = {}) {
    const openChannels = new Set();
    const swarmRequests = [];
    const sent = [];
    const records = new Map();
    const clock = { ...time };
    const context = {
        // Hinweise je Art (push.js) laufen hier ueber showToast, das einzelne Tests setzen.
        notifyInApp: (kind, message, type) => context.showToast?.(message, type),
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
        getPeerIdentity: async peerId => (signingKeys[peerId] ? { profileSigningKey: signingKeys[peerId] } : null),
        isSecureChannelOpen: peerId => openChannels.has(peerId),
        isTraceWatermarkEnabled: () => true,
        requestAlbumFromSwarm: () => {},
        requestAlbumImageFromSwarm: async (album, item) => swarmRequests.push(item.id),
        signEnvelope: async (payload, privateKey, publicKey) => ({
            payload,
            publicKey,
            signature: Buffer.from(await globalThis.crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, new TextEncoder().encode(JSON.stringify(payload)))).toString('base64')
        }),
        verifyEnvelope: async (envelope, expected) => Boolean(expected) && JSON.stringify(envelope.publicKey) === JSON.stringify(expected)
            && globalThis.crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' },
                await globalThis.crypto.subtle.importKey('jwk', expected, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']),
                Buffer.from(envelope.signature, 'base64'), new TextEncoder().encode(JSON.stringify(envelope.payload))),
        databaseRequest: async (store, _mode, run) => run({ get: id => records.get(`${store}:${id}`) }),
        window: { crypto: globalThis.crypto },
        bytesToBase64: bytes => Buffer.from(bytes).toString('base64'),
        base64ToBytes: value => new Uint8Array(Buffer.from(value, 'base64')),
        TextEncoder,
        TextDecoder,
        setTimeout,
        clearTimeout,
        isSafeInlineImage: value => typeof value === 'string' && value.startsWith('data:image/'),
        loadMedia: async id => records.get(`media:${id}`) || (id === 'albimg_a' && !withSwarm ? { data: 'data:image/jpeg;base64,AAAA', version: 1 } : null),
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
        isSocialMode: () => false,
        document: { getElementById: () => null },
        Date
    };
    vm.runInNewContext(readFileSync(new URL('../client/app/albums.js', import.meta.url), 'utf8'), Object.assign(context, I18N_STUBS));
    if (withSwarm) {
        Object.assign(context.state, { dataChannels: {}, pendingSwarmImages: {}, pendingSwarmAlbums: {}, cachedProfiles: {} });
        context.sha256Base64 = async text => Buffer.from(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))).toString('base64');
        context.cacheMedia = async (id, data, version) => records.set(`media:${id}`, { data, version });
        context.isProfileShareable = profile => !profile?.audience || profile.audience === 'public';
        vm.runInNewContext(readFileSync(new URL('../client/app/swarm.js', import.meta.url), 'utf8'), Object.assign(context, I18N_STUBS));
    }
    return { context, sent, records, clock, openChannels, swarmRequests };
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
        updatedAt: 0,
        watermark: true,
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

test('key lifetime can be set per person, one week included', async () => {
    const [ownerIdentity, weekIdentity, otherIdentity] = await Promise.all([createIdentity(), createIdentity(), createIdentity()]);
    const week = 10080 * 60000;
    const hour = 60 * 60000;
    const now = 3 * week + 5000;
    const owner = loadAlbums({
        identity: ownerIdentity,
        peerKeys: { 'peer-allowed': weekIdentity.jwkPublic, 'peer-other': otherIdentity.jwkPublic },
        time: { now, epochMs: 60000 }
    });
    const album = owner.context.state.albums.alb_1;
    album.acl = ['peer-allowed', 'peer-other'];
    album.keyEpochMinutes = 60;
    album.viewerKeyEpochs = { 'peer-allowed': 10080 };
    await owner.context.serveAlbumImage('peer-allowed', 'albimg_a');
    const encrypted = owner.sent.at(-1).payload.encrypted;

    await owner.context.pushAlbumKeys('peer-allowed', album);
    const weekBundles = owner.sent.at(-1).payload.operation.bundles;
    assert.ok(weekBundles.every(bundle => bundle.epochMs === week), 'this person gets one-week keys');
    assert.equal(weekBundles[0].epochEndsAt, 4 * week);
    await owner.context.pushAlbumKeys('peer-other', album);
    const hourBundles = owner.sent.at(-1).payload.operation.bundles;
    assert.ok(hourBundles.every(bundle => bundle.epochMs === hour), 'everyone else keeps the album setting');
    assert.ok(Object.keys(album.rollingKeys).some(key => key.startsWith(`${week}:`)) && Object.keys(album.rollingKeys).some(key => key.startsWith(`${hour}:`)),
        'rolling keys of different lengths do not collide');

    // Beide koennen entschluesseln; die Wochen-Person auch noch Tage spaeter.
    for (const [identity, operation, later] of [[weekIdentity, owner.sent.at(-2).payload.operation, now + 3 * 24 * hour], [otherIdentity, owner.sent.at(-1).payload.operation, now + 30 * 60000]]) {
        const viewer = loadAlbums({ identity, peerKeys: { 'peer-owner': ownerIdentity.jwkPublic }, time: { now: later, epochMs: 60000 } });
        viewer.context.state.albums = { alb_1: { id: 'alb_1', ownerId: 'peer-owner', name: 'Urlaub', keyVersion: 1, items: [{ id: 'albimg_a', version: 1 }] } };
        await viewer.context.handleAlbumKeysOperation('peer-owner', operation);
        assert.equal(await viewer.context.loadAlbumKeys('alb_1'), true);
        assert.ok(await viewer.context.decryptAlbumImage('alb_1', 'albimg_a', encrypted));
        viewer.context.expireAlbumKeys('alb_1', false);
    }

    // Zurueck auf "wie Album" und Zugang entziehen raeumt die Einstellung weg. (Ohne den Push-Timer
    // fuer alle Alben, der wuerde den Testlauf bis zum naechsten Epochenende offen halten.)
    owner.context.pushAllAlbumKeys = async () => {};
    await owner.context.updateViewerKeyTiming('alb_1', 'peer-allowed', 0);
    assert.equal(album.viewerKeyEpochs['peer-allowed'], undefined);
    album.viewerKeyEpochs = { 'peer-other': 10080 };
    await owner.context.revokeAlbumAccess('alb_1', 'peer-other');
    assert.equal(owner.context.state.albums.alb_1.viewerKeyEpochs['peer-other'], undefined);
});

test('limited sharing: views are counted per opening, time limits cap the keys, both end in a revoke', async () => {
    const [ownerIdentity, viewerIdentity] = await Promise.all([createIdentity(), createIdentity()]);
    const hour = 60 * 60000;
    const owner = loadAlbums({ identity: ownerIdentity, peerKeys: { 'peer-allowed': viewerIdentity.jwkPublic }, time: { now: 10 * hour + 5000, epochMs: hour } });
    // Kein Timer bis zum Ende der Begrenzung (der wuerde den Testlauf offen halten).
    owner.context.scheduleAlbumLimitCheck = () => {};
    const toasts = [];
    owner.context.showToast = message => toasts.push(message);
    owner.context.getPeerPresentation = () => ({ name: 'Bob' });
    const album = owner.context.state.albums.alb_1;
    album.keyEpochMinutes = 1440;
    album.keyEpochsAhead = 2;

    // 2x ansehen: keine Schluessel vorab.
    album.limits = { 'peer-allowed': { kind: 'views', views: 2, used: 0 } };
    const before = owner.sent.length;
    await owner.context.pushAlbumKeys('peer-allowed', album, true);
    assert.equal(owner.sent.length, before, 'no keys in advance for view-limited people');

    // Oeffnen = Anfrage: eine Ansicht, Schluessel nur fuer 15 Minuten.
    await owner.context.handleAlbumKeyRequest('peer-allowed', { albumId: 'alb_1', viewId: 'view-a' });
    let bundles = owner.sent.at(-1).payload.operation.bundles;
    assert.equal(bundles.length, 1, 'only the current window');
    assert.equal(bundles[0].session, true);
    assert.equal(bundles[0].epochEndsAt, owner.clock.now + 15 * 60000);
    assert.equal(album.limits['peer-allowed'].used, 1);

    // Erneute Anfrage in derselben Ansicht zaehlt nicht.
    await owner.context.handleAlbumKeyRequest('peer-allowed', { albumId: 'alb_1', viewId: 'view-a' });
    assert.equal(owner.context.state.albums.alb_1.limits['peer-allowed'].used, 1);
    // Neu laden und wieder oeffnen (neue viewId) ist eine neue Ansicht, auch vor Ablauf der alten.
    await owner.context.handleAlbumKeyRequest('peer-allowed', { albumId: 'alb_1', viewId: 'view-b' });
    assert.equal(owner.context.state.albums.alb_1.limits['peer-allowed'].used, 2, 'reload counts');
    assert.equal(owner.context.state.albums.alb_1.limits['peer-allowed'].viewId, 'view-b');
    album.limits['peer-allowed'] = { kind: 'views', views: 2, used: 1, sessionEndsAt: owner.clock.now + 60000, viewId: 'view-a' };

    // Schliesst Bob das Album, ist die Ansicht vorbei: das naechste Oeffnen zaehlt sofort.
    await owner.context.handleAlbumViewClosed('peer-allowed', { albumId: 'alb_1' });
    assert.equal(owner.context.state.albums.alb_1.limits['peer-allowed'].sessionEndsAt, owner.clock.now);
    assert.equal(owner.context.state.albums.alb_1.acl.includes('peer-allowed'), true, 'one view left');
    owner.clock.now += 1000;
    await owner.context.handleAlbumKeyRequest('peer-allowed', { albumId: 'alb_1' });
    assert.equal(owner.context.state.albums.alb_1.limits['peer-allowed'].used, 2);
    owner.clock.now += 16 * 60000;
    await owner.context.handleAlbumKeyRequest('peer-allowed', { albumId: 'alb_1' });
    assert.equal(owner.sent.at(-1).payload.type, 'ALBUM_REVOKED', 'all views used: access revoked');
    assert.ok(toasts.some(text => text.includes('Bob') && text.includes('fertig angesehen')), 'owner is told');
    const revoke = owner.sent.at(-2).payload;
    assert.equal(revoke.type, 'CHAT_OPERATION', 'revoke also goes as a chat operation (Path C when offline)');
    assert.deepEqual([revoke.operation.type, revoke.operation.albumId, revoke.operation.actorId], ['ALBUM_REVOKE', 'alb_1', 'me']);
    assert.equal(owner.context.state.albums.alb_1.acl.includes('peer-allowed'), false);
    assert.equal(owner.context.state.albums.alb_1.limits['peer-allowed'], undefined);

    // 1 h verfuegbar: Schluessel enden mit der Frist, auch bei Tages-Epochen und Vorab-Epochen.
    const timed = owner.context.state.albums.alb_1;
    timed.acl = ['peer-allowed'];
    timed.limits = { 'peer-allowed': { kind: 'time', until: owner.clock.now + hour } };
    await owner.context.pushAlbumKeys('peer-allowed', timed, true);
    bundles = owner.sent.at(-1).payload.operation.bundles;
    assert.equal(bundles.length, 1, 'no epochs after the deadline');
    assert.equal(bundles[0].epochEndsAt, owner.clock.now + hour);
    assert.equal(bundles[0].session, undefined);
    owner.clock.now += hour + 1000;
    await owner.context.enforceAlbumLimits();
    assert.equal(owner.context.state.albums.alb_1.acl.includes('peer-allowed'), false, 'deadline passed: access revoked');

});

test('revoking access bumps the album key version', async () => {
    const { context } = loadAlbums();
    await context.revokeAlbumAccess('alb_1', 'peer-allowed');
    assert.equal(context.state.albums.alb_1.keyVersion, 2);
    const keyBefore = await context.deriveAlbumImageKey({ ...context.state.albums.alb_1, keyVersion: 1 }, 'albimg_a');
    const keyAfter = await context.deriveAlbumImageKey(context.state.albums.alb_1, 'albimg_a');
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

async function createSigningIdentity() {
    const ecdh = await createIdentity();
    const ecdsa = await globalThis.crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    return { ...ecdh, ecdsaKeyPair: ecdsa, jwkEcdsaPublic: await globalThis.crypto.subtle.exportKey('jwk', ecdsa.publicKey) };
}

test('a viewer relays an album to another viewer while the owner is offline', async () => {
    const [ownerId, relayId, requesterId] = await Promise.all([createSigningIdentity(), createSigningIdentity(), createSigningIdentity()]);
    const owner = loadAlbums({ identity: ownerId, peerKeys: { 'peer-c': relayId.jwkPublic, 'peer-b': requesterId.jwkPublic } });
    owner.context.state.myKeys = ownerId;
    owner.context.state.albums.alb_1.acl = ['peer-c', 'peer-b'];
    owner.records.set('media:albimg_a', { data: 'data:image/jpeg;base64,AAAA', version: 1 });

    // C hat das Album vom Besitzer (Manifest + Bild + Schluessel).
    const relay = loadAlbums({ identity: relayId, withSwarm: true, peerKeys: { 'peer-owner': ownerId.jwkPublic }, signingKeys: { 'peer-owner': ownerId.jwkEcdsaPublic } });
    relay.context.state.myProfile.id = 'peer-c';
    relay.context.state.albums = {};
    owner.context.state.myProfile.id = 'peer-owner';
    owner.context.state.albums.alb_1.ownerId = 'peer-owner';
    await owner.context.handleAlbumRequest('peer-c', 'alb_1');
    relay.context.state.pendingAlbumRequests['peer-owner:alb_1'] = true;
    await relay.context.handleAlbumResponse('peer-owner', owner.sent.at(-1).payload);
    assert.ok(relay.context.state.albums.alb_1.manifest, 'signed manifest kept');
    await owner.context.serveAlbumImage('peer-c', 'albimg_a');
    relay.context.state.pendingImageRequests['peer-owner:albimg_a'] = 1;
    await relay.context.handleAlbumImageResponse('peer-owner', owner.sent.at(-1).payload);
    await owner.context.pushAlbumKeys('peer-c', owner.context.state.albums.alb_1, true);
    await relay.context.handleAlbumKeysOperation('peer-owner', owner.sent.at(-1).payload.operation);
    await owner.context.pushAlbumKeys('peer-b', owner.context.state.albums.alb_1, true);
    const keysForB = owner.sent.at(-1).payload.operation;

    // B kennt das Album nur aus dem Chat; der Besitzer ist offline, C antwortet.
    const requester = loadAlbums({ identity: requesterId, withSwarm: true, peerKeys: { 'peer-owner': ownerId.jwkPublic }, signingKeys: { 'peer-owner': ownerId.jwkEcdsaPublic } });
    requester.context.state.myProfile.id = 'peer-b';
    requester.context.state.albums = {};
    requester.context.identifyWatermark = async () => ({ peerId: 'peer-b' });
    await requester.context.handleAlbumKeysOperation('peer-owner', keysForB);
    const ticket = await requester.context.loadAlbumTicket('alb_1');
    assert.equal(ticket.payload.viewerId, 'peer-b', 'owner signed a ticket for B');

    // Ohne Ticket oder mit dem Ticket eines anderen gibt C nichts heraus (Zweitaccount).
    const before = relay.sent.length;
    await relay.context.handleSwarmAlbumRequest('peer-sock', { ownerId: 'peer-owner', albumId: 'alb_1', ticket });
    await relay.context.handleSwarmAlbumImageRequest('peer-sock', { ownerId: 'peer-owner', albumId: 'alb_1', imageId: 'albimg_a', version: 1, ticket });
    assert.equal(relay.sent.length, before, 'ticket belongs to B, not to the asking peer');

    requester.context.state.pendingSwarmAlbums['peer-c:alb_1'] = 'peer-owner';
    await relay.context.handleSwarmAlbumRequest('peer-b', { ownerId: 'peer-owner', albumId: 'alb_1', ticket });
    const albumReply = relay.sent.at(-1).payload;
    assert.equal(albumReply.type, 'SWARM_ALBUM_RESPONSE');
    await requester.context.handleSwarmAlbumResponse('peer-c', albumReply);
    assert.equal(requester.context.state.albums.alb_1.name, 'Urlaub');

    requester.context.state.pendingSwarmImages['peer-c:albimg_a'] = { ownerId: 'peer-owner', albumId: 'alb_1', version: 1 };
    await relay.context.handleSwarmAlbumImageRequest('peer-b', { ownerId: 'peer-owner', albumId: 'alb_1', imageId: 'albimg_a', version: 1, ticket });
    const imageReply = relay.sent.at(-1).payload;
    assert.equal(imageReply.type, 'SWARM_ALBUM_IMAGE_RESPONSE');

    // Eine Kopie ohne das eigene Wasserzeichen wird verworfen.
    requester.context.identifyWatermark = async () => ({ peerId: 'peer-c' });
    await requester.context.handleSwarmAlbumImageResponse('peer-c', imageReply);
    assert.equal(requester.records.has('media:albimg_a'), false, 'watermark of someone else');
    requester.context.identifyWatermark = async () => ({ peerId: 'peer-b' });
    requester.context.state.pendingSwarmImages['peer-c:albimg_a'] = { ownerId: 'peer-owner', albumId: 'alb_1', version: 1 };
    await requester.context.handleSwarmAlbumImageResponse('peer-c', imageReply);
    const stored = requester.records.get('media:albimg_a');
    assert.equal(stored.relayedBy, 'peer-c');

    // Ansehen nur mit den Schluesseln des Besitzers.
    assert.equal(await requester.context.loadAlbumKeys('alb_1'), true);
    assert.equal(await requester.context.decryptAlbumImage('alb_1', 'albimg_a', stored.encrypted), 'data:image/jpeg;base64,AAAA');
    requester.context.expireAlbumKeys('alb_1', false);
    relay.context.expireAlbumKeys('alb_1', false);
});

test('swarm answers that are forged or unrequested are dropped', async () => {
    const [ownerId, forgerId] = await Promise.all([createSigningIdentity(), createSigningIdentity()]);
    const requester = loadAlbums({ withSwarm: true, signingKeys: { 'peer-owner': ownerId.jwkEcdsaPublic } });
    requester.context.state.albums = {};
    const manifestPayload = { id: 'alb_9', ownerId: 'peer-owner', name: 'Fake', keyVersion: 1, updatedAt: 1, items: [] };
    const forged = await requester.context.signEnvelope(manifestPayload, forgerId.ecdsaKeyPair.privateKey, forgerId.jwkEcdsaPublic);
    requester.context.state.pendingSwarmAlbums['peer-x:alb_9'] = 'peer-owner';
    await requester.context.handleSwarmAlbumResponse('peer-x', { ownerId: 'peer-owner', albumId: 'alb_9', manifest: forged });
    assert.equal(requester.context.state.albums.alb_9, undefined, 'not signed by the owner');

    const genuine = await requester.context.signEnvelope(manifestPayload, ownerId.ecdsaKeyPair.privateKey, ownerId.jwkEcdsaPublic);
    await requester.context.handleSwarmAlbumResponse('peer-x', { ownerId: 'peer-owner', albumId: 'alb_9', manifest: genuine });
    assert.equal(requester.context.state.albums.alb_9, undefined, 'not requested (request was used up)');

    // Galerie: Kopie muss zum signierten Hash passen.
    const data = 'data:image/jpeg;base64,BBBB';
    requester.context.state.cachedProfiles['peer-owner'] = { gallery: [{ id: 'img_1', version: 2, sha256: await requester.context.sha256Base64(data) }] };
    requester.context.state.pendingSwarmImages['peer-x:img_1'] = { ownerId: 'peer-owner', version: 2 };
    await requester.context.handleSwarmImageResponse('peer-x', { ownerId: 'peer-owner', imageId: 'img_1', version: 2, data: 'data:image/jpeg;base64,CCCC' });
    assert.equal(requester.records.has('media:img_1'), false, 'hash mismatch');
    requester.context.state.pendingSwarmImages['peer-x:img_1'] = { ownerId: 'peer-owner', version: 2 };
    await requester.context.handleSwarmImageResponse('peer-x', { ownerId: 'peer-owner', imageId: 'img_1', version: 2, data });
    assert.equal(requester.records.get('media:img_1').data, data);
});

