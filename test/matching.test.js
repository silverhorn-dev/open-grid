import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { I18N_STUBS } from './i18n-stubs.js';

function loadMatching({ visibility = 1, chatPolicy, privateFields = [], stored = [] } = {}) {
    const context = {
        state: {
            myProfile: {
                id: 'me',
                version: 4,
                updatedAt: 1,
                visibility,
                chatPolicy,
                privateFields,
                fields: { displayName: 'Me', age: 30, bio: 'secret bio' },
                avatar: 'data:image/jpeg;base64,AAAA',
                gallery: [{ id: 'img_1', version: 1 }]
            },
            matchState: {},
            friendState: {},
            chatScopes: {},
            appMode: 'discovery',
            chats: {},
            cachedProfiles: {}
        },
        isSocialMode: () => false,
        getDatabaseRecordsByIndex: async () => stored,
        PROFILE_SCHEMA: [{ key: 'displayName' }, { key: 'age' }, { key: 'bio' }],
        Date,
        Math,
        Number,
        Boolean,
        Object,
        Set
    };
    vm.runInNewContext(readFileSync(new URL('../client/app/matching.js', import.meta.url), 'utf8'), Object.assign(context, I18N_STUBS));
    vm.runInNewContext(readFileSync(new URL('../client/app/friends.js', import.meta.url), 'utf8'), Object.assign(context, I18N_STUBS));
    return context;
}

const plain = value => JSON.parse(JSON.stringify(value));

test('a match needs a flame from both sides after the last reset', () => {
    const context = loadMatching();
    context.recordMatchOperation('peer', { type: 'MATCH_PING', actorId: 'me', createdAt: 10 });
    assert.equal(context.isMatched('peer'), false);
    context.recordMatchOperation('peer', { type: 'MATCH_PING', actorId: 'peer', createdAt: 20 });
    assert.equal(context.isMatched('peer'), true);
    context.recordMatchOperation('peer', { type: 'MATCH_RESET', actorId: 'peer', createdAt: 30 });
    assert.equal(context.isMatched('peer'), false);
    assert.equal(context.hasReceivedFlame('peer'), false);
    context.recordMatchOperation('peer', { type: 'MATCH_PING', actorId: 'peer', createdAt: 40 });
    context.recordMatchOperation('peer', { type: 'MATCH_PING', actorId: 'me', createdAt: 50 });
    assert.equal(context.isMatched('peer'), true);
});

test('chat policy B holds messages above the limit and images when disabled', async () => {
    const received = id => ({ id, senderId: 'peer' });
    const context = loadMatching({
        chatPolicy: { mode: 'B', limit: 3, allowImages: false },
        stored: [received('m1'), received('m2'), received('m3')]
    });
    assert.equal(await context.shouldHoldIncomingMessage('peer', { id: 'm4', senderId: 'peer' }), true);

    const below = loadMatching({ chatPolicy: { mode: 'B', limit: 3, allowImages: false }, stored: [received('m1')] });
    assert.equal(await below.shouldHoldIncomingMessage('peer', { id: 'm2', senderId: 'peer' }), false);
    assert.equal(await below.shouldHoldIncomingMessage('peer', { id: 'm3', senderId: 'peer', snapData: 'x' }), true);

    // Wer selbst schon geschrieben hat, hat den Chat angenommen.
    const replied = loadMatching({
        chatPolicy: { mode: 'C' },
        stored: [{ id: 'mine', senderId: 'me' }]
    });
    assert.equal(await replied.shouldHoldIncomingMessage('peer', { id: 'x', senderId: 'peer' }), false);
});

test('chat policy C holds everything until a match', async () => {
    const context = loadMatching({ chatPolicy: { mode: 'C' } });
    assert.equal(await context.shouldHoldIncomingMessage('peer', { id: 'x', senderId: 'peer' }), true);
    context.recordMatchOperation('peer', { type: 'MATCH_PING', actorId: 'me', createdAt: 1 });
    context.recordMatchOperation('peer', { type: 'MATCH_PING', actorId: 'peer', createdAt: 2 });
    assert.equal(await context.shouldHoldIncomingMessage('peer', { id: 'x', senderId: 'peer' }), false);
});

test('profiles are built per viewer according to the visibility level', () => {
    const partial = loadMatching({ visibility: 2, privateFields: ['bio'] });
    const restricted = plain(partial.buildProfilePayloadFor('stranger'));
    assert.deepEqual(restricted.fields, { displayName: 'Me', age: 30 });
    assert.deepEqual(restricted.gallery, []);
    assert.equal(restricted.audience, 'public');
    assert.equal(partial.isGalleryVisibleTo('stranger'), false);

    partial.recordMatchOperation('friend', { type: 'MATCH_PING', actorId: 'me', createdAt: 1 });
    partial.recordMatchOperation('friend', { type: 'MATCH_PING', actorId: 'friend', createdAt: 2 });
    const full = plain(partial.buildProfilePayloadFor('friend'));
    assert.equal(full.fields.bio, 'secret bio');
    assert.equal(full.gallery.length, 1);
    assert.equal(full.audience, 'friend', 'match profile is bound to the viewer');
    assert.equal(partial.isProfileShareable(full), false);

    const hidden = loadMatching({ visibility: 3 });
    const anonymous = plain(hidden.buildProfilePayloadFor('stranger'));
    assert.deepEqual(anonymous.fields, {});
    assert.equal(anonymous.avatar, null);
    assert.deepEqual(plain(hidden.getRegistrationIdentity()), { name: '', thumbnail: null });
});

test('only public or own-audience profiles are accepted', () => {
    const context = loadMatching();
    assert.equal(context.isProfileAudienceAcceptable({ audience: 'public' }), true);
    assert.equal(context.isProfileAudienceAcceptable({}), true);
    assert.equal(context.isProfileAudienceAcceptable({ audience: 'me' }), true);
    assert.equal(context.isProfileAudienceAcceptable({ audience: 'someone-else' }), false);
});

test('the sender sees the remaining messages of the receiver policy', () => {
    const context = loadMatching();
    context.state.cachedProfiles.peer = { chatPolicy: { mode: 'B', limit: 3, allowImages: false } };
    context.state.chats.peer = [{ id: 'a', senderId: 'me' }];
    const allowance = plain(context.getPeerChatAllowance('peer'));
    assert.equal(allowance.allowed, true);
    assert.equal(allowance.remaining, 2);
    assert.equal(allowance.images, false);

    context.state.cachedProfiles.peer = { chatPolicy: { mode: 'C' } };
    assert.equal(context.getPeerChatAllowance('peer').allowed, false);
    context.state.chats.peer.push({ id: 'b', senderId: 'peer' });
    assert.equal(context.getPeerChatAllowance('peer').allowed, true, 'a reply from the peer accepts the chat');
});

// Einladung in "Entdecken": die Chat-Sperre ("Nur Matches") gilt auch fuer Eingeladene. Ohne Profil
// ist sie unbekannt, also erst laden statt Nachrichten zu schicken, die der andere zurueckhaelt.
test('discovery chats without a known profile wait for it before writing', () => {
    const context = loadMatching();
    const requested = [];
    context.requestMissingProfile = peerId => requested.push(peerId);
    context.state.chatScopes.invited = 'discovery';
    const waiting = plain(context.getPeerChatAllowance('invited'));
    assert.equal(waiting.allowed, false);
    assert.match(waiting.reason, /Profil wird geladen/);
    assert.deepEqual(requested, ['invited']);

    context.state.cachedProfiles.invited = { chatPolicy: { mode: 'C' } };
    assert.equal(context.getPeerChatAllowance('invited').allowed, false, 'the lock stays for invited peers');
    context.state.chatScopes.friend = 'social';
    assert.equal(context.getPeerChatAllowance('friend').allowed, true, 'social chats are not held');
});

test('only fields of the active profile schema are sent', () => {
    const context = loadMatching();
    context.state.myProfile.fields.role = 'dating detail';
    context.PROFILE_SCHEMA = [{ key: 'displayName' }, { key: 'status' }];
    const payload = plain(context.buildProfilePayloadFor('stranger'));
    assert.deepEqual(Object.keys(payload.fields), ['displayName']);
});

// Regression: das Profil richtete sich nach dem eigenen aktiven Modus; wer in "Entdecken" war,
// schickte Chat-Kontakten sein Dating-Profil (und umgekehrt).
test('the profile a peer gets follows the list of the chat, not the own active mode', () => {
    const context = loadMatching();
    Object.assign(context.state.myProfile.fields, { status: 'Hi', role: 'dating detail', workshop: 'Rust' });
    Object.assign(context.state.chatScopes, { contact: 'social', dating: 'discovery' });
    context.PROFILE_SCHEMA = [{ key: 'displayName' }, { key: 'age' }, { key: 'role' }];
    context.PROFILE_SCHEMAS = {
        discovery: [{ key: 'displayName' }, { key: 'age' }, { key: 'role' }],
        chat: [{ key: 'displayName' }, { key: 'status' }],
        friends: [{ key: 'displayName' }, { key: 'bio' }],
        event: [{ key: 'displayName' }, { key: 'workshop' }]
    };
    const fieldsFor = peerId => Object.keys(plain(context.buildProfilePayloadFor(peerId)).fields).sort();
    context.state.appMode = 'discovery';
    assert.deepEqual(fieldsFor('contact'), ['displayName', 'status'], 'chat contact gets the chat profile while I explore');
    assert.deepEqual(fieldsFor('dating'), ['age', 'displayName', 'role']);
    assert.deepEqual(fieldsFor('stranger'), ['age', 'displayName', 'role'], 'no chat yet: active mode');
    context.state.appMode = 'chat';
    context.PROFILE_SCHEMA = context.PROFILE_SCHEMAS.chat;
    assert.deepEqual(fieldsFor('dating'), ['age', 'displayName', 'role'], 'dating chat keeps the dating profile while I am in chat mode');
    context.state.appMode = 'event';
    assert.deepEqual(fieldsFor('dating'), ['displayName', 'workshop'], 'event schema while in an event');
    context.state.friendState.contact = { sentAt: 2, receivedAt: 3, resetAt: 0 };
    assert.deepEqual(fieldsFor('contact'), ['bio', 'displayName'], 'friends get the friends profile');
});

test('flames stack, fade after the router time, reset clears them and flames continue after a match', () => {
    const context = loadMatching();
    const now = Date.now();
    const hour = 60 * 60 * 1000;
    assert.equal(context.flameVisibleMs(), 48 * hour, 'default: two days');
    assert.equal(context.flameCooldownMs(), hour, 'default: one hour');
    context.recordMatchOperation('peer', { type: 'MATCH_PING', actorId: 'peer', createdAt: now - 60 * hour });
    assert.equal(context.visibleFlameCount('peer', now), 0, 'older than two days: gone');
    assert.equal(context.hasReceivedFlame('peer'), true, 'flaming back still makes a match');
    context.recordMatchOperation('peer', { type: 'MATCH_PING', actorId: 'peer', createdAt: now - 30 * hour });
    context.recordMatchOperation('peer', { type: 'MATCH_PING', actorId: 'me', createdAt: now - 30 * hour + 5 });
    assert.equal(context.isMatched('peer'), true);
    assert.equal(context.visibleFlameCount('peer', now), 1);
    // Nach dem Match weitere Flammen: sie stapeln sich, das Match bleibt.
    context.recordMatchOperation('peer', { type: 'MATCH_PING', actorId: 'peer', createdAt: now - 2 * hour });
    context.recordMatchOperation('peer', { type: 'MATCH_PING', actorId: 'peer', createdAt: now - 2 * hour });
    context.recordMatchOperation('peer', { type: 'MATCH_PING', actorId: 'peer', createdAt: now - 10 });
    assert.equal(context.visibleFlameCount('peer', now), 3, 'the same flame twice counts once');
    assert.equal(context.isMatched('peer'), true);
    // Der Router legt die Zeiten fest.
    context.state.appConfig = { flames: { visibleHours: 24, cooldownMinutes: 5 } };
    assert.equal(context.visibleFlameCount('peer', now), 2, 'shorter visibility');
    assert.equal(context.flameCooldownMs(), 5 * 60 * 1000);
    context.recordMatchOperation('peer', { type: 'MATCH_RESET', actorId: 'me', createdAt: now - 5 });
    assert.equal(context.visibleFlameCount('peer', now), 0, 'unmatching clears the flames');
});
