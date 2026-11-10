import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { I18N_STUBS } from './i18n-stubs.js';

function load(extra = {}) {
    const context = { state: { groups: {}, myProfile: { id: 'me' } }, window: { crypto: globalThis.crypto }, logDebug: () => {}, ...extra };
    vm.runInNewContext(readFileSync(new URL('../client/app/conversations.js', import.meta.url), 'utf8'), Object.assign(context, I18N_STUBS));
    return context;
}

const group = { id: 'group_1234abcd-0000', name: 'Crew', members: ['me', 'bob', 'carol'], admins: ['me'], createdAt: 1 };

test('1:1 conversations are the partner node id, groups their own id', () => {
    const context = load();
    assert.equal(context.isGroupId('node_abc'), false);
    assert.equal(context.isGroupId(group.id), true);
    assert.equal(context.isGroupId('group_x'), false, 'too short');
    assert.match(context.newGroupId(), /^group_[0-9a-f-]{36}$/);
    assert.deepEqual([...context.conversationRecipients('node_bob', { myId: 'me' })], ['node_bob']);
    const groups = { [group.id]: group };
    assert.deepEqual([...context.conversationRecipients(group.id, { groups, myId: 'me' })], ['bob', 'carol']);
    assert.deepEqual([...context.conversationRecipients(group.id, { groups, myId: 'stranger' })], [], 'not a member: nothing');
    assert.equal(context.isValidGroup({ ...group, members: Array.from({ length: 17 }, (_, index) => `m${index}`) }), false, 'max 16');
    assert.equal(context.isValidGroup({ ...group, members: ['me', 'me'] }), false, 'no duplicates');
});

test('incoming group payloads are only accepted from members of known groups', () => {
    const context = load();
    const groups = { [group.id]: group };
    assert.equal(context.resolveIncomingConversation('bob', undefined, { groups, myId: 'me' }), 'bob', '1:1 as before');
    assert.equal(context.resolveIncomingConversation('bob', group.id, { groups, myId: 'me' }), group.id);
    assert.equal(context.resolveIncomingConversation('mallory', group.id, { groups, myId: 'me' }), null, 'not a member');
    assert.equal(context.resolveIncomingConversation('bob', 'group_unknown-1234', { groups, myId: 'me' }), null, 'unknown group');
    assert.equal(context.resolveIncomingConversation('bob', 'node_other', { groups, myId: 'me' }), null, 'no rerouting into 1:1 chats');
});

test('group payloads fan out to every member with the group inside the operation', async () => {
    const sent = [];
    const context = load({
        sendSecurePayload: async (peerId, payload, onSent) => {
            sent.push({ peerId, payload });
            onSent?.(peerId === 'bob' ? 'p2p' : 'cache', {});
            return true;
        }
    });
    context.state.groups = { [group.id]: group };
    // Beide direkt verbunden: P2P an jeden (der Buendel-Weg ist unten im Sender-Schluessel-Test abgedeckt).
    context.state.dataChannels = { bob: { readyState: 'open' }, carol: { readyState: 'open' } };
    context.state.sessionKeys = { bob: {}, carol: {} };
    const paths = [];
    const ok = await context.sendGroupPayload(group.id, { type: 'CHAT_OPERATION', operation: { operationId: 'put:1', actorId: 'me' } }, path => paths.push(path));
    assert.equal(ok, true);
    assert.deepEqual(sent.map(entry => entry.peerId).sort(), ['bob', 'carol']);
    assert.ok(sent.every(entry => entry.payload.conversationId === group.id && entry.payload.operation.conversationId === group.id));
    assert.deepEqual(paths.sort(), ['cache', 'p2p'], 'each path reported once');
    assert.equal(await context.sendGroupPayload(group.id, { type: 'CHAT_FOCUS', open: true }), false, 'only chat operations');
});

test('group states are only taken from admins, newer versions, and direct from the signer', () => {
    const context = load();
    const base = { id: group.id, name: 'Crew', members: ['alice', 'me', 'bob'], admins: ['alice'], createdAt: 1, version: 1, updatedBy: 'alice', updatedAt: 1 };
    const judge = (next, current, senderId = 'alice') => context.judgeGroupState(next, current, { senderId, myId: 'me' });
    assert.equal(judge(base, null), 'accept', 'new group from its admin');
    assert.equal(judge(base, null, 'bob'), null, 'must come directly from the signer');
    assert.equal(judge({ ...base, updatedBy: 'bob' }, null, 'bob'), null, 'signer must be admin');
    assert.equal(judge({ ...base, version: 2 }, base), 'accept');
    assert.equal(judge(base, base), null, 'same version ignored');
    assert.equal(judge({ ...base, version: 2, updatedBy: 'bob', admins: ['alice', 'bob'] }, base, 'bob'), null, 'bob cannot make himself admin');
    assert.equal(judge({ ...base, version: 2, members: ['alice', 'bob'] }, base), 'removed');
    assert.equal(judge({ ...base, members: ['alice', 'bob'] }, null), null, 'not about me');
    assert.equal(judge({ ...base, version: 3 }, { ...base, left: true }), null, 'left groups stay left');
    assert.equal(judge({ ...base, admins: ['carol'] }, null), null, 'admins must be members');
    assert.equal(judge({ ...base, name: '' }, null), null);
    assert.equal(context.groupAvatar({ id: group.id, name: 'Coole Crew' }).startsWith('data:image/svg+xml'), true);
    assert.ok(decodeURIComponent(context.groupAvatar({ id: group.id, name: 'Coole Crew' })).includes('>CC<'), 'initials');
    assert.ok(!decodeURIComponent(context.groupAvatar({ id: group.id, name: '<script>' })).includes('<script>'), 'no markup from names');
});

test('group history and relayed operations', async () => {
    const { webcrypto } = await import('node:crypto');
    const cryptoSource = readFileSync(new URL('../client/crypto.client.js', import.meta.url), 'utf8');
    const alice = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const aliceJwk = await webcrypto.subtle.exportKey('jwk', alice.publicKey);
    const context = load({ window: { crypto: webcrypto, btoa, atob }, TextEncoder, Uint8Array, getPeerIdentity: async () => null });
    vm.runInNewContext(cryptoSource, context);
    const relayGroup = { ...group, members: ['me', 'bob', 'alice'], memberKeys: { alice: { x: aliceJwk.x, y: aliceJwk.y } }, since: { me: 500 }, createdAt: 100 };
    context.state.groups = { [group.id]: relayGroup };
    assert.equal(context.groupSyncCutoff(relayGroup, 'me'), 500, 'history from the admin choice');
    assert.equal(context.groupSyncCutoff(relayGroup, 'bob'), 100, 'founding members: from the start');
    const operation = { operationId: 'put:a1', type: 'MESSAGE_PUT', actorId: 'alice', conversationId: group.id, createdAt: 600, message: { id: 'a1', senderId: 'alice', text: 'hi' } };
    const signed = { ...operation, sig: await context.signOperation(operation, alice.privateKey) };
    assert.equal(await context.acceptRelayedOperation(group.id, 'bob', signed), true, 'signed by the author, key vouched by the admin');
    assert.equal(await context.acceptRelayedOperation(group.id, 'bob', { ...signed, message: { ...signed.message, text: 'fake' } }), false, 'tampered');
    assert.equal(await context.acceptRelayedOperation(group.id, 'bob', operation), false, 'unsigned relays are refused');
    assert.equal(await context.acceptRelayedOperation(group.id, 'mallory', signed), false, 'relay must be a member');
    assert.equal(await context.acceptRelayedOperation(group.id, 'bob', { ...signed, conversationId: 'group_other-12345' }), false);
    context.state.groups[group.id] = { ...relayGroup, left: true };
    assert.equal(await context.acceptRelayedOperation(group.id, 'bob', signed), false, 'left groups take nothing');
    assert.equal(context.resolveIncomingConversation('bob', group.id, { groups: context.state.groups, myId: 'me' }), null);
});

test('sender keys: seal once for the group, open per member, unknown keys wait', async () => {
    const { webcrypto } = await import('node:crypto');
    const cryptoSource = readFileSync(new URL('../client/crypto.client.js', import.meta.url), 'utf8');
    const records = new Map();
    const sent = [];
    const context = load({
        window: { crypto: webcrypto, btoa, atob }, TextEncoder, TextDecoder, Uint8Array,
        databaseRequest: async (_store, _mode, run) => run({ get: id => records.get(id) }),
        putDatabaseRecord: async (_store, record) => records.set(record.id, structuredClone(record)),
        sendSecurePayload: async (peerId, payload) => { sent.push({ peerId, payload }); return true; },
        logBackgroundError: () => () => {}
    });
    vm.runInNewContext(cryptoSource, context);
    context.state.groups = { [group.id]: group };
    const payload = { type: 'CHAT_OPERATION', conversationId: group.id, operation: { operationId: 'put:1', actorId: 'me', conversationId: group.id } };
    const sealed = await context.sealForGroup(group.id, payload);
    const envelope = JSON.parse(sealed.ciphertextPayload);
    assert.equal(envelope.kind, 'group');
    assert.ok(!sealed.ciphertextPayload.includes('put:1'), 'encrypted');
    const keyMessages = sent.filter(entry => entry.payload.type === 'GROUP_SENDER_KEY');
    assert.deepEqual(keyMessages.map(entry => entry.peerId).sort(), ['bob', 'carol'], 'own key goes to every member once');
    // Bob: kennt meinen Schluessel erst nach GROUP_SENDER_KEY.
    context.state.myProfile = { id: 'bob' };
    assert.equal(await context.openGroupEnvelope('me', envelope, sealed.ivHex), null, 'unknown key: wait');
    await context.handleGroupSenderKey('me', keyMessages[0].payload);
    assert.deepEqual(JSON.parse(JSON.stringify(await context.openGroupEnvelope('me', envelope, sealed.ivHex))), payload);
    assert.equal(await context.openGroupEnvelope('mallory', envelope, sealed.ivHex), null, 'not from a member');
    // Entfernen: neuer eigener Schluessel, der alte bleibt Bob fuer Altes, der Entfernte bekommt keinen neuen.
    context.state.myProfile = { id: 'me' };
    sent.length = 0;
    context.state.groups = { [group.id]: { ...group, members: ['me', 'bob'] } };
    await context.updateSenderKeysForMembership(group.id, ['me', 'bob', 'carol'], ['me', 'bob']);
    const rotated = sent.filter(entry => entry.payload.type === 'GROUP_SENDER_KEY');
    assert.deepEqual(rotated.map(entry => entry.peerId), ['bob'], 'carol gets no new key');
    assert.notEqual(rotated[0].payload.kid, keyMessages[0].payload.kid, 'rotated');
});

test('group candidates: friends and chat contacts from Chat & Friends, not Explore', () => {
    const context = load({
        isFriend: id => id === 'friend',
        chatScopeOf: id => ({ friend: 'social', chatter: 'social', flirt: 'discovery' })[id] || null,
        isPeerBlocked: id => id === 'blocked'
    });
    context.state.friendState = { friend: {} };
    context.state.chatPeerIds = ['friend', 'chatter', 'flirt', 'blocked', group.id];
    context.chatScopeOf = id => ({ friend: 'social', chatter: 'social', flirt: 'discovery', blocked: 'social' })[id] || null;
    assert.deepEqual([...context.groupCandidates()].sort(), ['chatter', 'friend']);
    assert.deepEqual([...context.groupCandidates(['chatter'])], ['friend'], 'existing members excluded');
});

test('member cards: signed by the owner, accepted within shared groups, admins pass them on', async () => {
    const { webcrypto } = await import('node:crypto');
    const cryptoSource = readFileSync(new URL('../client/crypto.client.js', import.meta.url), 'utf8');
    const carol = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const carolJwk = await webcrypto.subtle.exportKey('jwk', carol.publicKey);
    const records = new Map();
    const forwarded = [];
    const context = load({
        window: { crypto: webcrypto, btoa, atob }, TextEncoder, Uint8Array,
        getPeerIdentity: async () => null,
        databaseRequest: async (_store, _mode, run) => run({ get: id => records.get(id) }),
        putDatabaseRecord: async (_store, record) => records.set(record.id, record),
        sendSecurePayload: async (peerId, payload) => { forwarded.push({ peerId, payload }); return true; }
    });
    vm.runInNewContext(cryptoSource, context);
    const crew = { ...group, members: ['me', 'bob', 'carol'], admins: ['me'], memberKeys: { carol: { x: carolJwk.x, y: carolJwk.y } } };
    context.state.groups = { [crew.id]: crew };
    const card = { ownerId: 'carol', name: 'Carol', updatedAt: 5 };
    const sig = await context.signOperation(card, carol.privateKey);
    assert.equal(await context.handleGroupMemberCard('carol', { card, sig }), true);
    assert.equal(context.groupCardOf('carol').name, 'Carol');
    assert.deepEqual(forwarded.map(entry => entry.peerId), ['bob'], 'admin passes the card on to the other members');
    assert.equal(await context.handleGroupMemberCard('carol', { card: { ...card, name: 'Fake' }, sig }), false, 'tampered');
    assert.equal(await context.handleGroupMemberCard('mallory', { card, sig }), false, 'only from members of a shared group');
    context.state.groups = {};
    assert.equal(await context.handleGroupMemberCard('carol', { card: { ...card, updatedAt: 6 }, sig }), false, 'no shared group: nothing');
});
