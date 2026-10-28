import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { I18N_STUBS } from './i18n-stubs.js';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// Minimale Fake-IndexedDB: Requests melden ihr Ergebnis asynchron wie die echte API.
function fakeDatabase(stores) {
    const request = run => {
        const pending = {};
        queueMicrotask(() => {
            pending.result = run();
            pending.onsuccess?.();
        });
        return pending;
    };
    return {
        transaction: storeName => ({
            objectStore: () => ({
                get: key => request(() => stores[storeName].get(key)),
                getAll: () => request(() => [...stores[storeName].values()]),
                getAllKeys: () => request(() => [...stores[storeName].keys()]),
                put: value => request(() => stores[storeName].set(value.id ?? value.operationId, value)),
                delete: key => request(() => stores[storeName].delete(key))
            })
        })
    };
}

function loadStorage() {
    const stores = { messages: new Map(), chatOperations: new Map(), media: new Map() };
    const context = {
        state: { myProfile: { id: 'me', gallery: [] }, chatControls: {}, chats: {}, chatPreviews: {}, chatPeerIds: [], activeChatPeerId: null, cachedProfiles: {}, albums: {}, chatScopes: {} },
        showToast: () => {},
        notifyInApp: (kind, message, type) => context.showToast(message, type),
        document: { getElementById: () => null },
        subscribePresence: () => {},
        isPeerOnline: () => false,
        db: fakeDatabase(stores),
        renderActivePeerList: () => {},
        renderChatHistory: () => {},
        rememberChatPeer: () => {},
        messagePreview: message => message.text || 'Snap',
        CHAT_SCOPES: ['discovery', 'social'],
        setChatScope: async () => {},
        ensureChatScope: async () => {},
        currentChatScope: () => 'discovery',
        queueMicrotask,
        Date
    };
    vm.runInNewContext(read('client/app/storage.js'), Object.assign(context, I18N_STUBS));
    return { context, stores };
}

test('chat list preview keeps the newest visible message', () => {
    const { context } = loadStorage();
    context.updateChatPreview('peer', { id: 'a', senderId: 'peer', text: 'hallo', createdAt: 10 }, false);
    context.updateChatPreview('peer', { id: 'b', senderId: 'me', text: 'hi', createdAt: 20 }, false);
    context.updateChatPreview('peer', { id: 'c', senderId: 'peer', text: 'alt', createdAt: 5 }, false);
    context.updateChatPreview('peer', { id: 'd', senderId: 'peer', text: 'versteckt', createdAt: 30, held: true }, false);
    assert.deepEqual({ ...context.state.chatPreviews.peer }, { id: 'b', at: 20, mine: true, text: 'hi' });
});

test('SNAP_CONSUMED from the receiver deletes the sender copy unless it was saved', async () => {
    const { context, stores } = loadStorage();
    const snap = (id, extra = {}) => ({ id, peerId: 'peer', senderId: 'me', snapMode: 'replay', snapData: 'data:image/jpeg;base64,AA', createdAt: 1, ...extra });
    stores.messages.set('s1', snap('s1'));
    stores.messages.set('s2', snap('s2', { snapSaved: true }));
    stores.chatOperations.set('put:s1', { operationId: 'put:s1', message: snap('s1') });
    const consumed = messageId => ({ operationId: `consumed:${messageId}`, type: 'SNAP_CONSUMED', messageId, actorId: 'peer', createdAt: 2 });

    assert.equal(await context.applyChatOperation('peer', { ...consumed('s1'), actorId: 'me' }), false, 'only the receiver may report');
    assert.equal(await context.applyChatOperation('peer', consumed('s1')), true);
    assert.equal(stores.messages.get('s1').snapData, undefined);
    assert.equal(stores.chatOperations.get('put:s1').message.snapData, undefined);

    assert.equal(await context.applyChatOperation('peer', consumed('s2')), true);
    assert.ok(stores.messages.get('s2').snapData, 'saved snaps stay');
});

test('SNAP_SAVED from the receiver marks the sender copy as saved', async () => {
    const { context, stores } = loadStorage();
    const toasts = [];
    context.showToast = message => toasts.push(message);
    context.getPeerPresentation = () => ({ name: 'Bob' });
    stores.messages.set('s1', { id: 's1', peerId: 'peer', senderId: 'me', snapMode: 'replay', snapData: 'data:image/jpeg;base64,AA', createdAt: 1 });
    stores.messages.set('t1', { id: 't1', peerId: 'peer', senderId: 'me', text: 'kein snap', createdAt: 1 });
    const saved = (messageId, actorId = 'peer') => ({ operationId: `saved:${messageId}`, type: 'SNAP_SAVED', messageId, actorId, createdAt: 2 });

    assert.equal(await context.applyChatOperation('peer', saved('s1', 'me')), false, 'only the receiver may report');
    assert.equal(await context.applyChatOperation('peer', saved('t1')), false, 'only for snaps');
    assert.equal(await context.applyChatOperation('peer', saved('s1')), true);
    assert.equal(stores.messages.get('s1').savedByPeer, true);
    assert.deepEqual(toasts, ['Bob hat deinen Snap gespeichert.']);
});

test('grid auto-expand stops at ring 3 and when nobody else is around', () => {
    const context = { state: {} };
    vm.runInNewContext(read('client/grid.client.js'), Object.assign(context, I18N_STUBS));
    const expand = options => context.shouldAutoExpandGrid({ appMode: 'discovery', hasMore: true, peerCount: 0, ring: 0, ...options });
    assert.equal(expand({}), true);
    assert.equal(expand({ ring: 3 }), false);
    assert.equal(expand({ hasMore: false }), false);
    assert.equal(expand({ peerCount: 6 }), false);
    assert.equal(expand({ appMode: 'event' }), false);
});

test('custom display rules respect .hidden and the open action bar keeps its background', () => {
    const styles = read('client/styles.css');
    assert.match(styles, /\.nav-top-btn\.hidden,\s*\.nav-bottom-btn\.hidden/);
    const touchBlock = styles.slice(styles.indexOf('@media (hover: none) {\n    /* Unter #chat-messages'));
    assert.doesNotMatch(touchBlock.slice(0, touchBlock.indexOf('\n}\n')), /:hover \.message-actions/);
});

test('media cleanup keeps everything that is still referenced', async () => {
    const { context, stores } = loadStorage();
    context.state.myProfile.gallery = [{ id: 'img_own' }];
    context.state.cachedProfiles = { peer: { gallery: [{ id: 'img_peer' }] } };
    context.state.albums = { a: { items: [{ id: 'albimg_kept' }] } };
    stores.messages.set('m1', { id: 'm1', secureSnap: { snapId: 'open', encrypted: { iv: 'x', ciphertext: 'y' } } });
    stores.messages.set('m2', { id: 'm2', secureSnap: { snapId: 'done' } });
    for (const id of ['img_own', 'img_peer', 'albimg_kept', 'ssnap_open', 'ssnap_done', 'albimg_orphan', 'img_old']) stores.media.set(id, { id });

    await context.cleanupUnusedMedia();
    assert.deepEqual([...stores.media.keys()].sort(), ['albimg_kept', 'img_own', 'img_peer', 'ssnap_open']);
});

