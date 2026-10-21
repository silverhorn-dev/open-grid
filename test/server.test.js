import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { buildApp } from '../server/app.js';
import { createStore } from '../server/database.js';

let app;
let store;

beforeEach(async () => {
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

    for (const file of ['crypto.client.js', 'grid.client.js', 'p2p.client.js']) {
        const response = await app.inject({ method: 'GET', url: `/client/${file}` });
        assert.equal(response.statusCode, 200);
        assert.match(response.headers['content-type'], /text\/javascript/);
        assert.ok(response.body.length > 100);
    }
});

test('registers peers, protects newer registrations, and creates removal tombstones', async () => {
    const firstRegistration = {
        peerId: 'peer-a',
        registrationId: 'registration-old',
        geohash: 'u10j2k',
        thumbnail: 'encrypted-thumbnail-placeholder',
        name: 'Alice'
    };
    const secondRegistration = {
        ...firstRegistration,
        registrationId: 'registration-new'
    };

    assert.equal((await app.inject({
        method: 'POST',
        url: '/api/register',
        payload: firstRegistration
    })).statusCode, 200);
    await app.inject({
        method: 'POST',
        url: '/api/register',
        payload: secondRegistration
    });

    const staleUnregister = await app.inject({
        method: 'DELETE',
        url: '/api/register?peerId=peer-a&registrationId=registration-old&geohash=u10j2k'
    });
    assert.equal(staleUnregister.json().removed, 0);

    const visibleGrid = await app.inject({
        method: 'GET',
        url: '/api/grid?geohash=u10j2k'
    });
    assert.equal(visibleGrid.json().count, 1);

    const currentUnregister = await app.inject({
        method: 'DELETE',
        url: '/api/register?peerId=peer-a&registrationId=registration-new&geohash=u10j2k'
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
    const enqueueResponse = await app.inject({
        method: 'POST',
        url: '/api/cache',
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
        url: '/api/cache/peer-b'
    });
    assert.equal(queueResponse.json().count, 1);
    assert.equal(queueResponse.json().messages[0].ciphertextPayload, 'ciphertext');

    const deleteResponse = await app.inject({
        method: 'DELETE',
        url: `/api/cache/${encodeURIComponent(msgId)}`
    });
    assert.equal(deleteResponse.json().removed, 1);
    assert.equal((await app.inject({
        method: 'GET',
        url: '/api/cache/peer-b'
    })).json().count, 0);
});

test('relays signaling messages between two websocket clients', async () => {
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
                peerA.send(JSON.stringify({ type: 'REGISTER_SOCKET', peerId: 'peer-a' }));
                resolve();
            };
        }),
        new Promise(resolve => {
            peerB.onopen = () => {
                peerB.send(JSON.stringify({ type: 'REGISTER_SOCKET', peerId: 'peer-b' }));
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
