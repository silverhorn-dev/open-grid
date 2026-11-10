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
