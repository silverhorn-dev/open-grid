import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

function loadP2p(gridSettings = { lanOnly: false }, serverLanMode = false) {
    const context = {
        state: { gridSettings, serverLanMode },
        API_BASE: '',
        fetch: () => Promise.reject(new Error('offline')),
        document: { addEventListener: () => {} },
        logDebug: () => {}
    };
    vm.runInNewContext(readFileSync(new URL('../client/p2p.client.js', import.meta.url), 'utf8'), context);
    return context;
}

test('classifies the selected candidate pair', () => {
    const context = loadP2p();
    assert.equal(context.classifyTransport('host', 'host'), 'lan');
    assert.equal(context.classifyTransport('srflx', 'host'), 'direct');
    assert.equal(context.classifyTransport('host', 'relay'), 'relay');
});

test('LAN-only mode drops STUN/TURN servers for new connections', () => {
    assert.ok(loadP2p().getRtcConfig().iceServers.length > 0);
    assert.equal(loadP2p({ lanOnly: true }).getRtcConfig().iceServers.length, 0);
    assert.equal(loadP2p({ lanOnly: false }, true).getRtcConfig().iceServers.length, 0, 'server LAN_MODE wins');
});

test('"peer unavailable" toast only for the open chat, at most every 5 minutes per peer', () => {
    const context = loadP2p();
    context.CONFIG = { DEBUG_MODE: true };
    context.state.activeChatPeerId = 'alice';
    const toast = (peerId, now) => context.shouldToastPeerUnavailable(peerId, now);
    assert.equal(toast('bob', 1000), false, 'background attempts (not the open chat) stay in the log');
    assert.equal(toast('alice', 1000), true);
    assert.equal(toast('alice', 60_000), false, 'no repeat within 5 minutes');
    assert.equal(toast('alice', 1000 + 5 * 60 * 1000), true);
    context.CONFIG.DEBUG_MODE = false;
    assert.equal(toast('alice', 10 * 60 * 1000 + 1000), false, 'never without debug mode');
});
