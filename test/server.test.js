import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { afterEach, beforeEach, test } from 'node:test';
import { buildApp, parseAppModes, parseClientDefaults, parseMediaKeyEpochMinutes, parseProfileSchemas, resolveStunServers } from '../server/app.js';
import { createStore } from '../server/database.js';
import { decodeGeohash, encodeGeohash, geohashNeighbours } from '../server/geohash.js';

let app;
let store;
const peerTokens = new Map();
const peerSigningKeys = new Map();

function registrationPayload(peerId, registrationId, overrides = {}) {
    let signingKeys = peerSigningKeys.get(peerId);
    if (!signingKeys) {
        signingKeys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
        peerSigningKeys.set(peerId, signingKeys);
    }
    const authToken = overrides.authToken
        || peerTokens.get(peerId)
        || randomBytes(32).toString('base64url');
    const proofPayload = JSON.stringify({ peerId, registrationId, authToken });
    return {
        peerId,
        registrationId,
        geohash: 'u10j2k',
        ...overrides,
        authToken,
        registrationProof: {
            publicKey: signingKeys.publicKey.export({ format: 'jwk' }),
            signature: sign(
                'sha256',
                Buffer.from(proofPayload),
                { key: signingKeys.privateKey, dsaEncoding: 'ieee-p1363' }
            ).toString('base64')
        }
    };
}

async function registerPeer(peerId, registrationId = `registration-${peerId}`) {
    const payload = registrationPayload(peerId, registrationId);
    const response = await app.inject({
        method: 'POST',
        url: '/api/register',
        payload
    });
    assert.equal(response.statusCode, 200);
    const { authToken } = response.json();
    peerTokens.set(peerId, authToken);
    return authToken;
}

function authHeaders(peerId) {
    return { authorization: `Bearer ${peerTokens.get(peerId)}` };
}

beforeEach(async () => {
    peerTokens.clear();
    peerSigningKeys.clear();
    store = createStore(':memory:');
    app = await buildApp({
        store,
        buildVersion: 'test-build',
        buildTimestamp: '2026-10-21T00:00:00.000Z'
    });
});

afterEach(async () => {
    await app.close();
    store.close();
});

test('offers a TCP TURN transport so UDP-blocked networks can relay', async () => {
    const previousSecret = process.env.TURN_SECRET;
    const previousServer = process.env.TURN_SERVER;
    process.env.TURN_SECRET = 'a'.repeat(40);
    process.env.TURN_SERVER = 'turn.example.test';
    try {
        const response = await app.inject({ method: 'GET', url: '/api/ice-config' });
        assert.equal(response.statusCode, 200);
        assert.equal(response.json().turnEnabled, true);
        const turn = response.json().iceServers.find(server => Array.isArray(server.urls));
        assert.ok(turn, 'expected a TURN entry with multiple urls');

        // Ohne transport=tcp gibt es in UDP-blockierten Netzen keinen Relay-Pfad.
        assert.ok(turn.urls.some(url => url.endsWith('?transport=tcp')));
        assert.ok(turn.urls.some(url => url.endsWith('?transport=udp')));
        // Jede URL muss den Transport explizit benennen (RFC 7065 default waere UDP).
        assert.ok(turn.urls.every(url => url.includes('?transport=')));
        // Der coturn-Name darf nach der Ablaufzeit keinen weiteren Doppelpunkt enthalten.
        assert.equal(turn.username.split(':').length, 2);
        // STUN laeuft ueber den eigenen coturn, nicht ueber einen fremden Dienst.
        assert.deepEqual(response.json().iceServers[0], { urls: 'stun:turn.example.test:3478' });
    } finally {
        if (previousSecret === undefined) delete process.env.TURN_SECRET;
        else process.env.TURN_SECRET = previousSecret;
        if (previousServer === undefined) delete process.env.TURN_SERVER;
        else process.env.TURN_SERVER = previousServer;
    }
});

test('resolves STUN servers without leaking to third parties when avoidable', () => {
    assert.deepEqual(resolveStunServers('none', 'turn.example.test'), []);
    assert.deepEqual(resolveStunServers('stun.example.test:3478'), [{ urls: 'stun:stun.example.test:3478' }]);
    assert.deepEqual(resolveStunServers('', 'turn.example.test', '5349'), [{ urls: 'stun:turn.example.test:5349' }]);
    assert.deepEqual(resolveStunServers('', ''), [{ urls: 'stun:stun.l.google.com:19302' }]);
});

test('LAN mode hands out no STUN/TURN servers', async () => {
    const lanApp = await buildApp({ store: createStore(':memory:'), buildVersion: 'x', buildTimestamp: 'y', lanMode: 'true' });
    const ice = (await lanApp.inject({ method: 'GET', url: '/api/ice-config' })).json();
    assert.deepEqual(ice.iceServers, []);
    assert.equal(ice.lanMode, true);
    assert.equal((await lanApp.inject({ method: 'GET', url: '/api/config' })).json().lanMode, true);
    await lanApp.close();
});

test('reports that TURN is disabled when the server configuration is incomplete', async () => {
    const previousSecret = process.env.TURN_SECRET;
    const previousServer = process.env.TURN_SERVER;
    delete process.env.TURN_SECRET;
    process.env.TURN_SERVER = 'turn.example.test';
    try {
        const response = await app.inject({ method: 'GET', url: '/api/ice-config' });
        assert.equal(response.statusCode, 200);
        const body = response.json();

        // Der Client darf einen reinen STUN-Fallback nicht als TURN-Erfolg werten.
        assert.equal(body.turnEnabled, false);
        assert.match(body.reason, /TURN_SECRET/);
        assert.ok(!body.iceServers.some(server => String(server.urls).includes('turn:')));
    } finally {
        if (previousSecret === undefined) delete process.env.TURN_SECRET;
        else process.env.TURN_SECRET = previousSecret;
        if (previousServer === undefined) delete process.env.TURN_SERVER;
        else process.env.TURN_SERVER = previousServer;
    }
});

test('reports the server time and the media key epoch', async () => {
    const timedApp = await buildApp({
        store: createStore(':memory:'),
        buildVersion: 'test-build',
        buildTimestamp: '2026-10-21T00:00:00.000Z',
        mediaKeyEpochMinutes: 5,
        now: () => 1_000_000_000
    });
    const response = await timedApp.inject({ method: 'GET', url: '/api/time' });
    assert.deepEqual(response.json(), {
        now: 1_000_000_000,
        epoch: 3333,
        epochMs: 300_000,
        epochEndsAt: 1_000_200_000
    });
    await timedApp.close();

    assert.equal(parseMediaKeyEpochMinutes('180'), 180);
    assert.equal(parseMediaKeyEpochMinutes(undefined), 5);
    assert.equal(parseMediaKeyEpochMinutes('0'), 5);
    assert.equal(parseMediaKeyEpochMinutes('999999'), 10080);
});

test('serves the app offline-ready without external CDNs', async () => {
    const index = await app.inject({ method: 'GET', url: '/' });
    assert.doesNotMatch(index.body, /cdn\.tailwindcss\.com|cdnjs\.cloudflare\.com|placehold\.co/);
    assert.match(index.body, /\/client\/tailwind\.css\?v=/);
    assert.match(index.body, /\/vendor\/fontawesome\/css\/all\.min\.css/);

    const worker = await app.inject({ method: 'GET', url: '/sw.js' });
    assert.doesNotMatch(worker.body, /__ASSET_VERSION__|__PRECACHE_URLS__/);
    const precache = JSON.parse(worker.body.match(/const PRECACHE_URLS = (\[.*?\]);/)[1]);
    assert.ok(precache.includes('/'));
    assert.ok(precache.some(url => url.startsWith('/client/tailwind.css?v=')));
    assert.ok(precache.some(url => url.endsWith('.woff2')));
    assert.ok(!precache.some(url => url.endsWith('.ttf')));

    // Jede vorab gecachte Datei muss ausgeliefert werden.
    for (const url of precache) {
        const response = await app.inject({ method: 'GET', url });
        assert.equal(response.statusCode, 200, url);
    }
    assert.match(index.body, /rel="apple-touch-icon" href="\/client\/icon-180\.png"/);
    // Die Schriftgroessen-Einstellung haengt an dieser Regel.
    const styles = await app.inject({ method: 'GET', url: '/client/styles.css' });
    assert.match(styles.body, /\.chat-bubble \{\s*font-size: var\(--chat-font-size/);
    assert.match(styles.body, /#chat-messages \{\s*touch-action: pan-y/);
    const icon = await app.inject({ method: 'GET', url: '/client/icon-180.png' });
    assert.equal(icon.headers['content-type'], 'image/png');
    assert.equal(icon.rawPayload.subarray(1, 4).toString(), 'PNG');
    assert.ok(precache.includes('/client/icon-192.png'));
    const font = await app.inject({ method: 'GET', url: precache.find(url => url.endsWith('.woff2')) });
    assert.equal(font.headers['content-type'], 'font/woff2');
});

test('serves the app shell for client routes', async () => {
    for (const url of ['/grid', '/chat', '/chat/peer-a', '/profile', '/settings', '/cloud']) {
        const response = await app.inject({ method: 'GET', url });
        assert.equal(response.statusCode, 200, url);
        assert.match(response.body, /\/client\/app\/router\.js\?v=/, url);
    }
    assert.equal((await app.inject({ method: 'GET', url: '/chat/peer-a/extra' })).statusCode, 404);
});

test('serves the app shell and all client modules', async () => {
    const indexResponse = await app.inject({ method: 'GET', url: '/' });
    assert.equal(indexResponse.statusCode, 200);
    assert.match(indexResponse.body, /test-build/);
    assert.doesNotMatch(indexResponse.body, /\{\{(versionTag|timestamp|assetVersion)\}\}/);
    assert.match(indexResponse.body, /\/client\/crypto\.client\.js\?v=test-build-2026-10-21T00%3A00%3A00\.000Z/);
    assert.match(indexResponse.body, /\/client\/grid\.client\.js\?v=test-build-2026-10-21T00%3A00%3A00\.000Z/);
    assert.match(indexResponse.body, /\/client\/p2p\.client\.js\?v=test-build-2026-10-21T00%3A00%3A00\.000Z/);
    assert.match(indexResponse.body, /\/client\/app\/main\.js\?v=test-build-2026-10-21T00%3A00%3A00\.000Z/);
    assert.match(indexResponse.body, /profile-onboarding-modal/);

    // Jede im App-Shell referenzierte Datei muss vom Server ausgeliefert werden.
    const assetPaths = [...indexResponse.body.matchAll(/(?:src|href)="(\/client\/[^"?]+)\?v=/g)].map(match => match[1]);
    assert.ok(assetPaths.length >= 12);
    let appSource = '';
    for (const path of assetPaths) {
        const response = await app.inject({ method: 'GET', url: path });
        assert.equal(response.statusCode, 200, path);
        assert.match(response.headers['content-type'], path.endsWith('.css') ? /text\/css/ : path.endsWith('.svg') ? /image\/svg\+xml/ : /text\/javascript/);
        assert.ok(response.body.length > 100, path);
        appSource += response.body;
    }
    assert.match(appSource, /indexedDB\.open\('OpenGridDB_Live', 9\)/);
    assert.match(appSource, /createObjectStore\('albums'/);
    assert.match(appSource, /canPeerAccessImage\(peerId, imageId\)/);
    assert.match(appSource, /createObjectStore\('localProfile'/);
    assert.match(appSource, /createObjectStore\('chatOperations'/);
    assert.match(appSource, /putDatabaseRecord\('localProfile'/);
    assert.match(appSource, /if \(!hasLocalProfile\) await openProfileOnboarding\(\)/);
    assert.match(appSource, /id: 'identity-key'/);
    assert.match(appSource, /async function refreshChatControls\(\)/);
    assert.match(appSource, /function rememberChatPeer\(peerId\)/);

    // Seit H4 liegen Sync und Pfad C in delivery.client.js.
    const p2pClient = {
        body: (await app.inject({ method: 'GET', url: '/client/p2p.client.js' })).body
            + (await app.inject({ method: 'GET', url: '/client/delivery.client.js' })).body
    };
    assert.match(p2pClient.body, /recentOperationIds: operations\.slice\(0, 20\)/);
    assert.match(p2pClient.body, /CHAT_SYNC_INVENTORY/);
    assert.match(p2pClient.body, /fetch\(`\$\{API_BASE\}\/api\/cache`/);
    assert.match(p2pClient.body, /fetchQueuedCacheMessages/);
    assert.match(p2pClient.body, /response\.status === 403/);
    assert.match(p2pClient.body, /handleIncomingImageResponse\(peerId, payload\.imageId/);
    assert.match(p2pClient.body, /requestedVersion !== version/);
    assert.match(p2pClient.body, /finally \{\s*state\.cacheFetchInFlight = false;/);
    assert.doesNotMatch(p2pClient.body, /profile\.signedEnvelope\s*=/);
});

test('registers peers, protects newer registrations, and creates removal tombstones', async () => {
    const firstRegistration = registrationPayload('peer-a', 'registration-old', {
        thumbnail: 'encrypted-thumbnail-placeholder',
        name: 'Alice'
    });

    const firstResponse = await app.inject({
        method: 'POST',
        url: '/api/register',
        payload: firstRegistration
    });
    assert.equal(firstResponse.statusCode, 200);
    peerTokens.set('peer-a', firstResponse.json().authToken);
    const secondRegistration = registrationPayload('peer-a', 'registration-new', {
        thumbnail: 'encrypted-thumbnail-placeholder',
        name: 'Alice'
    });
    await app.inject({
        method: 'POST',
        url: '/api/register',
        payload: secondRegistration
    });

    const staleUnregister = await app.inject({
        method: 'DELETE',
        url: '/api/register?peerId=peer-a&registrationId=registration-old&geohash=u10j2k',
        headers: authHeaders('peer-a')
    });
    assert.equal(staleUnregister.json().removed, 0);

    const visibleGrid = await app.inject({
        method: 'GET',
        url: '/api/grid?geohash=u10j2k'
    });
    assert.equal(visibleGrid.json().count, 1);

    const currentUnregister = await app.inject({
        method: 'DELETE',
        url: '/api/register?peerId=peer-a&registrationId=registration-new&geohash=u10j2k',
        headers: authHeaders('peer-a')
    });
    assert.equal(currentUnregister.json().removed, 1);

    const emptyGrid = await app.inject({
        method: 'GET',
        url: '/api/grid?geohash=u10j2k'
    });
    assert.equal(emptyGrid.json().count, 0);
    assert.deepEqual(emptyGrid.json().removedPeerIds, ['peer-a']);
});

async function reregister(peerId, overrides) {
    const response = await app.inject({
        method: 'POST',
        url: '/api/register',
        payload: registrationPayload(peerId, `registration-${peerId}`, overrides)
    });
    assert.equal(response.statusCode, 200);
    return response;
}

async function gridPeerIds(query = 'geohash=u10j2k') {
    const response = await app.inject({ method: 'GET', url: `/api/grid?${query}` });
    assert.equal(response.statusCode, 200);
    return response.json();
}

test('hides silent peers from the grid and tombstones them for other clients', async () => {
    await registerPeer('peer-a');
    await registerPeer('peer-b');
    assert.deepEqual((await gridPeerIds()).peers.map(peer => peer.id), ['peer-a', 'peer-b']);

    await reregister('peer-a', { silent: true });
    const silentGrid = await gridPeerIds();
    assert.deepEqual(silentGrid.peers.map(peer => peer.id), ['peer-b']);
    assert.deepEqual(silentGrid.removedPeerIds, ['peer-a']);
    assert.equal(store.isPeerSilent('peer-a'), true);

    await reregister('peer-a', { silent: false });
    const visibleGrid = await gridPeerIds();
    assert.deepEqual(visibleGrid.peers.map(peer => peer.id), ['peer-a', 'peer-b']);
    assert.deepEqual(visibleGrid.removedPeerIds, []);

    const invalid = await app.inject({
        method: 'POST',
        url: '/api/register',
        payload: registrationPayload('peer-a', 'registration-peer-a', { silent: 'yes' })
    });
    assert.equal(invalid.statusCode, 400);
});

test('clamps the configurable grid TTL between 1 and 60 minutes', async () => {
    await registerPeer('peer-a');
    await registerPeer('peer-b');
    const now = Date.now();
    await reregister('peer-a', { ttlMinutes: 0.1 });
    await reregister('peer-b', { ttlMinutes: 600 });

    const ids = (offsetMinutes) => store.getGridArea(['u10j2k'], now + offsetMinutes * 60 * 1000)
        .peers.map(peer => peer.peerId)
        .sort();
    assert.deepEqual(ids(0.5), ['peer-a', 'peer-b']);
    assert.deepEqual(ids(2), ['peer-b']);
    assert.deepEqual(ids(59), ['peer-b']);
    assert.deepEqual(ids(61), []);
});

test('live grid only returns peers with an active signaling socket', async () => {
    await registerPeer('peer-a');
    await registerPeer('peer-b');
    assert.equal((await gridPeerIds()).count, 2);
    assert.equal((await gridPeerIds('geohash=u10j2k&live=1')).count, 0);
});

test('loads the grid ring by ring with distance buckets and no locations', async () => {
    const origin = decodeGeohash('u10j2k');
    const near = geohashNeighbours('u10j2k')[0];
    const far = encodeGeohash(origin.latitude + 0.5, origin.longitude, 6);
    await registerPeer('peer-a');
    await app.inject({ method: 'POST', url: '/api/register', payload: registrationPayload('peer-b', 'registration-peer-b', { geohash: near }) });
    await app.inject({ method: 'POST', url: '/api/register', payload: registrationPayload('peer-c', 'registration-peer-c', { geohash: far }) });

    const ring0 = await gridPeerIds('geohash=u10j2k');
    assert.deepEqual(ring0.peers.map(peer => peer.id), ['peer-a']);
    assert.equal(ring0.hasMore, true);
    assert.deepEqual(Object.keys(ring0.peers[0]).sort(), ['avatar', 'distanceBucket', 'id', 'name']);
    assert.equal(ring0.peers[0].distanceBucket, 'lt1');

    const ring1 = await gridPeerIds('geohash=u10j2k&ring=1');
    assert.deepEqual(ring1.peers.map(peer => peer.id), ['peer-a', 'peer-b']);
    assert.equal(ring1.peers[1].distanceBucket, 'lt1');

    const ring4 = await gridPeerIds('geohash=u10j2k&ring=4');
    assert.deepEqual(ring4.peers.map(peer => peer.id), ['peer-a', 'peer-b', 'peer-c']);
    assert.equal(ring4.peers[2].distanceBucket, '20-100');
    assert.equal(ring4.hasMore, false);

    assert.equal((await app.inject({ method: 'GET', url: '/api/grid?geohash=u10j2k&ring=6' })).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: '/api/grid?geohash=u10' })).statusCode, 400);
});

test('stores at most a precision-6 geohash and rejects invalid ones', async () => {
    const response = await app.inject({
        method: 'POST',
        url: '/api/register',
        payload: registrationPayload('peer-a', 'registration-peer-a', { geohash: 'u10j2kxyzb' })
    });
    assert.equal(response.json().geohash, 'u10j2k');
    assert.equal(store.getPeerGeohash('peer-a'), 'u10j2k');

    const invalid = await app.inject({
        method: 'POST',
        url: '/api/register',
        payload: registrationPayload('peer-b', 'registration-peer-b', { geohash: 'u10j2a' })
    });
    assert.equal(invalid.statusCode, 400);
});

test('persists and deletes encrypted queue payloads', async () => {
    await registerPeer('peer-a');
    await registerPeer('peer-b');
    const anonymousResponse = await app.inject({
        method: 'POST',
        url: '/api/cache',
        payload: {
            recipientId: 'peer-b',
            ciphertextPayload: 'ciphertext'
        }
    });
    assert.equal(anonymousResponse.statusCode, 400);

    const enqueueResponse = await app.inject({
        method: 'POST',
        url: '/api/cache',
        headers: authHeaders('peer-a'),
        payload: {
            recipientId: 'peer-b',
            senderId: 'peer-a',
            ciphertextPayload: 'ciphertext',
            ivHex: 'abcdef',
            ttlHours: 24
        }
    });
    assert.equal(enqueueResponse.statusCode, 201);
    const { msgId } = enqueueResponse.json();

    const queueResponse = await app.inject({
        method: 'GET',
        url: '/api/cache/peer-b',
        headers: authHeaders('peer-b')
    });
    assert.equal(queueResponse.json().count, 1);
    assert.equal(queueResponse.json().messages[0].ciphertextPayload, 'ciphertext');

    const deleteResponse = await app.inject({
        method: 'DELETE',
        url: `/api/cache/${encodeURIComponent(msgId)}`,
        headers: authHeaders('peer-b')
    });
    assert.equal(deleteResponse.json().removed, 1);
    assert.equal((await app.inject({
        method: 'GET',
        url: '/api/cache/peer-b',
        headers: authHeaders('peer-b')
    })).json().count, 0);
});

test('persists chat deletion and blocking controls and purges queued messages', async () => {
    await registerPeer('peer-a');
    await registerPeer('peer-b');
    const enqueue = (recipientId, senderId) => app.inject({
        method: 'POST',
        url: '/api/cache',
        headers: authHeaders(senderId),
        payload: {
            recipientId,
            senderId,
            ciphertextPayload: 'ciphertext',
            ivHex: 'abcdef',
            ttlHours: 24
        }
    });

    assert.equal((await enqueue('peer-a', 'peer-b')).statusCode, 201);
    assert.equal((await enqueue('peer-b', 'peer-a')).statusCode, 201);

    const deleteChat = await app.inject({
        method: 'POST',
        url: '/api/chat-controls',
        headers: authHeaders('peer-a'),
        payload: {
            ownerId: 'peer-a',
            peerId: 'peer-b',
            action: 'DELETE_CHAT'
        }
    });
    assert.equal(deleteChat.statusCode, 201);
    assert.ok(deleteChat.json().control.deletedBefore);
    assert.equal((await app.inject({
        method: 'GET',
        url: '/api/cache/peer-a',
        headers: authHeaders('peer-a')
    })).json().count, 0);
    assert.equal((await app.inject({
        method: 'GET',
        url: '/api/cache/peer-b',
        headers: authHeaders('peer-b')
    })).json().count, 0);

    const block = await app.inject({
        method: 'POST',
        url: '/api/chat-controls',
        headers: authHeaders('peer-a'),
        payload: {
            ownerId: 'peer-a',
            peerId: 'peer-b',
            action: 'BLOCK'
        }
    });
    assert.ok(block.json().control.blockedAt);

    const controls = await app.inject({
        method: 'GET',
        url: '/api/chat-controls/peer-a',
        headers: authHeaders('peer-a')
    });
    assert.equal(controls.json().count, 1);
    assert.equal(controls.json().controls[0].peerId, 'peer-b');
    assert.equal((await enqueue('peer-a', 'peer-b')).statusCode, 403);

    const unblock = await app.inject({
        method: 'DELETE',
        url: '/api/chat-controls/peer-a/peer-b/block',
        headers: authHeaders('peer-a')
    });
    assert.equal(unblock.statusCode, 200);
    assert.equal(unblock.json().control.blockedAt, null);
    assert.equal((await enqueue('peer-a', 'peer-b')).statusCode, 201);
});

test('relays signaling messages between two websocket clients', async () => {
    await registerPeer('peer-a');
    await registerPeer('peer-b');
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    const url = `ws://127.0.0.1:${address.port}/ws`;
    const peerA = new WebSocket(url);
    const peerB = new WebSocket(url);

    const events = [];
    const offerReceived = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timed out waiting for relayed offer.')), 3000);
        const handleMessage = (peerId, socket) => event => {
            const message = JSON.parse(event.data);
            events.push({ peerId, message });
            if (message.type === 'SOCKET_REGISTERED' && peerId === 'peer-b') {
                peerA.send(JSON.stringify({
                    type: 'SDP_OFFER',
                    targetPeerId: 'peer-b',
                    senderNodeId: 'peer-a',
                    sdp: { type: 'offer', sdp: 'test-offer' }
                }));
            }
            if (peerId === 'peer-b' && message.type === 'SDP_OFFER') {
                clearTimeout(timeout);
                resolve(message);
            }
        };
        peerA.onmessage = handleMessage('peer-a', peerA);
        peerB.onmessage = handleMessage('peer-b', peerB);
    });

    await Promise.all([
        new Promise(resolve => {
            peerA.onopen = () => {
                peerA.send(JSON.stringify({
                    type: 'REGISTER_SOCKET',
                    peerId: 'peer-a',
                    authToken: peerTokens.get('peer-a')
                }));
                resolve();
            };
        }),
        new Promise(resolve => {
            peerB.onopen = () => {
                peerB.send(JSON.stringify({
                    type: 'REGISTER_SOCKET',
                    peerId: 'peer-b',
                    authToken: peerTokens.get('peer-b')
                }));
                resolve();
            };
        })
    ]);

    const offer = await offerReceived;
    assert.equal(offer.senderNodeId, 'peer-a');
    assert.ok(events.some(event => event.message.type === 'SOCKET_REGISTERED'));
    peerA.close();
    peerB.close();
});

test('notifies peers in the same geohash when a socket closes', async () => {
    await registerPeer('peer-a');
    await registerPeer('peer-b');
    await app.listen({ host: '127.0.0.1', port: 0 });
    const url = `ws://127.0.0.1:${app.server.address().port}/ws`;

    const openRegistered = (peerId) => new Promise((resolve, reject) => {
        const socket = new WebSocket(url);
        const timeout = setTimeout(() => reject(new Error(`Timed out registering ${peerId}.`)), 3000);
        socket.onopen = () => socket.send(JSON.stringify({
            type: 'REGISTER_SOCKET',
            peerId,
            authToken: peerTokens.get(peerId)
        }));
        socket.onmessage = event => {
            if (JSON.parse(event.data).type !== 'SOCKET_REGISTERED') return;
            clearTimeout(timeout);
            resolve(socket);
        };
    });

    const peerA = await openRegistered('peer-a');
    const peerB = await openRegistered('peer-b');
    const notice = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timed out waiting for PEER_OFFLINE.')), 3000);
        peerA.onmessage = event => {
            const message = JSON.parse(event.data);
            if (message.type !== 'PEER_OFFLINE') return;
            clearTimeout(timeout);
            resolve(message);
        };
    });
    peerB.close();

    assert.deepEqual(await notice, { type: 'PEER_OFFLINE', peerId: 'peer-b' });
    peerA.close();
});

async function connectSocket(url, peerId) {
    const socket = new WebSocket(url);
    const inbox = [];
    const waiters = [];
    socket.onmessage = event => {
        const message = JSON.parse(event.data);
        inbox.push(message);
        waiters.splice(0).forEach(waiter => waiter());
    };
    socket.next = (type, timeoutMs = 2000) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type} on ${peerId}.`)), timeoutMs);
        const check = () => {
            const index = inbox.findIndex(message => message.type === type);
            if (index < 0) {
                waiters.push(check);
                return;
            }
            clearTimeout(timer);
            resolve(inbox.splice(index, 1)[0]);
        };
        check();
    });
    socket.has = type => inbox.some(message => message.type === type);
    await new Promise(resolve => {
        socket.onopen = resolve;
    });
    socket.send(JSON.stringify({ type: 'REGISTER_SOCKET', peerId, authToken: peerTokens.get(peerId) }));
    await socket.next('SOCKET_REGISTERED');
    return socket;
}

test('shares presence only between mutually subscribed, unblocked chat partners in any cell', async () => {
    await registerPeer('peer-a');
    const registeredB = await app.inject({ method: 'POST', url: '/api/register', payload: registrationPayload('peer-b', 'registration-peer-b', { geohash: 'gcpvj0' }) });
    peerTokens.set('peer-b', registeredB.json().authToken);
    await registerPeer('peer-c');
    await app.listen({ host: '127.0.0.1', port: 0 });
    const url = `ws://127.0.0.1:${app.server.address().port}/ws`;
    const peerA = await connectSocket(url, 'peer-a');
    const peerB = await connectSocket(url, 'peer-b');
    const peerC = await connectSocket(url, 'peer-c');

    // Einseitig: C beobachtet A, A aber nicht C -> C erfaehrt nichts.
    peerC.send(JSON.stringify({ type: 'PRESENCE_SUBSCRIBE', peerIds: ['peer-a'] }));
    assert.deepEqual((await peerC.next('PRESENCE_SNAPSHOT')).online, []);

    // Gegenseitig, unterschiedliche Zellen: A und B sehen sich.
    peerA.send(JSON.stringify({ type: 'PRESENCE_SUBSCRIBE', peerIds: ['peer-b'] }));
    assert.deepEqual((await peerA.next('PRESENCE_SNAPSHOT')).online, []);
    peerB.send(JSON.stringify({ type: 'PRESENCE_SUBSCRIBE', peerIds: ['peer-a'] }));
    assert.deepEqual((await peerB.next('PRESENCE_SNAPSHOT')).online, ['peer-a']);
    assert.deepEqual(await peerA.next('PRESENCE'), { type: 'PRESENCE', peerId: 'peer-b', online: true });

    peerB.close();
    assert.deepEqual(await peerA.next('PRESENCE'), { type: 'PRESENCE', peerId: 'peer-b', online: false });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(peerC.has('PRESENCE'), false);

    // Abwesend (App nicht sichtbar): Partner erfaehrt es, ein neues Abo bekommt es im Snapshot.
    const peerB2 = await connectSocket(url, 'peer-b');
    peerB2.send(JSON.stringify({ type: 'PRESENCE_SUBSCRIBE', peerIds: ['peer-a'] }));
    await peerB2.next('PRESENCE_SNAPSHOT');
    assert.deepEqual(await peerA.next('PRESENCE'), { type: 'PRESENCE', peerId: 'peer-b', online: true });
    peerB2.send(JSON.stringify({ type: 'PRESENCE_AWAY', away: true }));
    assert.deepEqual(await peerA.next('PRESENCE'), { type: 'PRESENCE', peerId: 'peer-b', online: true, away: true });
    peerA.send(JSON.stringify({ type: 'PRESENCE_SUBSCRIBE', peerIds: ['peer-b'] }));
    assert.deepEqual(await peerA.next('PRESENCE_SNAPSHOT'), { type: 'PRESENCE_SNAPSHOT', online: ['peer-b'], away: ['peer-b'] });
    peerB2.send(JSON.stringify({ type: 'PRESENCE_AWAY', away: false }));
    assert.deepEqual(await peerA.next('PRESENCE'), { type: 'PRESENCE', peerId: 'peer-b', online: true, away: false });
    peerB2.close();
    assert.deepEqual(await peerA.next('PRESENCE'), { type: 'PRESENCE', peerId: 'peer-b', online: false });

    // Blockiert: kein Status mehr.
    store.setChatControl('peer-a', 'peer-c', 'BLOCK');
    peerA.send(JSON.stringify({ type: 'PRESENCE_SUBSCRIBE', peerIds: ['peer-b', 'peer-c'] }));
    assert.deepEqual((await peerA.next('PRESENCE_SNAPSHOT')).online, []);
    peerA.close();
    peerC.close();
});

test('exposes the allowed app modes', async () => {
    const config = (await app.inject({ method: 'GET', url: '/api/config' })).json();
    assert.deepEqual(config.modes, ['discovery', 'chat', 'friends', 'event']);
    assert.equal(config.defaultMode, 'discovery');
    // Pro Modus ein Profil-Schema; "Nur Chat" ist schlank.
    assert.deepEqual(config.profileSchemas.chat.map(field => field.key), ['displayName', 'status']);
    assert.ok(config.profileSchemas.discovery.some(field => field.key === 'age'));
    const shell = await app.inject({ method: 'GET', url: '/' });
    assert.match(shell.body, /"chat":\[\{"key":"displayName"/);

    const custom = parseProfileSchemas('{"event":[{"key":"displayName","label":"Name","type":"string"}]}', [{ key: 'bio' }], ['discovery', 'event', 'chat']);
    assert.deepEqual(custom.discovery, [{ key: 'bio' }]);
    assert.equal(custom.event[0].label, 'Name');
    assert.throws(() => parseProfileSchemas('[]', [], ['chat']), /JSON object/);
    assert.deepEqual(parseAppModes('chat, event,bogus,chat'), ['chat', 'event']);
    assert.deepEqual(parseAppModes(''), ['discovery', 'chat', 'friends', 'event']);

    const chatOnly = await buildApp({ store: createStore(':memory:'), buildVersion: 'x', buildTimestamp: 'y', appModes: 'chat', defaultAppMode: 'discovery' });
    const chatOnlyConfig = (await chatOnly.inject({ method: 'GET', url: '/api/config' })).json();
    assert.deepEqual([chatOnlyConfig.modes, chatOnlyConfig.defaultMode, Object.keys(chatOnlyConfig.profileSchemas)], [['chat'], 'chat', ['chat']]);
    assert.equal((await chatOnly.inject({ method: 'GET', url: '/api/grid?geohash=u10j2k' })).statusCode, 403);
    await chatOnly.close();
});

test('keeps friends and event peers out of the public grid', async () => {
    const eventHash = 'a'.repeat(64);
    await registerPeer('peer-a');
    await reregister('peer-a', { scope: 'public' });
    await registerPeer('peer-b');
    await reregister('peer-b', { scope: 'event', eventHash });
    await registerPeer('peer-c');
    await reregister('peer-c', { scope: 'friends' });

    const publicGrid = await gridPeerIds();
    assert.deepEqual(publicGrid.peers.map(peer => peer.id), ['peer-a']);
    assert.deepEqual(publicGrid.removedPeerIds.sort(), ['peer-b', 'peer-c']);

    const eventGrid = await gridPeerIds(`geohash=u10j2k&scope=event&eventHash=${eventHash}`);
    assert.deepEqual(eventGrid.peers.map(peer => peer.id), ['peer-b']);
    assert.equal(eventGrid.peers[0].distanceBucket, 'lt1');
    assert.equal((await gridPeerIds(`geohash=u10j2k&scope=event&eventHash=${'b'.repeat(64)}`)).count, 0);

    const invalid = await app.inject({
        method: 'POST',
        url: '/api/register',
        payload: registrationPayload('peer-b', 'registration-peer-b', { scope: 'event', eventHash: 'not-a-hash' })
    });
    assert.equal(invalid.statusCode, 400);
    const friendsWithoutAuth = await app.inject({ method: 'GET', url: '/api/grid?geohash=u10j2k&scope=friends&peerId=peer-a' });
    assert.equal(friendsWithoutAuth.statusCode, 401);
});

test('friends grid shows only online mutual contacts', async () => {
    await registerPeer('peer-a');
    await registerPeer('peer-b');
    await reregister('peer-b', { scope: 'friends' });
    await registerPeer('peer-c');
    await app.listen({ host: '127.0.0.1', port: 0 });
    const url = `ws://127.0.0.1:${app.server.address().port}/ws`;
    const peerA = await connectSocket(url, 'peer-a');
    const peerB = await connectSocket(url, 'peer-b');
    const peerC = await connectSocket(url, 'peer-c');
    peerA.send(JSON.stringify({ type: 'PRESENCE_SUBSCRIBE', peerIds: ['peer-b', 'peer-c'] }));
    await peerA.next('PRESENCE_SNAPSHOT');
    peerB.send(JSON.stringify({ type: 'PRESENCE_SUBSCRIBE', peerIds: ['peer-a'] }));
    await peerB.next('PRESENCE_SNAPSHOT');

    const friends = await app.inject({
        method: 'GET',
        url: '/api/grid?geohash=u10j2k&scope=friends&peerId=peer-a',
        headers: authHeaders('peer-a')
    });
    assert.deepEqual(friends.json().peers.map(peer => peer.id), ['peer-b'], 'peer-c is not mutual');
    peerA.close();
    peerB.close();
    peerC.close();
});

test('sends security headers and no wildcard CORS', async () => {
    const response = await app.inject({ method: 'GET', url: '/grid', headers: { host: 'grid.example' } });
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    assert.match(response.headers['content-security-policy'], /default-src 'self'/);
    assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.match(response.headers['content-security-policy'], /script-src 'self';/);
    assert.doesNotMatch(response.headers['content-security-policy'], /script-src[^;]*unsafe-inline/);
    assert.match(response.headers['content-security-policy'], /connect-src 'self' ws:\/\/grid\.example wss:\/\/grid\.example https:\/\/nominatim\.openstreetmap\.org/);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.match(response.headers['permissions-policy'], /camera=\(self\)/);
});

test('rate limits registrations per IP', async () => {
    const limited = await buildApp({ store: createStore(':memory:'), buildVersion: 'x', buildTimestamp: 'y', rateLimits: { register: { windowMs: 60000, max: 2 } } });
    const attempt = () => limited.inject({ method: 'POST', url: '/api/register', payload: { peerId: 'x' } });
    assert.equal((await attempt()).statusCode, 400);
    assert.equal((await attempt()).statusCode, 400);
    const blocked = await attempt();
    assert.equal(blocked.statusCode, 429);
    assert.ok(Number(blocked.headers['retry-after']) > 0);
    await limited.close();
});

test('caps the Path C queue per sender and recipient', async () => {
    await registerPeer('peer-a');
    await registerPeer('peer-b');
    const enqueue = () => app.inject({
        method: 'POST',
        url: '/api/cache',
        headers: authHeaders('peer-a'),
        payload: { recipientId: 'peer-b', senderId: 'peer-a', ciphertextPayload: 'x' }
    });
    // 200 Nachrichten vom selben Sender passen, die 201. nicht.
    for (let index = 0; index < 200; index++) store.enqueueMessage({ recipientId: 'peer-b', senderId: 'peer-a', ciphertextPayload: 'x' });
    const full = await enqueue();
    assert.equal(full.statusCode, 429);
    assert.match(full.json().error, /queue is full/);
});

test('logs requests without query strings', async () => {
    const lines = [];
    const logged = await buildApp({
        store: createStore(':memory:'),
        buildVersion: 'x',
        buildTimestamp: 'y',
        logger: { level: 'info', stream: { write: line => lines.push(line) } }
    });
    await logged.inject({ method: 'GET', url: '/api/grid?geohash=u10j2k&peerId=secret-peer&eventHash=abc' });
    await logged.close();
    const output = lines.join('');
    assert.match(output, /\/api\/grid/);
    assert.doesNotMatch(output, /u10j2k|secret-peer|eventHash|remoteAddress/);
});

test('removes identities that have not registered within the retention period', async () => {
    const day = 24 * 60 * 60 * 1000;
    const retained = createStore(':memory:', { credentialRetentionDays: 30 });
    const register = (peerId, now) => retained.registerPeer({ peerId, registrationId: 'r', authHash: `hash-${peerId}`, identityJwk: null, geohash: 'u10j2k', thumbnail: null, name: peerId }, now);
    register('old-peer', 0);
    register('active-peer', 0);
    register('active-peer', 25 * day);
    retained.setPushSubscription('old-peer', { endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'a', auth: 'b' } }, 0);
    retained.setChatControl('old-peer', 'active-peer', 'BLOCK', 0);

    assert.equal(retained.removeStaleIdentities(40 * day), 1);
    assert.equal(retained.authenticatePeer('old-peer', 'hash-old-peer'), false);
    assert.equal(retained.getPushSubscription('old-peer'), null);
    assert.equal(retained.isBlocked('old-peer', 'active-peer'), false);
    assert.equal(retained.authenticatePeer('active-peer', 'hash-active-peer'), true);
    retained.close();
});

test('rejects unauthorized access to peer-owned state', async () => {
    await registerPeer('peer-a');
    await registerPeer('peer-b');

    const queueRead = await app.inject({
        method: 'GET',
        url: '/api/cache/peer-a',
        headers: authHeaders('peer-b')
    });
    assert.equal(queueRead.statusCode, 401);

    const controlsWrite = await app.inject({
        method: 'POST',
        url: '/api/chat-controls',
        headers: authHeaders('peer-b'),
        payload: {
            ownerId: 'peer-a',
            peerId: 'peer-b',
            action: 'BLOCK'
        }
    });
    assert.equal(controlsWrite.statusCode, 401);
});

test('rejects malformed caller-supplied registration tokens', async () => {
    const response = await app.inject({
        method: 'POST',
        url: '/api/register',
        payload: {
            peerId: 'peer-a',
            registrationId: 'registration-a',
            geohash: 'u10j2k',
            authToken: 'too-short'
        }
    });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), { error: 'Invalid authToken' });
});

test('recovers a stale router token with the persistent signing identity', async () => {
    await registerPeer('peer-a', 'registration-old');
    const previousToken = peerTokens.get('peer-a');
    const replacementToken = randomBytes(32).toString('base64url');
    const response = await app.inject({
        method: 'POST',
        url: '/api/register',
        payload: registrationPayload('peer-a', 'registration-new', {
            authToken: replacementToken
        })
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().authToken, replacementToken);
    assert.notEqual(replacementToken, previousToken);
    assert.equal((await app.inject({
        method: 'GET',
        url: '/api/cache/peer-a',
        headers: { authorization: `Bearer ${previousToken}` }
    })).statusCode, 401);
    assert.equal((await app.inject({
        method: 'GET',
        url: '/api/cache/peer-a',
        headers: { authorization: `Bearer ${replacementToken}` }
    })).statusCode, 200);
});

test('accepts an existing matching token without a registration proof during migration', async () => {
    await registerPeer('peer-a', 'registration-old');
    const response = await app.inject({
        method: 'POST',
        url: '/api/register',
        payload: {
            peerId: 'peer-a',
            registrationId: 'registration-new',
            geohash: 'u10j2k',
            authToken: peerTokens.get('peer-a')
        }
    });

    assert.equal(response.statusCode, 200);
});

test('signaling answers application pings and drops half-open sockets', async () => {
    const { WebSocket: NodeWebSocket } = await import('ws');
    const heartbeatApp = await buildApp({ databasePath: ':memory:', heartbeatMs: 100 });
    await heartbeatApp.listen({ host: '127.0.0.1', port: 0 });
    const url = `ws://127.0.0.1:${heartbeatApp.server.address().port}/ws`;
    try {
        // Anwendungs-PING (Browser) -> PONG mit derselben Nonce.
        const browserLike = new NodeWebSocket(url);
        await new Promise(resolve => browserLike.on('open', resolve));
        const pong = new Promise(resolve => browserLike.on('message', data => resolve(JSON.parse(data.toString()))));
        browserLike.send(JSON.stringify({ type: 'PING', nonce: 'n-1' }));
        assert.deepEqual(await pong, { type: 'PONG', nonce: 'n-1' });

        // Ein Client, der auf WebSocket-Pings nicht antwortet (halb offen), wird getrennt.
        const halfOpen = new NodeWebSocket(url, { autoPong: false });
        await new Promise(resolve => halfOpen.on('open', resolve));
        const closed = await new Promise(resolve => {
            const timeout = setTimeout(() => resolve(false), 2000);
            halfOpen.on('close', () => {
                clearTimeout(timeout);
                resolve(true);
            });
        });
        assert.equal(closed, true, 'half-open socket is terminated');
        assert.equal(browserLike.readyState, NodeWebSocket.OPEN, 'healthy sockets stay');
        browserLike.close();
    } finally {
        await heartbeatApp.close();
    }
});

test('serves the changelog as markdown', async () => {
    const response = await app.inject({ method: 'GET', url: '/changelog.md' });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'], /text\/markdown/);
    assert.match(response.body, /^# Changelog/);
});

test('client defaults from the operator are validated and delivered with the app config', async () => {
    assert.deepEqual(parseClientDefaults('{"pullUpAction":"switcher","statusDirectOnly":true,"chatSwitchStyle":"teleport","evil":1,"albumKeyEpochsAhead":9}'),
        { pullUpAction: 'switcher', statusDirectOnly: true });
    assert.deepEqual(parseClientDefaults('kaputt'), {});
    assert.deepEqual(parseClientDefaults('[1,2]'), {});
    const configured = await buildApp({ databasePath: ':memory:', clientDefaults: '{"listSwitchBehavior":"view","traceWatermark":false}' });
    try {
        const response = await configured.inject({ method: 'GET', url: '/api/config' });
        assert.deepEqual(response.json().clientDefaults, { listSwitchBehavior: 'view', traceWatermark: false });
    } finally {
        await configured.close();
    }
});

test('an online recipient is told that a cached message is waiting', async () => {
    await registerPeer('peer-a');
    await registerPeer('peer-b');
    await app.listen({ host: '127.0.0.1', port: 0 });
    const url = `ws://127.0.0.1:${app.server.address().port}/ws`;
    const socket = new WebSocket(url);
    const messages = [];
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timed out registering.')), 3000);
        socket.onopen = () => socket.send(JSON.stringify({ type: 'REGISTER_SOCKET', peerId: 'peer-b', authToken: peerTokens.get('peer-b') }));
        socket.onmessage = event => {
            const message = JSON.parse(event.data);
            messages.push(message);
            if (message.type === 'SOCKET_REGISTERED') {
                clearTimeout(timeout);
                resolve();
            }
        };
    });
    const response = await app.inject({
        method: 'POST',
        url: '/api/cache',
        headers: { authorization: `Bearer ${peerTokens.get('peer-a')}` },
        payload: { recipientId: 'peer-b', senderId: 'peer-a', ciphertextPayload: 'abc', ivHex: '00' }
    });
    assert.equal(response.statusCode, 201);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.ok(messages.some(message => message.type === 'CACHE_WAITING'), 'recipient gets a hint without content');
    assert.equal(JSON.stringify(messages.find(message => message.type === 'CACHE_WAITING')), '{"type":"CACHE_WAITING"}');
    socket.close();
});


test('serves the web app manifest with a share target and redirects shares without a service worker', async () => {
    const manifest = await app.inject({ method: 'GET', url: '/manifest.webmanifest' });
    assert.equal(manifest.statusCode, 200);
    assert.match(manifest.headers['content-type'], /application\/manifest\+json/);
    const body = manifest.json();
    assert.equal(body.start_url, '/grid');
    assert.equal(body.share_target.action, '/share-target');
    assert.equal(body.share_target.enctype, 'multipart/form-data');
    assert.deepEqual(body.share_target.params.files[0].accept, ['image/*']);

    const boundary = 'ogboundary';
    const share = await app.inject({
        method: 'POST',
        url: '/share-target',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: `--${boundary}\r\nContent-Disposition: form-data; name="text"\r\n\r\nhallo\r\n--${boundary}--\r\n`
    });
    assert.equal(share.statusCode, 303);
    assert.equal(share.headers.location, '/chat?share=unavailable', 'nothing is stored on the server');
});
