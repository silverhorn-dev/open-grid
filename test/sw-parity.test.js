import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// Fake-IndexedDB mit Transaktionen: Requests melden sich asynchron, oncomplete feuert,
// sobald keine Requests mehr offen sind (wie in der echten API).
function fakeDatabase(stores) {
    const keyOf = value => value.id ?? value.operationId;
    return {
        transaction(_names) {
            let pending = 0;
            const transaction = {};
            const settle = () => setTimeout(() => {
                if (pending === 0) transaction.oncomplete?.();
            }, 0);
            const request = run => {
                pending += 1;
                const result = {};
                queueMicrotask(() => {
                    result.result = run();
                    pending -= 1;
                    result.onsuccess?.();
                    settle();
                });
                return result;
            };
            transaction.objectStore = name => ({
                get: key => request(() => stores[name].get(key)),
                getAll: () => request(() => [...stores[name].values()]),
                put: value => request(() => stores[name].set(keyOf(value), structuredClone(value)))
            });
            settle();
            return transaction;
        }
    };
}

function emptyStores() {
    return { messages: new Map(), chatOperations: new Map(), keys: new Map() };
}

function loadServiceWorker() {
    const context = {
        self: { addEventListener: () => {}, registration: {}, clients: {}, location: { origin: '' } },
        __PRECACHE_URLS__: [],
        __SW_TEXTS__: {},
        setTimeout,
        queueMicrotask,
        structuredClone
    };
    vm.runInNewContext(read('client/sw.js'), context);
    return context;
}

function loadPage(stores, gated) {
    const context = {
        state: { myProfile: { id: 'me' }, chatControls: {}, chats: {}, chatPreviews: {}, chatPeerIds: [], activeChatPeerId: null },
        db: fakeDatabase(stores),
        shouldHoldIncomingMessage: async () => gated,
        CHAT_SCOPES: ['discovery', 'social'],
        ensureChatScope: async () => {},
        currentChatScope: () => 'discovery',
        renderActivePeerList: () => {},
        renderChatHistory: () => {},
        subscribePresence: () => {},
        isPeerOnline: () => false,
        messagePreview: message => message.text || '',
        isSafeInlineImage: () => false,
        setTimeout,
        queueMicrotask,
        Date
    };
    vm.runInNewContext(read('client/app/storage.js'), context);
    return context;
}

const message = { id: 'm1', senderId: 'peer', text: 'hallo', timestamp: '10:00', createdAt: 5 };
const operation = { operationId: 'put:m1', type: 'MESSAGE_PUT', messageId: 'm1', actorId: 'peer', createdAt: 5, message };

// Vergleichbarer Zustand: Zustellweg und Debug-Felder unterscheiden sich bewusst.
function snapshot(stores) {
    const stored = stores.messages.get('m1');
    return {
        message: stored ? { text: stored.text, deleted: Boolean(stored.deleted), held: Boolean(stored.held) } : null,
        operation: stores.chatOperations.has('put:m1')
    };
}

async function runBoth(prepare, gated = false) {
    const swStores = emptyStores();
    const pageStores = emptyStores();
    prepare(swStores);
    prepare(pageStores);
    const sw = loadServiceWorker();
    await sw.storeMessagePut(fakeDatabase(swStores), 'peer', structuredClone(operation), gated);
    const page = loadPage(pageStores, gated);
    await page.applyChatOperation('peer', structuredClone(operation));
    return { sw: snapshot(swStores), page: snapshot(pageStores) };
}

test('service worker and page store a new message the same way', async () => {
    const { sw, page } = await runBoth(() => {});
    assert.deepEqual(sw, page);
    assert.deepEqual(sw, { message: { text: 'hallo', deleted: false, held: false }, operation: true });
});

test('both ignore an operation they already know', async () => {
    const { sw, page } = await runBoth(stores => {
        stores.chatOperations.set('put:m1', { ...operation, peerId: 'peer' });
        stores.messages.set('m1', { ...message, peerId: 'peer', text: 'original' });
    });
    assert.deepEqual(sw, page);
    assert.equal(sw.message.text, 'original');
});

test('both keep a deleted message deleted', async () => {
    const { sw, page } = await runBoth(stores => {
        stores.messages.set('m1', { id: 'm1', peerId: 'peer', senderId: 'peer', text: '', deleted: true, createdAt: 5 });
    });
    assert.deepEqual(sw, page);
    assert.equal(sw.message.deleted, true);
});

test('both hold back messages from gated senders', async () => {
    const { sw, page } = await runBoth(() => {}, true);
    assert.deepEqual(sw, page);
    assert.equal(sw.message.held, true);
});
