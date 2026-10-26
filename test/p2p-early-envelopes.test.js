import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { I18N_STUBS } from './i18n-stubs.js';

// Beide Seiten leiten den Sitzungsschluessel gleichzeitig ab. Eine verschluesselte Nachricht, die vor
// dem eigenen Schluessel ankommt, darf nicht verloren gehen.
function loadP2p() {
    const handled = [];
    const context = {
        ...I18N_STUBS,
        state: { sessionKeys: {}, earlyEnvelopes: {}, dataChannels: {}, gridSettings: {} },
        API_BASE: '',
        fetch: () => Promise.reject(new Error('offline')),
        document: { addEventListener: () => {} },
        MAX_SECURE_MESSAGE_LENGTH: 4 * 1024 * 1024,
        logDebug: () => {}
    };
    vm.runInNewContext(readFileSync(new URL('../client/p2p.client.js', import.meta.url), 'utf8'), context);
    let releaseKey;
    context.deriveSessionKey = async peerId => {
        await new Promise(resolve => { releaseKey = resolve; });
        context.state.sessionKeys[peerId] = { key: true };
    };
    context.sendKeyHello = () => {};
    context.decryptSecurePayload = async (_peerId, envelope) => envelope.plain;
    context.handleSecurePayload = async (peerId, payload) => { handled.push(payload.type); };
    return { context, handled, release: () => releaseKey() };
}

const envelope = type => JSON.stringify({ type: 'SECURE_ENVELOPE', plain: { type } });

test('envelopes that arrive before the own session key are processed once it is ready', async () => {
    const { context, handled, release } = loadP2p();
    const hello = context.handleDataChannelMessage('bob', JSON.stringify({ type: 'KEY_HELLO', publicKey: {}, profileSigningKey: {} }));
    await context.handleDataChannelMessage('bob', envelope('PROFILE_REQUEST'));
    await context.handleDataChannelMessage('bob', envelope('CHAT_SYNC_HELLO'));
    assert.deepEqual(handled, [], 'held back while the key is being derived');
    release();
    await hello;
    assert.deepEqual(handled, ['PROFILE_REQUEST', 'CHAT_SYNC_HELLO'], 'processed in order afterwards');
    await context.handleDataChannelMessage('bob', envelope('PROFILE_RESPONSE'));
    assert.deepEqual(handled.at(-1), 'PROFILE_RESPONSE', 'later messages go straight through');
});

test('the early buffer is limited', async () => {
    const { context } = loadP2p();
    for (let index = 0; index < 80; index++) await context.handleDataChannelMessage('bob', envelope('CHAT_FOCUS'));
    assert.equal(context.state.earlyEnvelopes.bob.length, 50);
});
