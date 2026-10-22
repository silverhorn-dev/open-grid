import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { afterEach, beforeEach, test } from 'node:test';
import { buildApp } from '../server/app.js';
import { createStore } from '../server/database.js';

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

test('serves the app shell and all client modules', async () => {
    const indexResponse = await app.inject({ method: 'GET', url: '/' });
    assert.equal(indexResponse.statusCode, 200);
    assert.match(indexResponse.body, /test-build/);
    assert.match(indexResponse.body, /\/client\/crypto\.client\.js/);
    assert.match(indexResponse.body, /indexedDB\.open\('OpenGridDB_Live', 7\)/);
    assert.match(indexResponse.body, /createObjectStore\('localProfile'/);
    assert.match(indexResponse.body, /createObjectStore\('chatOperations'/);
    assert.match(indexResponse.body, /putDatabaseRecord\('localProfile'/);
    assert.match(indexResponse.body, /profile-onboarding-modal/);
    assert.match(indexResponse.body, /if \(!hasLocalProfile\) await openProfileOnboarding\(\)/);
    assert.match(indexResponse.body, /id: 'identity-key'/);
    assert.match(indexResponse.body, /async function refreshChatControls\(\)/);
    assert.match(indexResponse.body, /function rememberChatPeer\(peerId\)/);

    for (const file of ['crypto.client.js', 'grid.client.js', 'p2p.client.js']) {
        const response = await app.inject({ method: 'GET', url: `/client/${file}` });
        assert.equal(response.statusCode, 200);
        assert.match(response.headers['content-type'], /text\/javascript/);
        assert.ok(response.body.length > 100);
    }
    const p2pClient = await app.inject({ method: 'GET', url: '/client/p2p.client.js' });
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
