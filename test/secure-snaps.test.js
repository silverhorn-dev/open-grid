import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

function loadSecureSnaps({ ownKeep } = {}) {
    const media = new Map();
    const sent = [];
    const messages = [];
    const context = {
        state: { chats: { 'peer-b': messages }, activeChatPeerId: null, webrtcConnections: {}, outgoingSnapStreams: {}, snapSettings: ownKeep ? { ownKeep } : undefined },
        clientDefault: (_key, fallback) => fallback,
        window: { crypto: globalThis.crypto },
        bytesToBase64: bytes => Buffer.from(bytes).toString('base64'),
        base64ToBytes: value => new Uint8Array(Buffer.from(value, 'base64')),
        cacheMediaPayload: async (id, payload) => media.set(id, structuredClone(payload)),
        loadMedia: async id => (media.has(id) ? structuredClone(media.get(id)) : null),
        deleteDatabaseRecord: async (_store, id) => media.delete(id),
        getDatabaseRecordsByIndex: async () => messages,
        persistChatMessage: async () => {},
        sendSecurePayload: async (peerId, payload) => sent.push({ peerId, payload }),
        renderChatHistory: () => {},
        logDebug: () => {}
    };
    vm.runInNewContext(readFileSync(new URL('../client/app/secure-snaps.js', import.meta.url), 'utf8'), context);
    return { context, media, sent, messages };
}

const SNAP = 'data:image/jpeg;base64,' + Buffer.from('fake-jpeg-bytes').toString('base64');

test('secure snaps keep the key at the sender and count views', async () => {
    const { context, media, sent, messages } = loadSecureSnaps();
    const secureSnap = await context.createSecureSnap(SNAP, 'peer-b', 2, 10);
    assert.equal(secureSnap.views, 2);
    assert.equal(JSON.stringify(secureSnap).includes('fake-jpeg'), false);
    assert.equal(secureSnap.key, undefined);
    messages.push({ id: 'm1', senderId: 'me', secureSnap: { ...secureSnap } });

    // Fremder Peer bekommt nichts.
    await context.handleSnapViewRequest('peer-x', { snapId: secureSnap.snapId });
    assert.equal(sent.at(-1).payload.type, 'SNAP_VIEW_DENIED');

    // Ohne Verbindung fuer einen Live-Stream: Schluessel-Freigabe.
    await context.handleSnapViewRequest('peer-b', { snapId: secureSnap.snapId });
    const grant = sent.at(-1).payload;
    assert.equal(grant.type, 'SNAP_VIEW_GRANT');
    assert.equal(grant.viewsLeft, 1);
    assert.equal(messages[0].secureSnap.viewsUsed, 1);
    // Solange noch Ansichten offen sind, kann der Sender seinen Snap selbst ansehen.
    const own = await context.decryptOwnSecureSnap('peer-b', media.get(`ssnap_${secureSnap.snapId}`));
    assert.equal(Buffer.from(own).toString(), 'fake-jpeg-bytes');

    const key = await globalThis.crypto.subtle.importKey('raw', Buffer.from(grant.key, 'base64'), 'AES-GCM', false, ['decrypt']);
    const plaintext = await globalThis.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: Buffer.from(secureSnap.encrypted.iv, 'base64') },
        key,
        Buffer.from(secureSnap.encrypted.ciphertext, 'base64')
    );
    assert.equal(Buffer.from(plaintext).toString(), 'fake-jpeg-bytes');

    await context.handleSnapViewRequest('peer-b', { snapId: secureSnap.snapId });
    assert.equal(sent.at(-1).payload.viewsLeft, 0);
    // Standard: der Sender behaelt seinen Snap noch 1 h (ansehen, speichern), weitere Anfragen abgelehnt.
    assert.equal(media.get(`ssnap_${secureSnap.snapId}`).viewsLeft, 0);
    assert.ok(messages[0].secureSnap.encrypted, 'ciphertext kept for the own retention time');
    const keptFor = messages[0].secureSnap.ownKeepUntil - Date.now();
    assert.ok(keptFor > 59 * 60 * 1000 && keptFor <= 60 * 60 * 1000, 'kept for one hour by default');

    await context.handleSnapViewRequest('peer-b', { snapId: secureSnap.snapId });
    assert.equal(sent.at(-1).payload.type, 'SNAP_VIEW_DENIED');
});

test('with "delete right away" the sender drops key and ciphertext after the last view', async () => {
    const { context, media, messages } = loadSecureSnaps({ ownKeep: 'now' });
    const secureSnap = await context.createSecureSnap(SNAP, 'peer-b', 1, 10);
    messages.push({ id: 'm1', senderId: 'me', secureSnap: { ...secureSnap } });
    await context.handleSnapViewRequest('peer-b', { snapId: secureSnap.snapId });
    assert.equal(media.has(`ssnap_${secureSnap.snapId}`), false, 'key is deleted after the last view');
    assert.equal(messages[0].secureSnap.encrypted, undefined, 'sender drops the ciphertext too');
    assert.equal(messages[0].secureSnap.ownKeepUntil, undefined);
});
