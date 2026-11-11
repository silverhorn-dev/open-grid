import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

function load(role, alive = null) {
    const posted = [];
    const context = {
        APP_ROLE: role,
        state: {},
        Date,
        setTimeout: () => 0,
        clearTimeout: () => {},
        window: { localStorage: { getItem: () => (alive === null ? null : String(alive)) } },
        BroadcastChannel: class { postMessage(message) { posted.push(message); } close() {} },
        logDebug: () => {}
    };
    vm.runInNewContext(`${readFileSync(new URL('../client/app/core-link.js', import.meta.url), 'utf8')}\nthis.coreLink = coreLink;`, context);
    return { context, posted };
}

test('a page without a fresh core heartbeat starts as "full" right away (no probe)', async () => {
    const { context, posted } = load('full', null);
    assert.equal(await context.detectCoreRole(), 'full');
    assert.equal(posted.length, 0, 'normal browser: no message, no waiting');
    const stale = load('full', Date.now() - 60000);
    assert.equal(await stale.context.detectCoreRole(), 'full');
    assert.equal(stale.posted.length, 0);
});

test('writes are announced to the other page, except quiet core-only records; a "full" page announces nothing', () => {
    const { context, posted } = load('ui');
    context.coreLink.channel = { postMessage: message => posted.push(message) };
    context.coreLinkNotifyWrite('messages', { id: 'm1', peerId: 'bob' });
    context.coreLinkNotifyWrite('keys', { id: 'group:group_x' });
    context.coreLinkNotifyWrite('keys', { id: 'group-keys:group_x' });
    context.coreLinkNotifyWrite('keys', { id: 'peer-prekey:bob' });
    context.coreLinkNotifyWrite('media', { id: 'img' });
    context.coreLinkNotifyWrite('profiles', 'bob', 'delete');
    assert.deepEqual(posted.map(message => [message.store, message.key, message.peerId, message.op]), [
        ['messages', 'm1', 'bob', 'put'],
        ['keys', 'group:group_x', null, 'put'],
        ['profiles', 'bob', null, 'delete']
    ]);
    const full = load('full');
    full.context.coreLink.channel = { postMessage: message => full.posted.push(message) };
    full.context.coreLinkNotifyWrite('messages', { id: 'm1', peerId: 'bob' });
    assert.equal(full.posted.length, 0);
});
