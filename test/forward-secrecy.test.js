import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// Ein Geraet: crypto.client.js + forward-secrecy.js mit einem Schluessel-Store im Speicher.
async function device(id) {
    const keys = new Map();
    const context = vm.createContext({
        TextEncoder, TextDecoder, Uint8Array, atob, btoa, structuredClone,
        window: { atob, btoa, crypto: webcrypto },
        state: { myProfile: { id }, dataChannels: {}, channelEphemerals: {} },
        databaseRequest: async (_store, _mode, run) => run({ get: key => structuredClone(keys.get(key)) ?? null }),
        putDatabaseRecord: async (_store, record) => keys.set(record.id, record)
    });
    vm.runInContext(read('client/crypto.client.js'), context);
    vm.runInContext(read('client/app/forward-secrecy.js'), context);
    const keyPair = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey', 'deriveBits']);
    const ecdsaKeyPair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    context.state.myKeys = {
        keyPair, ecdsaKeyPair,
        jwkPublic: await webcrypto.subtle.exportKey('jwk', keyPair.publicKey),
        jwkEcdsaPublic: await webcrypto.subtle.exportKey('jwk', ecdsaKeyPair.publicKey)
    };
    context.keys = keys;
    return context;
}

async function encryptWith(key, text) {
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    return { iv, data: new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text))) };
}

async function decryptWith(key, sealed) {
    return new TextDecoder().decode(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv }, key, sealed.data));
}

test('P2P: both sides derive the same session key from signed ephemeral keys; forged ones are rejected', async () => {
    const [alice, bob] = await Promise.all([device('alice'), device('bob')]);
    const channel = {};
    alice.state.dataChannels.bob = channel;
    bob.state.dataChannels.alice = channel;
    await alice.ensureChannelEphemeral('bob', channel);
    await bob.ensureChannelEphemeral('alice', channel);
    const fromAlice = alice.channelEphemeralHello('bob');
    const fromBob = bob.channelEphemeralHello('alice');
    const aliceKey = await alice.deriveForwardSecureSessionKey('bob', bob.state.myKeys.jwkPublic, bob.state.myKeys.jwkEcdsaPublic, fromBob);
    const bobKey = await bob.deriveForwardSecureSessionKey('alice', alice.state.myKeys.jwkPublic, alice.state.myKeys.jwkEcdsaPublic, fromAlice);
    assert.equal(await decryptWith(bobKey, await encryptWith(aliceKey, 'hallo')), 'hallo');
    // Wiederholtes KEY_HELLO: derselbe Schluessel, der private Wegwerf-Schluessel ist schon weg.
    assert.equal(alice.state.channelEphemerals.bob.privateKey, null);
    assert.equal(await alice.deriveForwardSecureSessionKey('bob', bob.state.myKeys.jwkPublic, bob.state.myKeys.jwkEcdsaPublic, fromBob), aliceKey);
    // Ausgetauschter Wegwerf-Schluessel (Mann in der Mitte): Signatur passt nicht.
    const mallory = await device('mallory');
    mallory.state.dataChannels.alice = channel;
    await mallory.ensureChannelEphemeral('alice', channel);
    const forged = { ...mallory.channelEphemeralHello('alice'), sig: fromBob.sig };
    const carol = await device('carol');
    carol.state.dataChannels.bob = {};
    await assert.rejects(carol.deriveForwardSecureSessionKey('bob', bob.state.myKeys.jwkPublic, bob.state.myKeys.jwkEcdsaPublic, forged), /signature/);
    // Ohne Angebot (alte Version): kein FS-Schluessel, Aufrufer faellt zurueck.
    assert.equal(await carol.deriveForwardSecureSessionKey('bob', bob.state.myKeys.jwkPublic, bob.state.myKeys.jwkEcdsaPublic, null), null);
});

test('Path C v3: prekey + ephemeral; page and service worker derive the same key; expired prekeys cannot be opened', async () => {
    const [alice, bob] = await Promise.all([device('alice'), device('bob')]);
    const now = Date.now();
    const prekey = await bob.rotatePrekeys(now);
    assert.equal(await alice.storePeerPrekey('bob', prekey, bob.state.myKeys.jwkEcdsaPublic), true);
    assert.equal(await alice.storePeerPrekey('bob', { ...prekey, x: alice.state.myKeys.jwkPublic.x }, bob.state.myKeys.jwkEcdsaPublic), false, 'forged prekey');
    const sealed = await alice.sealPathCKey('bob', bob.state.myKeys.jwkPublic);
    assert.equal(sealed.envelope.version, 3);
    assert.equal(sealed.envelope.prekeyId, prekey.id, 'uses the prekey');
    const ciphertext = await encryptWith(sealed.key, 'offline nachricht');
    const pageKey = await bob.openPathCKey('alice', sealed.envelope);
    assert.equal(await decryptWith(pageKey, ciphertext), 'offline nachricht');

    // Service Worker (eigene Kopie der Ableitung) kommt zum selben Ergebnis.
    const sw = vm.createContext({
        self: { addEventListener: () => {}, registration: {}, clients: {}, location: { origin: '' }, crypto: webcrypto },
        __PRECACHE_URLS__: [], __SW_TEXTS__: {}, setTimeout, queueMicrotask, structuredClone, TextEncoder, TextDecoder, atob, btoa
    });
    vm.runInContext(read('client/sw.js'), sw);
    const swKey = await sw.swPathCKeyV3({ privateKey: bob.state.myKeys.keyPair.privateKey }, bob.keys.get('prekeys'), 'alice', 'bob', sealed.envelope);
    assert.equal(await decryptWith(swKey, ciphertext), 'offline nachricht');

    // Nach 7 Tagen ist der private Prekey weg: alte Nachrichten lassen sich auch mit dem Identitaets-Schluessel nicht oeffnen.
    await bob.rotatePrekeys(now + 8 * 24 * 60 * 60 * 1000);
    await assert.rejects(bob.openPathCKey('alice', sealed.envelope), /Prekey expired/);
    // Zu alter Prekey beim Absender: statischer Rueckfall (ohne prekeyId).
    assert.equal(alice.usablePrekey(prekey, now + 7 * 24 * 60 * 60 * 1000), false);
});

test('group chain: every message has its own key; skipped ones are kept, used ones are gone', async () => {
    const alice = await device('alice');
    const start = { ck: Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString('base64'), n: 0, skipped: {} };
    // Absender: Glieder 0, 1, 2.
    let ck = start.ck;
    const messageKeys = [];
    for (let index = 0; index < 3; index++) {
        const step = await alice.chainStep(ck);
        messageKeys.push(step.messageKey);
        ck = step.next;
    }
    // Empfaenger bekommt 2 vor 0 und 1.
    let receiver = start;
    const two = await alice.chainMessageKey(receiver, 2);
    assert.equal(two.messageKey, messageKeys[2]);
    receiver = two.state;
    assert.equal(receiver.n, 3);
    const zero = await alice.chainMessageKey(receiver, 0);
    assert.equal(zero.messageKey, messageKeys[0]);
    receiver = zero.state;
    assert.equal(await alice.chainMessageKey(receiver, 0), null, 'used key is gone (no replay)');
    assert.equal((await alice.chainMessageKey(receiver, 1)).messageKey, messageKeys[1]);
    assert.equal(await alice.chainMessageKey(start, 10000), null, 'bounded skip');
    // Wer spaeter einsteigt (Glied 2), kann 0 und 1 nicht ableiten.
    const late = { ck: (await alice.chainStep((await alice.chainStep(start.ck)).next)).next, n: 2, skipped: {} };
    assert.equal(await alice.chainMessageKey(late, 1), null);
    assert.equal((await alice.chainMessageKey(late, 2)).messageKey, messageKeys[2]);
});
