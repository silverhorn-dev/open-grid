import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFederation, parseFederationPeers, parseFederationRules, routerForCell } from '../server/federation.js';

// Mehrere Router (Branch feature/federation, Stand P1-Modul): Regeln, Zuordnung, Beitritt.
const rules = parseFederationRules(JSON.stringify([
    { prefix: 'u1', routers: ['main'] },
    { prefix: 'u1hx', routers: ['r2'] },
    { prefix: 'u0', routers: ['main', 'r2'], mode: 'share' },
    { prefix: 'Bad!', routers: ['r2'] }
]));

test('rules: invalid entries are dropped, longest prefix wins', () => {
    assert.equal(rules.length, 3);
    assert.equal(routerForCell('u1abcd', rules, () => true, 'main'), 'main');
    assert.equal(routerForCell('u1hxkz', rules, () => true, 'main'), 'r2', 'a crowded cell can be split off');
    assert.equal(routerForCell('gcpvj0', rules, () => true, 'main'), 'main', 'no rule: main router');
});

test('share mode alternates the cells under a prefix (two routers: even/odd)', () => {
    assert.equal(routerForCell('u00000', rules, () => true, 'main'), 'main');
    assert.equal(routerForCell('u01000', rules, () => true, 'main'), 'r2');
    assert.equal(routerForCell('u02000', rules, () => true, 'main'), 'main');
    assert.equal(routerForCell('u0z000', rules, () => true, 'main'), 'r2', "'z' is 31 (odd)");
});

test('a router that is down falls back to the shorter rule, finally the main router', () => {
    const down = id => id !== 'r2';
    assert.equal(routerForCell('u1hxkz', rules, down, 'main'), 'main');
    assert.equal(routerForCell('u01000', rules, down, 'main'), 'main');
});

test('only routers approved by the admin can join; they drop out without heartbeat', () => {
    let clock = 1000;
    const peers = parseFederationPeers(JSON.stringify([{ id: 'r2', token: 'r2-secret-token-123' }, { id: 'short', token: 'x' }]));
    assert.deepEqual(peers.map(peer => peer.id), ['r2'], 'tokens must be long enough');
    const federation = createFederation({ selfId: 'main', peers, rules, now: () => clock });
    assert.equal(federation.join({ id: 'r2', url: 'https://r2.example', token: 'wrong-token-000000' }).error, 'not-approved');
    assert.equal(federation.join({ id: 'r3', url: 'https://r3.example', token: 'r2-secret-token-123' }).error, 'not-approved');
    assert.equal(federation.join({ id: 'r2', url: 'javascript:alert(1)', token: 'r2-secret-token-123' }).error, 'invalid-url');
    const joined = federation.join({ id: 'r2', url: 'https://r2.example/', token: 'r2-secret-token-123' });
    assert.deepEqual(joined.config.routers, [{ id: 'main', url: '' }, { id: 'r2', url: 'https://r2.example' }]);
    assert.equal(federation.routerForCell('u1hxkz'), 'r2');
    clock += 91_000;
    assert.equal(federation.routerForCell('u1hxkz'), 'main', 'no heartbeat for 90 s: back to main');
    assert.deepEqual(federation.clientConfig().routers.map(router => router.id), ['main']);
});
