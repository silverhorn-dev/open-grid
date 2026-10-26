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
