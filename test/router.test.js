import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

function loadRouter(pathname, search = '') {
    const calls = [];
    const window = {
        location: { pathname, search, href: `http://localhost${pathname}${search}` },
        history: {
            state: null,
            replaceState(state, _title, path) {
                calls.push(['replace', path]);
                this.state = state;
                window.location.pathname = path;
            },
            pushState(state, _title, path) {
                calls.push(['push', path]);
                this.state = state;
                window.location.pathname = path;
            }
        }
    };
    const context = { window, state: { activeChatPeerId: null }, URLSearchParams };
    vm.runInNewContext(readFileSync(new URL('../client/app/router.js', import.meta.url), 'utf8'), context);
    return { context, window, calls };
}

test('parses tab and chat routes', () => {
    const { context } = loadRouter('/grid');
    assert.deepEqual({ ...context.parseRoute('/chat/peer%20a') }, { tab: 'chat', peerId: 'peer a' });
    assert.deepEqual({ ...context.parseRoute('/settings/') }, { tab: 'keys', peerId: null });
    assert.deepEqual({ ...context.parseRoute('/profile') }, { tab: 'editprofile', peerId: null });
    assert.deepEqual({ ...context.parseRoute('/unknown') }, { tab: 'grid', peerId: null });
});

test('rewrites the root and legacy push deep links to real paths', () => {
    const root = loadRouter('/');
    assert.equal(root.context.resolveInitialRoute().tab, 'grid');
    assert.deepEqual(root.calls, [['replace', '/grid']]);

    const legacy = loadRouter('/', '?chat=peer-b');
    assert.equal(legacy.context.resolveInitialRoute().peerId, 'peer-b');
    assert.deepEqual(legacy.calls, [['replace', '/chat/peer-b']]);
});

test('pushes tab changes and replaces modal entries', () => {
    const { context, window, calls } = loadRouter('/grid');
    context.syncRoute('chat');
    assert.deepEqual(calls.at(-1), ['push', '/chat']);
    assert.equal(window.history.state.from, '/grid');

    context.pushModalEntry('menu', () => {});
    context.syncRoute('keys');
    assert.deepEqual(calls.at(-1), ['replace', '/settings']);
    assert.equal(window.history.state.modal, undefined);

    context.state.activeChatPeerId = 'peer-c';
    context.syncRoute('chat');
    assert.deepEqual(calls.at(-1), ['push', '/chat/peer-c']);
});
