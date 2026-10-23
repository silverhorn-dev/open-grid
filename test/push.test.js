import assert from 'node:assert/strict';
import crypto, { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { afterEach, beforeEach, test } from 'node:test';
import { buildApp } from '../server/app.js';
import { createStore } from '../server/database.js';
import {
    MAX_PUSH_PLAINTEXT_BYTES,
    createVapidAuthorization,
    encryptPushPayload,
    generateVapidKeys
} from '../server/push.js';

let app;
let store;
let sentPushes;
let pushStatus;
const peerTokens = new Map();

// Simuliert die Browser-Seite einer Push-Subscription.
function createBrowserSubscription() {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    const raw = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
    const auth = randomBytes(16);
    return {
        privateKey,
        subscription: {
            endpoint: 'https://push.example.test/send/abc',
            keys: { p256dh: raw.toString('base64url'), auth: auth.toString('base64url') }
        }
    };
}

// RFC 8291 Entschluesselung, wie sie der Browser durchfuehrt.
function decryptPushBody(body, browser) {
    const salt = body.subarray(0, 16);
    const keyIdLength = body.readUInt8(20);
    const serverPublic = body.subarray(21, 21 + keyIdLength);
    const record = body.subarray(21 + keyIdLength);
    const userAgentPublic = Buffer.from(browser.subscription.keys.p256dh, 'base64url');
    const sharedSecret = crypto.diffieHellman({
        privateKey: browser.privateKey,
        publicKey: crypto.createPublicKey({
            key: {
                kty: 'EC',
                crv: 'P-256',
                x: serverPublic.subarray(1, 33).toString('base64url'),
                y: serverPublic.subarray(33, 65).toString('base64url')
            },
            format: 'jwk'
        })
    });
    const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), userAgentPublic, serverPublic]);
    const authSecret = Buffer.from(browser.subscription.keys.auth, 'base64url');
    const inputKey = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, authSecret, keyInfo, 32));
    const contentKey = Buffer.from(crypto.hkdfSync('sha256', inputKey, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(crypto.hkdfSync('sha256', inputKey, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const decipher = crypto.createDecipheriv('aes-128-gcm', contentKey, nonce);
    decipher.setAuthTag(record.subarray(record.length - 16));
    const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
    assert.equal(padded[padded.length - 1], 0x02);
    return padded.subarray(0, padded.length - 1).toString();
}

async function registerPeer(peerId) {
    const signingKeys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const authToken = randomBytes(32).toString('base64url');
    const registrationId = `registration-${peerId}`;
    const response = await app.inject({
        method: 'POST',
        url: '/api/register',
        payload: {
            peerId,
            registrationId,
            geohash: 'u10j2k',
            authToken,
            registrationProof: {
                publicKey: signingKeys.publicKey.export({ format: 'jwk' }),
                signature: sign(
                    'sha256',
                    Buffer.from(JSON.stringify({ peerId, registrationId, authToken })),
                    { key: signingKeys.privateKey, dsaEncoding: 'ieee-p1363' }
                ).toString('base64')
            }
        }
    });
    assert.equal(response.statusCode, 200);
    peerTokens.set(peerId, response.json().authToken);
}

function authHeaders(peerId) {
    return { authorization: `Bearer ${peerTokens.get(peerId)}` };
}

async function subscribe(peerId, subscription) {
    return app.inject({
        method: 'POST',
        url: '/api/push/subscribe',
        headers: authHeaders(peerId),
        payload: { peerId, subscription }
    });
}

async function enqueue(payload) {
    const response = await app.inject({
        method: 'POST',
        url: '/api/cache',
        headers: authHeaders('peer-a'),
        payload: { recipientId: 'peer-b', senderId: 'peer-a', ivHex: 'aXY=', ...payload }
    });
    // Der Push laeuft im Hintergrund weiter.
    await new Promise(resolve => setImmediate(resolve));
    return response;
}

beforeEach(async () => {
    peerTokens.clear();
    sentPushes = [];
    pushStatus = 201;
    store = createStore(':memory:');
    app = await buildApp({
        store,
        buildVersion: 'test-build',
        buildTimestamp: '2026-10-22T00:00:00.000Z',
        pushSender: async (subscription, payload) => {
            sentPushes.push({ subscription, payload });
            return { status: pushStatus, expired: pushStatus === 404 || pushStatus === 410 };
        }
    });
    await registerPeer('peer-a');
    await registerPeer('peer-b');
});

afterEach(async () => {
    await app.close();
    store.close();
});

test('encrypts push payloads so the browser can decrypt them (RFC 8291)', () => {
    const browser = createBrowserSubscription();
    const plaintext = JSON.stringify({ type: 'PATH_C', msgId: 'msg_1', senderId: 'peer-a' });
    const body = encryptPushPayload(browser.subscription, plaintext);
    assert.equal(body.readUInt32BE(16), 4096);
    assert.equal(body.readUInt8(20), 65);
    assert.equal(decryptPushBody(body, browser), plaintext);
});

test('matches the RFC 8291 appendix A test vector', () => {
    const asPublic = Buffer.from('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8', 'base64url');
    const privateKey = crypto.createPrivateKey({
        key: {
            kty: 'EC',
            crv: 'P-256',
            x: asPublic.subarray(1, 33).toString('base64url'),
            y: asPublic.subarray(33).toString('base64url'),
            d: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'
        },
        format: 'jwk'
    });
    const body = encryptPushPayload({
        endpoint: 'https://push.example.net/push/JzLQ3raZJfFBR0aqvOMsLrt54w4rJUsV',
        keys: {
            p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
            auth: 'BTBZMqHH6r4Tts7J_aSIgg'
        }
    }, 'When I grow up, I want to be a watermelon', {
        salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'),
        ephemeral: { privateKey, publicKey: crypto.createPublicKey(privateKey) }
    });
    assert.equal(
        body.toString('base64url'),
        'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN'
    );
});

test('signs VAPID tokens for the push service origin', () => {
    const vapidKeys = generateVapidKeys();
    const header = createVapidAuthorization('https://push.example.test/send/abc', vapidKeys, 'mailto:ops@example.test');
    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
    assert.ok(match);
    const [, encodedHeader, encodedClaims, signature, publicKey] = match;
    assert.equal(publicKey, vapidKeys.publicKey);
    const claims = JSON.parse(Buffer.from(encodedClaims, 'base64url').toString());
    assert.equal(claims.aud, 'https://push.example.test');
    assert.equal(claims.sub, 'mailto:ops@example.test');
    const raw = Buffer.from(publicKey, 'base64url');
    const verifyKey = crypto.createPublicKey({
        key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') },
        format: 'jwk'
    });
    assert.ok(crypto.verify(
        'sha256',
        Buffer.from(`${encodedHeader}.${encodedClaims}`),
        { key: verifyKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature, 'base64url')
    ));
});

test('persists generated VAPID keys across app restarts', async () => {
    const first = (await app.inject({ method: 'GET', url: '/api/push/vapid-public-key' })).json().publicKey;
    const secondApp = await buildApp({ store, pushSender: async () => ({ status: 201, expired: false }) });
    const second = (await secondApp.inject({ method: 'GET', url: '/api/push/vapid-public-key' })).json().publicKey;
    await secondApp.close();
    assert.equal(Buffer.from(first, 'base64url').length, 65);
    assert.equal(first, second);
});

test('stores push subscriptions only for authenticated peers', async () => {
    const { subscription } = createBrowserSubscription();
    const anonymous = await app.inject({
        method: 'POST',
        url: '/api/push/subscribe',
        payload: { peerId: 'peer-b', subscription }
    });
    assert.equal(anonymous.statusCode, 401);

    const insecure = await subscribe('peer-b', { ...subscription, endpoint: 'http://push.example.test/x' });
    assert.equal(insecure.statusCode, 400);

    assert.equal((await subscribe('peer-b', subscription)).statusCode, 201);
    assert.deepEqual(store.getPushSubscription('peer-b'), subscription);

    const removed = await app.inject({
        method: 'DELETE',
        url: '/api/push/subscribe/peer-b',
        headers: authHeaders('peer-b')
    });
    assert.equal(removed.json().removed, 1);
    assert.equal(store.getPushSubscription('peer-b'), null);
});

test('pushes the sender ciphertext to the recipient when notify is set', async () => {
    const { subscription } = createBrowserSubscription();
    await subscribe('peer-b', subscription);

    const silent = await enqueue({ ciphertextPayload: 'ciphertext-delete' });
    assert.equal(silent.json().pushRequested, false);
    assert.equal(sentPushes.length, 0);

    const response = await enqueue({ ciphertextPayload: 'ciphertext-put', notify: true });
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().pushRequested, true);
    assert.equal(sentPushes.length, 1);
    assert.deepEqual(sentPushes[0].payload, {
        type: 'PATH_C',
        msgId: response.json().msgId,
        senderId: 'peer-a',
        ciphertextPayload: 'ciphertext-put',
        ivHex: 'aXY='
    });
});

test('sends only a wake-up hint when the ciphertext does not fit into a push', async () => {
    await subscribe('peer-b', createBrowserSubscription().subscription);
    const response = await enqueue({ ciphertextPayload: 'x'.repeat(MAX_PUSH_PLAINTEXT_BYTES), notify: true });
    assert.deepEqual(sentPushes[0].payload, {
        type: 'PATH_C',
        msgId: response.json().msgId,
        senderId: 'peer-a'
    });
    assert.equal(store.getMessages('peer-b').length, 1);
});

test('does not push for blocked senders and drops expired subscriptions', async () => {
    await subscribe('peer-b', createBrowserSubscription().subscription);
    pushStatus = 410;
    await enqueue({ ciphertextPayload: 'ciphertext', notify: true });
    assert.equal(sentPushes.length, 1);
    assert.equal(store.getPushSubscription('peer-b'), null);

    await subscribe('peer-b', createBrowserSubscription().subscription);
    store.setChatControl('peer-b', 'peer-a', 'BLOCK');
    const blocked = await enqueue({ ciphertextPayload: 'ciphertext', notify: true });
    assert.equal(blocked.statusCode, 403);
    assert.equal(sentPushes.length, 1);
});

test('serves the service worker from the root scope without automatic skipWaiting', async () => {
    const response = await app.inject({ method: 'GET', url: '/sw.js' });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'], /text\/javascript/);
    assert.equal(response.headers['service-worker-allowed'], '/');
    assert.match(response.body, /addEventListener\('push'/);
    assert.match(response.body, /acknowledgeQueuedMessage/);
    assert.match(response.body, /tag: 'opengrid-messages'/);
    // skipWaiting nur auf ausdruecklichen Wunsch des Nutzers (Update-Banner), nie automatisch.
    assert.equal(response.body.match(/self\.skipWaiting\(/g).length, 1);
    assert.match(response.body, /if \(event\.data\?\.type === 'ACTIVATE_UPDATE'\) self\.skipWaiting\(\);/);
    assert.doesNotMatch(response.body, /\bwindow\.|\bdocument\./);
});
