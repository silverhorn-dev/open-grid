import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function loadSnaps(clientDefaults = {}) {
    const context = { state: { appConfig: { clientDefaults } }, clientDefault: (key, fallback) => clientDefaults[key] ?? fallback, Date, Math };
    vm.runInNewContext(read('client/app/secure-snaps.js'), context);
    vm.runInNewContext(read('client/app/snaps.js'), context);
    return context;
}

test('one-time snaps expire after the sender-chosen time since the first view', () => {
    const snaps = loadSnaps();
    const minute = 60 * 1000;
    const viewedAt = 1_000_000;
    const snap = (extra = {}) => ({ snapMode: 'replay', snapViews: 1, firstViewedAt: viewedAt, ...extra });

    assert.equal(snaps.isReplaySnapUsedUp(snap({ snapExpiry: '15m' }), viewedAt + 14 * minute), false);
    assert.equal(snaps.isReplaySnapUsedUp(snap({ snapExpiry: '15m' }), viewedAt + 15 * minute), true);
    assert.equal(snaps.isReplaySnapUsedUp(snap({ snapExpiry: '60m' }), viewedAt + 59 * minute), false);
    // Ohne Angabe (aeltere Snaps): 30 min.
    assert.equal(snaps.isReplaySnapUsedUp(snap(), viewedAt + 29 * minute), false);
    assert.equal(snaps.isReplaySnapUsedUp(snap(), viewedAt + 30 * minute), true);
    // 'off': nur die Ansichten zaehlen.
    assert.equal(snaps.isReplaySnapUsedUp(snap({ snapExpiry: 'off' }), viewedAt + 999 * minute), false);
    assert.equal(snaps.isReplaySnapUsedUp(snap({ snapExpiry: 'off', snapViews: 2 }), viewedAt), true);
    // Noch nie angesehen: laeuft nicht ab.
    assert.equal(snaps.isReplaySnapUsedUp({ snapMode: 'replay', snapExpiry: '15m' }, viewedAt + 999 * minute), false);
});

test('the default expiry comes from the router and falls back to 30 minutes', () => {
    assert.equal(loadSnaps().defaultSnapExpiry(), '30m');
    assert.equal(loadSnaps({ snapExpiry: '60m' }).defaultSnapExpiry(), '60m');
    assert.equal(loadSnaps({ snapExpiry: '2h' }).defaultSnapExpiry(), '30m');
});
