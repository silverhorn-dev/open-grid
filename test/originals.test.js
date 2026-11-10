import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function loadOriginals() {
    const media = new Map();
    const sent = [];
    const context = {
        state: { myProfile: { id: 'me' }, chats: {}, originalTransfers: {}, activeChatPeerId: null, dataChannels: {} },
        media,
        sent,
        isSafeInlineImage: value => typeof value === 'string' && value.startsWith('data:image/'),
        sha256Base64: async text => Buffer.from(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))).toString('base64'),
        cacheMedia: async (id, data) => media.set(id, { data }),
        loadMedia: async id => media.get(id) || null,
        persistChatMessage: async () => {},
        renderChatHistory: () => {},
        logDebug: () => {},
        isSecureChannelOpen: () => true,
        getDatabaseRecordsByIndex: async (_store, _index, peerId) => Object.values(context.state.chats[peerId] || []),
        databaseRequest: async () => null,
        sendSecurePayload: async (peerId, payload) => sent.push({ peerId, payload }),
        document: { querySelector: () => null },
        setTimeout,
        Date
    };
    vm.runInNewContext(read('client/app/originals.js'), context);
    return context;
}

test('an original arrives in chunks only after asking and is checked against its hash', async () => {
    const receiver = loadOriginals();
    const dataUrl = `data:image/jpeg;base64,${'A'.repeat(200000)}`;
    const meta = { size: dataUrl.length, sha256: await receiver.sha256Base64(dataUrl), mime: 'image/jpeg' };
    const message = { id: 'm1', peerId: 'peer', senderId: 'peer', snapData: 'data:image/jpeg;base64,small', original: meta };
    receiver.state.chats.peer = [message];

    // Unangefragte Stuecke werden ignoriert.
    await receiver.handleOriginalChunk('peer', { messageId: 'm1', index: 0, total: 1, data: dataUrl });
    assert.equal(receiver.media.size, 0);

    await receiver.requestMissingOriginals('peer');
    assert.deepEqual(JSON.parse(JSON.stringify(receiver.sent.map(entry => entry.payload))), [{ type: 'ORIGINAL_REQUEST', messageId: 'm1' }]);

    // Absender: liefert in 64-KB-Stuecken.
    const sender = loadOriginals();
    sender.state.dataChannels.peer = { readyState: 'open', bufferedAmount: 0 };
    // Im Speicher ohne peerId (wie nach dem Senden).
    const { peerId: _peerId, ...ownMessage } = message;
    sender.state.chats.peer = [{ ...ownMessage, senderId: 'me' }];
    await sender.cacheMedia('orig_m1', dataUrl);
    await sender.handleOriginalRequest('peer', { messageId: 'm1' });
    const chunks = sender.sent.map(entry => entry.payload);
    assert.equal(chunks.length, Math.ceil(dataUrl.length / (64 * 1024)));
    assert.ok(chunks.every(chunk => chunk.type === 'ORIGINAL_CHUNK' && chunk.data.length <= 64 * 1024));

    // Reihenfolge egal, am Ende Hash-Pruefung und Speicherung.
    for (const chunk of [...chunks].reverse()) await receiver.handleOriginalChunk('peer', chunk);
    assert.equal(receiver.media.get('orig_m1').data, dataUrl);
    assert.equal(message.originalReady, true);
});

test('a manipulated original is dropped and only the sender may serve it', async () => {
    const receiver = loadOriginals();
    const meta = { size: 40, sha256: 'nicht-passend', mime: 'image/jpeg' };
    receiver.state.chats.peer = [{ id: 'm2', peerId: 'peer', senderId: 'peer', original: meta }];
    await receiver.requestMissingOriginals('peer');
    await receiver.handleOriginalChunk('peer', { messageId: 'm2', index: 0, total: 1, data: 'data:image/jpeg;base64,' + 'B'.repeat(17) });
    assert.equal(receiver.media.size, 0, 'hash mismatch');
    assert.equal(receiver.state.chats.peer[0].originalReady, undefined);

    // Fremde Nachricht: kein Ausliefern.
    const other = loadOriginals();
    other.state.dataChannels.peer = { readyState: 'open', bufferedAmount: 0 };
    other.state.chats.peer = [{ id: 'm3', peerId: 'peer', senderId: 'peer', original: meta }];
    await other.cacheMedia('orig_m3', 'data:image/jpeg;base64,AA');
    await other.handleOriginalRequest('peer', { messageId: 'm3' });
    assert.deepEqual(other.sent.map(entry => entry.payload.type), ['ORIGINAL_MISSING'], 'not received yet: no data, just "missing"');
});

test('swarm: a member who has the original serves it, the requester checks the hash and moves on when missing', async () => {
    const groupId = 'group_abcd1234-0000';
    const group = { id: groupId, members: ['me', 'alice', 'bob'], admins: ['alice'], createdAt: 1 };
    const extra = context => Object.assign(context, {
        isGroupId: id => id === groupId, getGroup: id => (id === groupId ? group : null), isGroupActive: id => id === groupId,
        memberIdOf: id => id, groupSyncCutoff: () => 0, sharedActiveGroups: id => (group.members.includes(id) ? [groupId] : [])
    });
    const dataUrl = `data:image/jpeg;base64,${'C'.repeat(1000)}`;
    // Bob hat Alices Original schon.
    const bob = extra(loadOriginals());
    bob.state.myProfile.id = 'bob';
    group.members = ['me', 'alice', 'bob'];
    const meta = { size: dataUrl.length, sha256: await bob.sha256Base64(dataUrl), mime: 'image/jpeg' };
    bob.state.dataChannels.me = { readyState: 'open', bufferedAmount: 0 };
    bob.state.chats[groupId] = [{ id: 'g1', senderId: 'alice', original: meta, originalReady: true, createdAt: 5 }];
    await bob.cacheMedia('orig_g1', dataUrl);
    // Ich: Alice ist offline, Carol (kein Mitglied) und Bob sind verbunden.
    const me = extra(loadOriginals());
    me.state.dataChannels = { bob: { readyState: 'open' }, carol: { readyState: 'open' } };
    me.isSecureChannelOpen = id => Boolean(me.state.dataChannels[id]);
    const message = { id: 'g1', peerId: groupId, senderId: 'alice', original: meta, createdAt: 5 };
    me.state.chats[groupId] = [message];
    await me.requestMissingOriginals(groupId);
    assert.deepEqual(JSON.parse(JSON.stringify(me.sent.map(entry => [entry.peerId, entry.payload]))),
        [['bob', { type: 'ORIGINAL_REQUEST', messageId: 'g1', conversationId: groupId }]], 'only members are asked');
    await bob.handleOriginalRequest('me', me.sent[0].payload);
    // Nicht-Mitglied bekommt nichts.
    const before = bob.sent.length;
    await bob.handleOriginalRequest('carol', me.sent[0].payload);
    assert.equal(bob.sent.length, before, 'no data for non-members');
    for (const chunk of bob.sent.map(entry => entry.payload)) await me.handleOriginalChunk('bob', chunk);
    assert.equal(me.media.get('orig_g1').data, dataUrl);
    assert.equal(message.originalReady, true);
});
