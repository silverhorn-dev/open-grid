import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

function loadModes(appMode = 'discovery') {
    const records = new Map();
    const context = {
        state: {
            appMode,
            appConfig: { modes: ['discovery', 'chat', 'friends', 'event'], defaultMode: 'discovery' },
            appModeSettings: {},
            myProfile: { id: 'me', geohash: 'u10j2k' },
            gridRing: 2,
            gridSettings: { liveGrid: true }
        },
        window: { crypto: globalThis.crypto, location: { origin: 'https://grid.example' } },
        TextEncoder,
        URLSearchParams,
        databaseRequest: async (_store, _mode, run) => run({ get: id => records.get(id) }),
        deleteDatabaseRecord: async (_store, id) => records.delete(id),
        putDatabaseRecord: async (_store, value) => records.set(value.id, value),
        showToast: () => {},
        Date
    };
    vm.runInNewContext(readFileSync(new URL('../client/app/modes.js', import.meta.url), 'utf8'), context);
    return { context, records };
}

test('builds the grid query and registration scope per mode', () => {
    const discovery = loadModes('discovery');
    assert.equal(discovery.context.buildGridQuery().toString(), 'geohash=u10j2k&ring=2&live=1');
    assert.deepEqual({ ...discovery.context.getRegistrationScope() }, { scope: 'public' });

    const friends = loadModes('friends');
    assert.equal(friends.context.buildGridQuery().toString(), 'geohash=u10j2k&scope=friends&peerId=me');
    assert.deepEqual({ ...friends.context.getRegistrationScope() }, { scope: 'friends' });

    const chat = loadModes('chat');
    assert.equal(chat.context.isGridAvailable(), false);
    assert.equal(chat.context.isModeSilent(), true);

    const event = loadModes('event');
    event.context.state.appModeSettings = { eventHash: 'f'.repeat(64), eventJoinedAt: Date.now() };
    assert.deepEqual({ ...event.context.getRegistrationScope() }, { scope: 'event', eventHash: 'f'.repeat(64) });
    event.context.state.appModeSettings.eventJoinedAt = Date.now() - 13 * 60 * 60 * 1000;
    assert.equal(event.context.hasActiveEvent(), false, 'events expire after 12 hours');
});

test('event codes are normalized and only their hash is used', async () => {
    const { context } = loadModes();
    assert.equal(context.normalizeEventCode('  pride   24 '), 'PRIDE 24');
    const first = await context.hashEventCode('PRIDE 24');
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal(await context.hashEventCode('PRIDE 24'), first);
    assert.notEqual(await context.hashEventCode('PRIDE 25'), first);
});

test('invite links carry the key fingerprint and are verified on first contact', async () => {
    const { context, records } = loadModes();
    const jwk = { crv: 'P-256', x: 'abc', y: 'def' };
    context.state.myKeys = { jwkEcdsaPublic: jwk };
    const link = await context.getMyInviteLink();
    assert.match(link, /^https:\/\/grid\.example\/invite#me\.[0-9a-f]{32}$/);

    const invite = context.parseInvite(link.slice(link.indexOf('#')));
    assert.equal(invite.peerId, 'me');
    assert.equal(context.parseInvite('#me.nothex'), null);
    assert.equal(context.parseInvite('#'), null);

    records.set('invite-expect:peer', { id: 'invite-expect:peer', fingerprint: invite.fingerprint });
    assert.equal(await context.verifyInvitedPeerKey('peer', { crv: 'P-256', x: 'evil', y: 'key' }), false);
    assert.equal(records.has('invite-expect:peer'), true, 'expectation stays after a mismatch');
    assert.equal(await context.verifyInvitedPeerKey('peer', jwk), true);
    assert.equal(records.has('invite-expect:peer'), false);
    assert.equal(await context.verifyInvitedPeerKey('stranger', { crv: 'P-256', x: 'x', y: 'y' }), true, 'no invite, no check');
});
