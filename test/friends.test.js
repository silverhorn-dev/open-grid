import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { I18N_STUBS } from './i18n-stubs.js';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function loadFriends({ appMode = 'chat' } = {}) {
    const sent = [];
    const records = new Map();
    const toasts = [];
    const context = {
        state: {
            myProfile: { id: 'me', visibility: 2, fields: { displayName: 'Ich', secret: 'nur fuer freunde' }, privateFields: ['secret'], gallery: [{ id: 'img_1', version: 1 }], avatar: null },
            appMode,
            matchState: {},
            friendState: {},
            chatScopes: {},
            chatPeerIds: [],
            chats: {},
            cachedProfiles: {},
            chatControls: {},
            activeModalPeerId: null,
            activeChatPeerId: null
        },
        records,
        sent,
        toasts,
        isSocialMode: () => context.state.appMode === 'chat' || context.state.appMode === 'friends',
        isPeerBlocked: () => false,
        rememberChatPeer: peerId => { if (!context.state.chatPeerIds.includes(peerId)) context.state.chatPeerIds.push(peerId); },
        getPeerPresentation: peerId => ({ id: peerId, name: peerId }),
        showToast: (message, type) => toasts.push(`${type}: ${message}`),
        sendSecurePayload: async (peerId, payload) => sent.push({ peerId, payload }),
        syncChatGate: async () => {},
        getDatabaseRecordsByIndex: async () => [],
        pushStatusesToPeer: async () => {},
        forgetStatusesOf: async () => {},
        renderActivePeerList: () => {},
        renderProfileMatchActions: () => {},
        updateChatActionButtons: () => {},
        renderChatAllowance: () => {},
        logDebug: () => {},
        logBackgroundError: () => () => {},
        databaseRequest: async (store, _mode, run) => run({ get: id => records.get(`${store}:${id}`) }),
        putDatabaseRecord: async (store, value) => records.set(`${store}:${value.id}`, value),
        getAllDatabaseRecords: async store => [...records.entries()].filter(([key]) => key.startsWith(`${store}:`)).map(([, value]) => value),
        PROFILE_SCHEMA: [{ key: 'displayName' }, { key: 'secret' }],
        window: { crypto: globalThis.crypto, confirm: () => true },
        document: { getElementById: () => null, createElement: () => ({ append() {}, appendChild() {} }) },
        Date
    };
    // applyChatOperation-Ersatz: wie storage.js fuer Freundes-Operationen.
    context.applyChatOperation = async (peerId, operation) => {
        records.set(`chatOperations:${operation.operationId}`, { ...operation, peerId });
        return context.applyFriendOperation(peerId, operation);
    };
    vm.runInNewContext(read('client/app/matching.js'), Object.assign(context, I18N_STUBS));
    vm.runInNewContext(read('client/app/friends.js'), Object.assign(context, I18N_STUBS));
    return context;
}

const incoming = (type, at) => ({ operationId: `${type}:${at}`, type, actorId: 'peer', createdAt: at });

test('adding sends a request, adding back makes friends, reset declines', async () => {
    const me = loadFriends();
    await me.addFriend('peer');
    assert.equal(me.hasSentFriendRequest('peer'), true);
    assert.equal(me.isFriend('peer'), false);
    assert.equal(me.sent.at(-1).payload.operation.type, 'FRIEND_PING');

    await me.applyFriendOperation('peer', incoming('FRIEND_PING', Date.now() + 1));
    assert.equal(me.isFriend('peer'), true);
    assert.equal(me.state.chatScopes.peer, 'social', 'friends move to the social list');
    assert.ok(me.sent.some(entry => entry.payload.type === 'PROFILE_REQUEST'), 'refreshes the full profile');

    // Neue Anfrage von jemand anderem ablehnen.
    await me.applyFriendOperation('other', { ...incoming('FRIEND_PING', Date.now()), actorId: 'other' });
    assert.equal(me.hasFriendRequest('other'), true);
    await me.resetFriendship('other');
    assert.equal(me.hasFriendRequest('other'), false);
    assert.equal(me.sent.at(-1).payload.operation.type, 'FRIEND_RESET');
});

test('operations from third parties are rejected', async () => {
    const me = loadFriends();
    assert.equal(await me.applyFriendOperation('peer', { ...incoming('FRIEND_PING', 1), actorId: 'mallory' }), false);
    assert.equal(me.hasFriendRequest('peer'), false);
});

test('friends get the full profile, others only the public part', async () => {
    const me = loadFriends();
    assert.equal(me.buildProfilePayloadFor('peer').fields.secret, undefined);
    me.state.friendState.peer = { sentAt: 2, receivedAt: 3, resetAt: 1 };
    const profile = me.buildProfilePayloadFor('peer');
    assert.equal(profile.fields.secret, 'nur fuer freunde');
    assert.equal(profile.audience, 'peer', 'bound to this friend');
    assert.equal(me.getPeerChatAllowance('peer').allowed, true);
});

test('chat lists are separated by scope, old chats show in both', async () => {
    const me = loadFriends({ appMode: 'chat' });
    await me.ensureChatScope('dating', 'discovery');
    await me.ensureChatScope('buddy', 'social');
    await me.ensureChatScope('buddy', 'discovery');
    assert.equal(me.state.chatScopes.buddy, 'social', 'first scope wins');
    assert.equal(me.isInCurrentChatList('buddy'), true);
    assert.equal(me.isInCurrentChatList('dating'), false);
    assert.equal(me.isInCurrentChatList('legacy'), true);
    me.state.appMode = 'discovery';
    assert.equal(me.isInCurrentChatList('dating'), true);
    assert.equal(me.isInCurrentChatList('buddy'), false);
    await me.loadChatScopes();
    assert.deepEqual({ ...me.state.chatScopes }, { dating: 'discovery', buddy: 'social' }, 'persisted');
});

test('grid and event keep flames, chat and friends speak of adding', () => {
    const me = loadFriends({ appMode: 'discovery' });
    assert.equal(me.connectionWording().action, 'Sende eine Flamme');
    me.state.appMode = 'friends';
    assert.equal(me.connectionWording().action, 'Adde die Person');
});

test('grid matches can be added only after a match and only if allowed, silently otherwise', async () => {
    const me = loadFriends({ appMode: 'discovery' });
    await me.ensureChatScope('dating', 'discovery');
    const ping = { operationId: 'friend:1', type: 'FRIEND_PING', actorId: 'dating', createdAt: 10 };

    // Ohne Match: Anfrage wird gespeichert, aber nicht gezeigt; adden geht nicht.
    await me.applyFriendOperation('dating', ping);
    assert.equal(me.hasFriendRequest('dating'), false);
    assert.equal(me.toasts.length, 0, 'no notification');
    await me.addFriend('dating');
    assert.equal(me.hasSentFriendRequest('dating'), false);

    // Nach dem Match erscheint die Anfrage, annehmen verschiebt den Chat.
    me.state.matchState.dating = { sentAt: 2, receivedAt: 3, resetAt: 0 };
    assert.equal(me.hasFriendRequest('dating'), true);
    await me.addFriend('dating');
    assert.equal(me.isFriend('dating'), true);
    assert.equal(me.chatScopeOf('dating'), 'social');

    // Abgeschaltet: Anfragen von Matches bleiben unsichtbar.
    const other = loadFriends({ appMode: 'discovery' });
    other.state.myProfile.allowMatchFriends = false;
    await other.ensureChatScope('date2', 'discovery');
    other.state.matchState.date2 = { sentAt: 2, receivedAt: 3, resetAt: 0 };
    await other.applyFriendOperation('date2', { ...ping, actorId: 'date2' });
    assert.equal(other.hasFriendRequest('date2'), false);
    assert.equal(other.toasts.length, 0);
    assert.equal(other.buildProfilePayloadFor('date2').allowMatchFriends, false, 'flag travels in the profile');

    // Hat der Match es abgeschaltet, gibt es keinen "Adden"-Knopf und keine Anfrage.
    const sender = loadFriends({ appMode: 'discovery' });
    await sender.ensureChatScope('shy', 'discovery');
    sender.state.matchState.shy = { sentAt: 2, receivedAt: 3, resetAt: 0 };
    sender.state.cachedProfiles.shy = { allowMatchFriends: false };
    assert.equal(sender.canAddMatch('shy'), false);
    await sender.addFriend('shy');
    assert.equal(sender.sent.length, 0);
    sender.state.cachedProfiles.shy = { allowMatchFriends: true };
    assert.equal(sender.canAddMatch('shy'), true);
});

function loadStatus() {
    const context = loadFriends({ appMode: 'chat' });
    Object.assign(context.state, { statuses: {}, statusSettings: { directOnly: false }, statusPushes: {}, storageKey: null });
    context.deleteDatabaseRecord = async (store, id) => context.records.delete(`${store}:${id}`);
    context.isSafeInlineImage = value => typeof value === 'string' && value.startsWith('data:image/');
    context.isTraceWatermarkEnabled = () => false;
    context.renderStatusBar = () => {};
    context.closeStatusViewer = () => {};
    context.closeMediaModal = () => {};
    context.setInterval = setInterval;
    context.clearInterval = clearInterval;
    vm.runInNewContext(read('client/app/status.js'), Object.assign(context, I18N_STUBS));
    context.renderStatusBar = () => {};
    return context;
}

test('status goes only to friends, comes only from friends and expires after 24 h', async () => {
    const me = loadStatus();
    me.state.friendState = { buddy: { sentAt: 2, receivedAt: 3, resetAt: 0 }, stranger: emptyEntry() };
    const status = await me.createOwnStatus({ kind: 'text', text: 'Im Park', color: '#7c3aed' });
    const posts = me.sent.filter(entry => entry.payload.operation?.type === 'STATUS_POST');
    assert.deepEqual(posts.map(entry => entry.peerId), ['buddy'], 'only friends get it');
    assert.ok(status.expiresAt - status.createdAt <= 24 * 60 * 60 * 1000);

    // Eingang: nur von Freunden, Ablauf hoechstens 24 h ab jetzt.
    const now = Date.now();
    const incoming = { operationId: 'status:x', type: 'STATUS_POST', actorId: 'buddy', statusId: 'st_x', kind: 'text', text: 'hi', color: '#7c3aed', createdAt: now, expiresAt: now + 7 * 24 * 60 * 60 * 1000 };
    assert.equal(await me.handleStatusOperation('buddy', incoming), true);
    assert.ok(me.state.statuses.st_x.expiresAt <= now + 24 * 60 * 60 * 1000 + 50, 'clamped to 24 h');
    assert.equal(await me.handleStatusOperation('stranger', { ...incoming, actorId: 'stranger', statusId: 'st_y' }), false);
    assert.equal(me.state.statuses.st_y, undefined);

    // Aufraeumen nach Ablauf entfernt Datensatz und Zustand.
    const removed = await me.removeExpiredStatuses(now + 25 * 60 * 60 * 1000);
    assert.ok(removed >= 2);
    assert.equal(Object.keys(me.state.statuses).length, 0);
    assert.equal([...me.records.keys()].some(key => key.startsWith('statusUpdates:')), false);
});

test('direct-only status uses no cache fallback and deletes reach friends', async () => {
    const me = loadStatus();
    me.state.friendState = { buddy: { sentAt: 2, receivedAt: 3, resetAt: 0 } };
    const fallbacks = [];
    me.sendSecurePayload = async (peerId, payload, onSent) => { me.sent.push({ peerId, payload }); fallbacks.push(onSent); };
    me.state.statusSettings.directOnly = true;
    const status = await me.createOwnStatus({ kind: 'text', text: 'nur direkt', color: '#7c3aed' });
    assert.equal(fallbacks.at(-1), null, 'no Path C fallback');
    me.window.confirm = () => true;
    await me.deleteOwnStatus(status.id);
    assert.equal(me.sent.at(-1).payload.operation.type, 'STATUS_DELETE');
    assert.equal(me.state.statuses[status.id], undefined);
});

function emptyEntry() {
    return { sentAt: 0, receivedAt: 0, resetAt: 0 };
}

