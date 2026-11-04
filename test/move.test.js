import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { I18N_STUBS } from './i18n-stubs.js';

const subtle = globalThis.crypto.subtle;
const bytesToBase64 = bytes => Buffer.from(bytes).toString('base64');
const base64ToBytes = text => new Uint8Array(Buffer.from(text, 'base64'));
const sameJwk = (left, right) => Boolean(left && right) && left.x === right.x && left.y === right.y;

async function identity() {
    const ecdh = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const ecdsa = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    return {
        keys: { ecdsaKeyPair: ecdsa, jwkPublic: await subtle.exportKey('jwk', ecdh.publicKey), jwkEcdsaPublic: await subtle.exportKey('jwk', ecdsa.publicKey) }
    };
}

function loadMove({ myId, myKeys, identities = {}, blocked = [] }) {
    const calls = { renamed: [], persisted: [], blocks: [], records: new Map() };
    const context = {
        state: { myProfile: { id: myId }, myKeys, chatControls: Object.fromEntries(blocked.map(id => [id, { blockedAt: 1 }])), cachedProfiles: {} },
        window: { crypto: globalThis.crypto, localStorage: { length: 0, key: () => null, getItem: () => null, setItem: () => {} }, location: { reload: () => {} } },
        document: { getElementById: () => null, activeElement: null, addEventListener: () => {} },
        TextEncoder, TextDecoder, JSON, Date,
        bytesToBase64, base64ToBytes,
        publicKeysMatch: sameJwk,
        publicJwksMatch: sameJwk,
        isPeerBlocked: id => blocked.includes(id),
        getPeerIdentity: async id => identities[id] || null,
        persistPeerIdentityKey: async (id, jwkPublic, signing) => calls.persisted.push({ id, jwkPublic, signing }),
        storeChatControl: async (id, action) => calls.blocks.push({ id, action }),
        putDatabaseRecord: async (_store, value) => calls.records.set(value.id, value),
        showToast: () => {},
        setTimeout: () => 0,
        logBackgroundError: () => () => {},
        // renamePeerLocally ist im Browser getestet (e2e); hier nur, ob es gerufen wird.
        getAllDatabaseRecords: async () => []
    };
    vm.runInNewContext(readFileSync(new URL('../client/app/move.js', import.meta.url), 'utf8'), Object.assign(context, I18N_STUBS));
    context.renamePeerLocally = async (oldId, newId) => calls.renamed.push([oldId, newId]);
    return { context, calls };
}

// Alte Kopie erstellt die Vollmacht, neues Geraet signiert die Ansage damit.
async function makeAnnouncement({ oldId = 'node_old', newId = 'node_new', expires = null, tamper = null } = {}) {
    const old = await identity();
    const fresh = await identity();
    const exporter = loadMove({ myId: oldId, myKeys: old.keys });
    const move = await exporter.context.createMoveDelegation();
    if (expires !== null) {
        const delegation = JSON.parse(move.delegation);
        delegation.expiresAt = expires;
        move.delegation = JSON.stringify(delegation);
        move.delegationSignature = await exporter.context.signMoveText(move.delegation, old.keys.ecdsaKeyPair.privateKey);
    }
    const announcement = JSON.stringify({ type: 'opengrid-move', from: oldId, to: newId, keys: { jwkPublic: fresh.keys.jwkPublic, jwkEcdsaPublic: fresh.keys.jwkEcdsaPublic }, at: Date.now() });
    const delegateKey = await subtle.importKey('jwk', move.delegatePrivate, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const payload = {
        type: 'MOVE_ANNOUNCE',
        delegation: move.delegation,
        delegationSignature: move.delegationSignature,
        announcement: tamper ? tamper(announcement) : announcement,
        announcementSignature: await exporter.context.signMoveText(announcement, delegateKey)
    };
    return { old, fresh, payload, oldId, newId };
}

test('a contact accepts a properly signed move and renames the peer', async () => {
    const { old, fresh, payload, oldId, newId } = await makeAnnouncement();
    const { context, calls } = loadMove({ myId: 'node_contact', myKeys: (await identity()).keys, identities: { [oldId]: { profileSigningKey: old.keys.jwkEcdsaPublic } } });
    assert.equal(await context.handleMoveAnnouncement(newId, payload, fresh.keys.jwkPublic), true);
    assert.deepEqual(calls.renamed, [[oldId, newId]]);
    assert.equal(calls.persisted[0].id, newId);
    assert.ok(sameJwk(calls.persisted[0].signing, fresh.keys.jwkEcdsaPublic), 'pins the announced signing key');
});

test('forged, foreign or expired announcements are ignored', async () => {
    const contactKeys = (await identity()).keys;
    const run = async (made, senderId, senderKey, identities) => {
        const { context, calls } = loadMove({ myId: 'node_contact', myKeys: contactKeys, identities });
        const result = await context.handleMoveAnnouncement(senderId, made.payload, senderKey);
        return { result, renamed: calls.renamed.length };
    };
    const good = await makeAnnouncement();
    const pinned = { node_old: { profileSigningKey: good.old.keys.jwkEcdsaPublic } };
    // Anderer Absender als die angesagte neue ID.
    assert.deepEqual(await run(good, 'node_other', good.fresh.keys.jwkPublic, pinned), { result: false, renamed: 0 });
    // Absender spricht mit einem anderen Schluessel als angesagt.
    assert.deepEqual(await run(good, good.newId, contactKeys.jwkPublic, pinned), { result: false, renamed: 0 });
    // Vollmacht nicht vom gepinnten Schluessel der alten ID.
    const stranger = await identity();
    assert.deepEqual(await run(good, good.newId, good.fresh.keys.jwkPublic, { node_old: { profileSigningKey: stranger.keys.jwkEcdsaPublic } }), { result: false, renamed: 0 });
    // Alte ID unbekannt.
    assert.deepEqual(await run(good, good.newId, good.fresh.keys.jwkPublic, {}), { result: false, renamed: 0 });
    // Ansage nach dem Signieren veraendert (anderes Ziel-ID im Text).
    const tampered = await makeAnnouncement({ tamper: text => text.replace('"at":', '"evil":1,"at":') });
    assert.deepEqual(await run(tampered, tampered.newId, tampered.fresh.keys.jwkPublic, { node_old: { profileSigningKey: tampered.old.keys.jwkEcdsaPublic } }), { result: false, renamed: 0 });
    // Vollmacht abgelaufen.
    const expired = await makeAnnouncement({ expires: Date.now() - 1000 });
    assert.deepEqual(await run(expired, expired.newId, expired.fresh.keys.jwkPublic, { node_old: { profileSigningKey: expired.old.keys.jwkEcdsaPublic } }), { result: false, renamed: 0 });
});

test('a blocked old id stays blocked under the new id', async () => {
    const { old, fresh, payload, oldId, newId } = await makeAnnouncement();
    const { context, calls } = loadMove({ myId: 'node_contact', myKeys: (await identity()).keys, identities: { [oldId]: { profileSigningKey: old.keys.jwkEcdsaPublic } }, blocked: [oldId] });
    assert.equal(await context.handleMoveAnnouncement(newId, payload, fresh.keys.jwkPublic), true);
    assert.deepEqual(calls.renamed, []);
    assert.deepEqual(calls.blocks, [{ id: newId, action: 'block' }]);
});

test('the old copy locks itself when it receives its own move', async () => {
    const old = await identity();
    const fresh = await identity();
    const oldDevice = loadMove({ myId: 'node_old', myKeys: old.keys });
    const move = await oldDevice.context.createMoveDelegation();
    const announcement = JSON.stringify({ type: 'opengrid-move', from: 'node_old', to: 'node_new', keys: { jwkPublic: fresh.keys.jwkPublic, jwkEcdsaPublic: fresh.keys.jwkEcdsaPublic }, at: Date.now() });
    const delegateKey = await subtle.importKey('jwk', move.delegatePrivate, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const payload = { type: 'MOVE_ANNOUNCE', delegation: move.delegation, delegationSignature: move.delegationSignature, announcement, announcementSignature: await oldDevice.context.signMoveText(announcement, delegateKey) };
    assert.equal(await oldDevice.context.handleMoveAnnouncement('node_new', payload, fresh.keys.jwkPublic), true);
    assert.equal(oldDevice.calls.records.get('moved-away').to, 'node_new');
    assert.equal(oldDevice.context.state.movedAway, true);
    assert.deepEqual(oldDevice.calls.renamed, []);
});
