import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

// Chat-Sync (delivery.client.js): Pakete nach Groesse, Kanal-Limit, erneute Zustellung nach Ablauf von Pfad C.
function loadDelivery(extra = {}) {
    const sent = [];
    const channelSends = [];
    const context = {
        state: { pendingP2PAcks: {}, secureMessageQueues: {}, dataChannels: {}, webrtcConnections: {}, sessionKeys: {}, chatPeerIds: [], myProfile: { id: 'me' } },
        Date, JSON, Number, setTimeout: () => 0, clearTimeout: () => {},
        logDebug: () => {}, logBackgroundError: () => () => {}, isPeerBlocked: () => false,
        ...extra
    };
    vm.runInNewContext(readFileSync(new URL('../client/delivery.client.js', import.meta.url), 'utf8'), context);
    return { context, sent, channelSends };
}

const imageOperation = (index, bytes = 70 * 1024) => ({
    operationId: `put:m${index}`, type: 'MESSAGE_PUT', createdAt: index,
    message: { id: `m${index}`, senderId: 'bob', snapData: `data:image/jpeg;base64,${'A'.repeat(bytes)}` }
});

test('sync answers are split into packets that fit a data channel', async () => {
    const { context } = loadDelivery();
    const payloads = [];
    context.getChatOperations = async () => Array.from({ length: 12 }, (_, index) => ({ ...imageOperation(index), peerId: 'bob' }));
    context.sendSecurePayload = async (_peerId, payload) => payloads.push(payload);
    await context.sendRequestedChatOperations('bob', Array.from({ length: 12 }, (_, index) => `put:m${index}`));
    assert.ok(payloads.length >= 10, `split into several packets (${payloads.length})`);
    assert.ok(payloads.every(payload => JSON.stringify(payload).length < 160 * 1024), 'every packet below the channel limit');
    assert.deepEqual(payloads.flatMap(payload => payload.operations.map(operation => operation.operationId)).sort(),
        Array.from({ length: 12 }, (_, index) => `put:m${index}`).sort(), 'nothing lost, nothing doubled');
    assert.ok(payloads.every(payload => payload.operations.every(operation => !('peerId' in operation))), 'local peerId stays local');
    // Kleine Operationen weiterhin gebuendelt.
    const small = context.batchSyncOperations(Array.from({ length: 50 }, (_, index) => ({ operationId: `react:${index}` })));
    assert.equal(small.length, 1);
    // Eine einzelne zu grosse Operation geht allein.
    assert.deepEqual([...context.batchSyncOperations([imageOperation(1, 200 * 1024), imageOperation(2, 10)]).map(batch => batch.length)], [1, 1]);
});

test('payloads above the channel limit are not pushed into the channel', async () => {
    const { context } = loadDelivery();
    const sends = [];
    context.state.dataChannels.bob = { readyState: 'open', bufferedAmount: 0, send: data => sends.push(data.length) };
    context.state.sessionKeys.bob = {};
    context.state.webrtcConnections.bob = { sctp: { maxMessageSize: 1000 } };
    context.encryptSecurePayload = async (_peerId, payload) => payload;
    context.initiateP2PConnection = async () => {};
    const result = await context.sendSecurePayload('bob', { type: 'CHAT_OPERATION', operation: { operationId: 'put:big', blob: 'x'.repeat(5000) } });
    assert.equal(result, false);
    assert.deepEqual(sends, [], 'not sent into the channel');
    assert.equal(context.state.secureMessageQueues.bob.length, 1, 'queued for Path C instead');
    await context.sendSecurePayload('bob', { type: 'CHAT_FOCUS', open: true });
    assert.equal(sends.length, 1, 'small payloads still go direct');
});

test('expired, unconfirmed own messages are delivered again', async () => {
    const now = Date.now();
    const messages = [
        { id: 'a', peerId: 'bob', senderId: 'me', cacheExpiresAt: now - 1000, createdAt: 1 },
        { id: 'b', peerId: 'bob', senderId: 'me', cacheExpiresAt: now - 1000, deliveryConfirmed: true, createdAt: 2 },
        { id: 'c', peerId: 'bob', senderId: 'me', cacheExpiresAt: now + 60000, createdAt: 3 },
        { id: 'd', peerId: 'bob', senderId: 'bob', cacheExpiresAt: now - 1000, createdAt: 4 },
        { id: 'e', peerId: 'bob', senderId: 'me', cacheExpiresAt: now - 1000, deleted: true, createdAt: 5 },
        { id: 'f', peerId: 'bob', senderId: 'me', createdAt: 6 }
    ];
    const persisted = [];
    const payloads = [];
    const { context } = loadDelivery({
        getDatabaseRecordsByIndex: async () => messages,
        getChatOperations: async () => messages.map(message => ({ operationId: `put:${message.id}`, peerId: 'bob', type: 'MESSAGE_PUT' })),
        persistChatMessage: async (_peerId, message) => persisted.push(message)
    });
    context.state.chatPeerIds = ['bob'];
    context.sendSecurePayload = async (peerId, payload, onSent) => {
        payloads.push(payload.operation.operationId);
        onSent('cache', { expiresAt: now + 86400000 });
    };
    assert.deepEqual([...context.expiredUnconfirmedMessages(messages, 'me', now).map(message => message.id)], ['a']);
    assert.equal(await context.resendExpiredCacheMessages(), 1);
    assert.deepEqual(payloads, ['put:a']);
    assert.ok(!('peerId' in persisted[0]) || persisted[0].cacheExpiresAt === undefined, 'marked as in progress');
    assert.equal(persisted.at(-1).cacheExpiresAt, now + 86400000, 'new expiry from the new upload');
});
