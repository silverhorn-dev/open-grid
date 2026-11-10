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
