import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { I18N_STUBS } from './i18n-stubs.js';

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
    vm.runInNewContext(readFileSync(new URL('../client/app/modes.js', import.meta.url), 'utf8'), Object.assign(context, I18N_STUBS));
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
    assert.match(link, /^https:\/\/grid\.example\/invite#me\.[0-9a-f]{32}~discovery$/, 'the link remembers the mode');

    const invite = context.parseInvite(link.slice(link.indexOf('#')));
    assert.equal(invite.peerId, 'me');
    assert.equal(invite.mode, 'discovery');
    assert.equal(context.parseInvite(link.slice(link.indexOf('#')).replace('~discovery', '')).mode, null, 'old links without a mode still work');
    assert.equal(context.parseInvite(link.slice(link.indexOf('#')).replace('~discovery', '~bogus')).mode, null);
    assert.equal(context.parseInvite('#me.nothex'), null);
    assert.equal(context.parseInvite('#'), null);

    records.set('invite-expect:peer', { id: 'invite-expect:peer', fingerprint: invite.fingerprint });
    assert.equal(await context.verifyInvitedPeerKey('peer', { crv: 'P-256', x: 'evil', y: 'key' }), false);
    assert.equal(records.has('invite-expect:peer'), true, 'expectation stays after a mismatch');
    assert.equal(await context.verifyInvitedPeerKey('peer', jwk), true);
    assert.equal(records.has('invite-expect:peer'), false);
    assert.equal(await context.verifyInvitedPeerKey('stranger', { crv: 'P-256', x: 'x', y: 'y' }), true, 'no invite, no check');
});

function loadScoped(routerModes, stored = {}) {
    const loaded = loadModes(stored.mode || 'discovery');
    const { context } = loaded;
    context.state.appConfig = { routerModes, modes: routerModes, defaultMode: 'discovery' };
    context.state.appModeSettings = stored;
    Object.assign(context, {
        document: { getElementById: () => null, querySelectorAll: () => [] },
        syncAlbumCardVisibility: () => {},
        updateChatAlbumButton: () => {},
        applyProfileSchemaForMode: () => {}
    });
    context.applyModeScope();
    return loaded;
}

test('the chosen area limits the modes, existing users keep all of them', () => {
    const all = ['discovery', 'chat', 'friends', 'event'];
    assert.equal(loadScoped(all).context.effectiveModeScope(), 'all', 'no stored scope = everything as before');
    assert.deepEqual([...loadScoped(all).context.state.appConfig.modes], all);

    const discovery = loadScoped(all, { scope: 'discovery' }).context;
    assert.deepEqual([...discovery.state.appConfig.modes], ['discovery', 'event']);
    assert.equal(discovery.scopeIncludes('social'), false);
    assert.equal(discovery.scopeIncludes('discovery'), true);

    const social = loadScoped(all, { scope: 'social' }).context;
    assert.deepEqual([...social.state.appConfig.modes], ['chat', 'friends']);
    assert.equal(social.scopeIncludes('discovery'), false);

    // Erlaubt der Betreiber nur einen Bereich, gilt dieser (die Frage entfaellt).
    const operator = loadScoped(['chat', 'friends'], { scope: 'discovery' }).context;
    assert.equal(operator.effectiveModeScope(), 'social');
    assert.deepEqual([...operator.state.appConfig.modes], ['chat', 'friends']);
    assert.deepEqual([...operator.availableModeAreas()], ['social']);
});

test('changing the area moves out of a mode that is no longer available', async () => {
    const all = ['discovery', 'chat', 'friends', 'event'];
    const { context, records } = loadScoped(all, { scope: 'all', mode: 'discovery' });
    await context.setModeScope('social');
    assert.equal(context.state.appMode, 'friends', 'friends grid instead of the public grid');
    assert.equal(records.get('app-mode').scope, 'social');

    // "Alle Modi anzeigen" an und wieder aus: zurueck zum vorherigen Bereich.
    await context.setAllModesVisible(true);
    assert.equal(context.effectiveModeScope(), 'all');
    assert.equal(context.state.appMode, 'friends', 'mode stays when it is still allowed');
    await context.setAllModesVisible(false);
    assert.equal(context.effectiveModeScope(), 'social');

    await context.setModeScope('bogus');
    assert.equal(context.effectiveModeScope(), 'social', 'unknown areas are ignored');
});

test('invites land in the area of the inviting mode, or open nothing when that area is off', () => {
    const all = ['discovery', 'chat', 'friends', 'event'];
    const everything = loadScoped(all, { scope: 'all', mode: 'chat' }).context;
    assert.deepEqual({ ...everything.inviteTarget('discovery') }, { area: 'discovery', mode: 'discovery' });
    assert.deepEqual({ ...everything.inviteTarget('friends') }, { area: 'social', mode: 'friends' });
    assert.deepEqual({ ...everything.inviteTarget('event') }, { area: 'discovery', mode: 'discovery' }, 'event invites need no code, they use exploring');
    assert.deepEqual({ ...everything.inviteTarget(null) }, { area: null, mode: null }, 'old links: as before');

    const social = loadScoped(all, { scope: 'social', mode: 'chat' }).context;
    assert.equal(social.inviteTarget('discovery'), null, 'area turned off by the user');
    assert.deepEqual({ ...social.inviteTarget('chat') }, { area: 'social', mode: 'chat' });

    const operator = loadScoped(['chat', 'friends']).context;
    assert.equal(operator.inviteTarget('event'), null, 'area not offered by the operator');
});

test('under 18 (or without the required age proof) neither opens nor sends exploring invites', () => {
    const all = ['discovery', 'chat', 'friends', 'event'];
    const adult = loadScoped(all, { scope: 'all', mode: 'discovery' }).context;
    adult.state.ageGroup = 'adult';
    assert.equal(adult.discoveryInvitesAllowed(), true);
    assert.equal(adult.inviteLinkMode(), 'discovery');

    const minor = loadScoped(all, { scope: 'all', mode: 'discovery' }).context;
    minor.state.ageGroup = 'minor';
    assert.equal(minor.discoveryInvitesAllowed(), false);
    assert.equal(minor.inviteLinkMode(), 'chat', 'own link points to the chat area instead');
    minor.state.appMode = 'friends';
    assert.equal(minor.inviteLinkMode(), 'friends', 'chat area links stay as they are');

    const unverified = loadScoped(all, { scope: 'all', mode: 'event' }).context;
    unverified.state.verificationRequired = ['age'];
    assert.equal(unverified.discoveryInvitesAllowed(), false);
    assert.equal(unverified.inviteLinkMode(), 'chat');

    const onlyDiscovery = loadScoped(['discovery', 'event'], { mode: 'discovery' }).context;
    onlyDiscovery.state.ageGroup = 'minor';
    assert.equal(onlyDiscovery.inviteLinkMode(), null, 'no chat area: link without a mode');
});
