import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// Laedt delivery.client.js mit kontrollierbaren Timern: run() fuehrt faellige Timer aus.
function loadDelivery() {
    let now = 1_000_000;
    let timers = [];
    const calls = { cleanup: [], cached: [], onSent: [] };
    const channel = { readyState: 'open', bufferedAmount: 0, send() {}, close() { this.readyState = 'closed'; } };
    const context = {
        state: { pendingP2PAcks: {}, secureMessageQueues: {}, dataChannels: { bob: channel }, webrtcConnections: { bob: {} }, sessionKeys: { bob: {} } },
        Date: { now: () => now },
        setTimeout: (callback, ms) => { const timer = { at: now + ms, callback }; timers.push(timer); return timer; },
        clearTimeout: timer => { timers = timers.filter(entry => entry !== timer); },
        logDebug: () => {},
        logBackgroundError: () => () => {},
        isPeerBlocked: () => false,
        JSON
    };
    vm.runInNewContext(read('client/delivery.client.js'), context);
    context.cleanupPeerConnection = peerId => { calls.cleanup.push(peerId); delete context.state.dataChannels[peerId]; };
    context.queuePayloadInCache = async (peerId, item) => { calls.cached.push(item.payload.operation.operationId); return true; };
    context.encryptSecurePayload = async (_peerId, payload) => payload;
    const advance = async ms => {
        now += ms;
        for (;;) {
            const due = timers.filter(timer => timer.at <= now).sort((a, b) => a.at - b.at)[0];
            if (!due) break;
            timers = timers.filter(timer => timer !== due);
            due.callback();
            await new Promise(resolve => setImmediate(resolve));
        }
        await new Promise(resolve => setImmediate(resolve));
    };
    const send = operationId => context.sendSecurePayload('bob', { type: 'CHAT_OPERATION', operation: { operationId } }, path => calls.onSent.push(path));
    return { context, calls, channel, advance, send };
}

test('a P2P message confirmed by the receiver stays on P2P', async () => {
    const { context, calls, advance, send } = loadDelivery();
    await send('put:1');
    context.handleP2PAck('bob', 'put:1');
    await advance(10000);
    assert.deepEqual(calls.cached, []);
    assert.deepEqual(calls.cleanup, []);
    assert.deepEqual(calls.onSent, ['p2p']);
});

test('without a confirmation the channel counts as dead and the message goes over Path C', async () => {
    const { calls, advance, send } = loadDelivery();
    await send('put:2');
    await advance(4999);
    assert.deepEqual(calls.cached, []);
    await advance(1);
    assert.deepEqual(calls.cleanup, ['bob']);
    assert.deepEqual(calls.cached, ['put:2']);
});

test('an ack from another peer does not count', async () => {
    const { context, calls, advance, send } = loadDelivery();
    await send('put:3');
    context.handleP2PAck('mallory', 'put:3');
    await advance(5000);
    assert.deepEqual(calls.cached, ['put:3']);
});

test('large messages still being sent get more time', async () => {
    const { calls, channel, advance, send } = loadDelivery();
    channel.bufferedAmount = 500000;
    await send('put:4');
    await advance(15000);
    assert.deepEqual(calls.cached, [], 'still buffering, keep waiting');
    channel.bufferedAmount = 0;
    await advance(5000);
    assert.deepEqual(calls.cached, ['put:4']);
});

test('when the server reports the partner offline, unconfirmed messages go to Path C at once', async () => {
    const { context, calls, advance, send } = loadDelivery();
    await send('put:5');
    context.flushUnconfirmedToCache('bob');
    await advance(0);
    assert.deepEqual(calls.cached, ['put:5']);
});

test('if Path C is not possible the message waits for the next connection', async () => {
    const { context, calls, advance, send } = loadDelivery();
    context.queuePayloadInCache = async () => false;
    await send('put:6');
    await advance(5000);
    assert.deepEqual(calls.onSent, ['p2p', 'pending']);
    assert.equal(context.state.secureMessageQueues.bob.length, 1);
});
