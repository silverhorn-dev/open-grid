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
        globalThis.cryptoClient = { signProfileData, verifySignedProfile };
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
