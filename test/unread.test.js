import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function loadUnread({ stored = null, visible = null, blocked = [], messages = {}, scopes = {} } = {}) {
    const written = [];
    const badges = [{ textContent: '', classList: { toggle() {} } }];
    const context = {
        state: { chatReads: {}, unreadCounts: {}, chats: {} },
        document: { title: 'OpenGrid', querySelectorAll: () => badges, getElementById: () => null },
        navigator: {},
        Date, Math, Number, Object, String,
        databaseRequest: async () => stored,
        putDatabaseRecord: async record => { written.push(record); },
        getDatabaseRecordsByIndex: async (_store, _index, peerId) => messages[peerId] || [],
        isPeerBlocked: peerId => blocked.includes(peerId),
        isChatVisibleFor: peerId => peerId === visible,
        renderActivePeerList: () => {},
        otherChatScope: () => 'social',
        chatScopeOf: peerId => scopes[peerId] || null,
        logDebug: () => {}
    };
    vm.runInNewContext(read('client/app/unread.js'), context);
    return { context, written, badges };
}

const fromPeer = (peerId, createdAt, extra = {}) => ({ id: `${peerId}-${createdAt}`, peerId, senderId: peerId, createdAt, ...extra });

test('first start marks all existing chats as read', async () => {
    const { context, written } = loadUnread();
    await context.loadChatReads();
    assert.ok(context.state.chatReads['*'] > 0);
    assert.equal(written.length, 1);
    context.recountAllUnread([fromPeer('a', 1000)]);
    assert.equal(context.unreadCountOf('a'), 0);
});

test('only the partner\'s visible messages after the read marker count', async () => {
    const { context } = loadUnread({ stored: { reads: { a: 100 } } });
    await context.loadChatReads();
    context.recountAllUnread([
        fromPeer('a', 50),
        fromPeer('a', 150),
        fromPeer('a', 160, { deleted: true }),
        fromPeer('a', 170, { held: true }),
        { id: 'own', peerId: 'a', senderId: 'me', createdAt: 200 },
        fromPeer('b', 10)
    ]);
    assert.equal(context.unreadCountOf('a'), 1);
    // Ohne eigenen Lesestand gilt '*' (fehlt hier = 0): alles vom Partner ist ungelesen.
    assert.equal(context.unreadCountOf('b'), 1);
    assert.equal(context.totalUnread(), 2);
});

test('blocked chats never show unread messages', async () => {
    const { context } = loadUnread({ stored: { reads: {} }, blocked: ['a'] });
    await context.loadChatReads();
    context.recountAllUnread([fromPeer('a', 10)]);
    assert.equal(context.unreadCountOf('a'), 0);
});

test('reading a chat clears it, even with a sender clock ahead of ours', async () => {
    const future = Date.now() + 60 * 60 * 1000;
    const { context } = loadUnread({ stored: { reads: { a: 0 } }, messages: { a: [fromPeer('a', future)] } });
    await context.loadChatReads();
    await context.refreshUnread('a');
    assert.equal(context.unreadCountOf('a'), 1);
    context.state.chats.a = [fromPeer('a', future)];
    await context.markChatRead('a');
    assert.equal(context.unreadCountOf('a'), 0);
    assert.ok(context.state.chatReads.a >= future);
    await context.refreshUnread('a');
    assert.equal(context.unreadCountOf('a'), 0);
});

test('a message into the visible chat is read right away', async () => {
    const { context } = loadUnread({ stored: { reads: { a: 0 } }, visible: 'a', messages: { a: [fromPeer('a', 10)] } });
    await context.loadChatReads();
    await context.refreshUnread('a');
    assert.equal(context.unreadCountOf('a'), 0);
});

test('totals show in the title and cap at 99+', async () => {
    const { context } = loadUnread({ stored: { reads: {} } });
    await context.loadChatReads();
    context.recountAllUnread(Array.from({ length: 120 }, (_, index) => fromPeer('a', index + 1)));
    assert.equal(context.document.title, '(99+) OpenGrid');
    assert.equal(context.formatUnreadCount(5), '5');
});
