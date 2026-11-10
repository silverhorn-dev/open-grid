import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

async function loadCryptoClient() {
    const source = await readFile(new URL('../client/crypto.client.js', import.meta.url), 'utf8');
    const context = vm.createContext({
        TextEncoder,
        Uint8Array,
        window: {
            atob,
            btoa,
            crypto: webcrypto
        }
    });
    vm.runInContext(`${source}
        globalThis.cryptoClient = { signProfileData, verifySignedProfile, signingKeyFingerprint, canonicalJson, signOperation, verifyOperationSignature };
    `, context);
    return context.cryptoClient;
}

test('verifies a profile only for its expected owner and pinned signing key', async () => {
    const { signProfileData, verifySignedProfile } = await loadCryptoClient();
    const keyPair = await webcrypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['sign', 'verify']
    );
    const publicKey = await webcrypto.subtle.exportKey('jwk', keyPair.publicKey);
    const envelope = await signProfileData({
        id: 'peer-a',
        version: 2,
        updatedAt: 123,
        fields: { displayName: 'Alice' },
        avatar: null,
        gallery: []
    }, keyPair.privateKey, publicKey);

    // Gepinnter Schluessel -> voll vertrauenswuerdig.
    assert.equal(await verifySignedProfile(envelope, 'peer-a', publicKey), 'trusted');
    assert.equal(await verifySignedProfile(envelope, 'peer-b', publicKey), false);

    // Ohne gepinnten Schluessel (Swarm) bleibt die Signatur pruefbar, der
    // Schluessel aber unbestaetigt. Das darf nicht als Faelschung gelten.
    assert.equal(await verifySignedProfile(envelope, 'peer-a', undefined), 'unpinned');
    assert.equal(await verifySignedProfile(envelope, 'peer-b', undefined), false);

    const otherKeyPair = await webcrypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['sign', 'verify']
    );
    const otherPublicKey = await webcrypto.subtle.exportKey('jwk', otherKeyPair.publicKey);
    assert.equal(await verifySignedProfile(envelope, 'peer-a', otherPublicKey), false);
    assert.equal(await verifySignedProfile({}, 'peer-a', publicKey), false);

    // Manipulierter Inhalt muss auch ohne Pinning scheitern.
    const tampered = { ...envelope, payload: { ...envelope.payload, fields: { displayName: 'Mallory' } } };
    assert.equal(await verifySignedProfile(tampered, 'peer-a', undefined), false);
});

test('the signed profile carries chat rules and the add flag, tampering breaks it', async () => {
    const { signProfileData, verifySignedProfile } = await loadCryptoClient();
    const keyPair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const publicKey = await webcrypto.subtle.exportKey('jwk', keyPair.publicKey);
    const envelope = await signProfileData({
        id: 'peer-a', version: 1, updatedAt: 1, fields: {}, avatar: null, gallery: [],
        chatPolicy: { mode: 'C', limit: 5, allowImages: false },
        allowMatchFriends: false
    }, keyPair.privateKey, publicKey);
    assert.equal(envelope.payload.chatPolicy.mode, 'C');
    assert.equal(envelope.payload.allowMatchFriends, false);
    const tampered = { ...envelope, payload: { ...envelope.payload, allowMatchFriends: true } };
    assert.equal(await verifySignedProfile(tampered, 'peer-a', publicKey), false);
});

test('signing key fingerprints match the router grid (keyFp)', async () => {
    const { signingKeyFingerprint } = await loadCryptoClient();
    const { createHash, generateKeyPairSync } = await import('node:crypto');
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    const router = createHash('sha256').update(`${jwk.x}.${jwk.y}`).digest('base64url').slice(0, 22);
    assert.equal(await signingKeyFingerprint(jwk), router);
    assert.equal(await signingKeyFingerprint({}), null);
});

test('chat operations: canonical json, signature survives the wire, tampering is detected', async () => {
    const { canonicalJson, signOperation, verifyOperationSignature } = await loadCryptoClient();
    assert.equal(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: undefined }], c: 'z' }, sig: 'x', peerId: 'p', u: undefined }), '{"a":{"c":"z","d":[1,{"y":2}]},"b":1}');
    const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const publicJwk = await webcrypto.subtle.exportKey('jwk', keys.publicKey);
    const operation = { operationId: 'put:m1', type: 'MESSAGE_PUT', actorId: 'alice', messageId: 'm1', createdAt: 5, message: { id: 'm1', senderId: 'alice', text: 'hi', snapData: undefined } };
    const sig = await signOperation(operation, keys.privateKey);
    // Wie beim Empfaenger: JSON-Rundreise, andere Schluessel-Reihenfolge, lokales peerId.
    const received = { peerId: 'alice', ...JSON.parse(JSON.stringify({ ...operation, sig })) };
    assert.equal(await verifyOperationSignature(received, publicJwk), true);
    assert.equal(await verifyOperationSignature({ ...received, message: { ...received.message, text: 'hacked' } }, publicJwk), false);
    assert.equal(await verifyOperationSignature({ ...received, actorId: 'bob' }, publicJwk), false);
    const other = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    assert.equal(await verifyOperationSignature(received, await webcrypto.subtle.exportKey('jwk', other.publicKey)), false, 'wrong key');
    assert.equal(await verifyOperationSignature({ ...received, sig: undefined }, publicJwk), false, 'unsigned is not "valid"');
});
