import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { buildApp } from '../server/app.js';
import { createStore } from '../server/database.js';
import { EMAIL_TRANSPORTS, createSafetyCrypto, normalizeEmail, parseSafetyConfig } from '../server/safety.js';

const apps = [];
const codes = [];
EMAIL_TRANSPORTS.test = { send: ({ email, code }) => codes.push({ email, code }) };
EMAIL_TRANSPORTS.failing = { send: async () => { throw new Error('SMTP down'); } };

async function startApp(safety, { now } = {}) {
    const store = createStore(':memory:');
    const app = await buildApp({ store, buildVersion: 'x', buildTimestamp: 'y', safety, ...(now ? { now } : {}) });
    apps.push({ app, store });
    return { app, store };
}

afterEach(async () => {
    while (apps.length) {
        const { app, store } = apps.pop();
        await app.close();
        store.close();
    }
    codes.length = 0;
});

async function register(app, peerId) {
    const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const registrationId = `registration-${peerId}`;
    const authToken = randomBytes(32).toString('base64url');
    const signature = sign('sha256', Buffer.from(JSON.stringify({ peerId, registrationId, authToken })), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' });
    const response = await app.inject({
        method: 'POST',
        url: '/api/register',
        payload: {
            peerId, registrationId, geohash: 'u10j2k', authToken,
            registrationProof: { publicKey: keys.publicKey.export({ format: 'jwk' }), signature: signature.toString('base64') }
        }
    });
    return { response, headers: { authorization: `Bearer ${authToken}` } };
}

const grid = (app, peerId, headers) => app.inject({ method: 'GET', url: `/api/grid?geohash=u10j2k${peerId ? `&peerId=${peerId}` : ''}`, headers });

test('safety config defaults to everything off and clamps values', () => {
    assert.deepEqual(parseSafetyConfig({}), {
        ageCheck: 'off', ageProvider: null, emailCheck: 'off', emailTransport: 'log', abuseLogDays: 0, safetyKey: null, smtp: null
    });
    const parsed = parseSafetyConfig({ ageCheck: 'PROVIDER', ageProvider: 'Dev', emailCheck: 'required', abuseLogDays: '99' });
    assert.equal(parsed.ageCheck, 'provider');
    assert.equal(parsed.ageProvider, 'dev');
    assert.equal(parsed.abuseLogDays, 14);
    assert.equal(parseSafetyConfig({ ageCheck: 'maybe', abuseLogDays: -3 }).ageCheck, 'off');
    assert.equal(normalizeEmail('  Alex@Example.org '), 'alex@example.org');
    assert.equal(normalizeEmail('nope'), null);
});

test('without checks nothing changes: config says off, grid stays open', async () => {
    const { app } = await startApp(undefined);
    const config = (await app.inject({ method: 'GET', url: '/api/config' })).json();
    assert.deepEqual(config.safety, { ageCheck: 'off', ageProvider: null, emailCheck: 'off' });
    const { response } = await register(app, 'alice');
    assert.equal(response.json().verificationRequired, undefined);
    assert.equal((await grid(app)).statusCode, 200);
});

test('age confirmation: invisible and no grid until confirmed', async () => {
    const { app, store } = await startApp({ ageCheck: 'confirm' });
    const { response, headers } = await register(app, 'alice');
    assert.deepEqual(response.json().verificationRequired, ['age']);
    assert.equal(store.isPeerSilent('alice'), true, 'not visible before the check');
    assert.equal((await grid(app)).statusCode, 401, 'anonymous grid is closed');
    assert.equal((await grid(app, 'alice', headers)).statusCode, 403);

    const missingTick = await app.inject({ method: 'POST', url: '/api/safety/age/confirm', headers, payload: { peerId: 'alice' } });
    assert.equal(missingTick.statusCode, 400);
    const confirmed = await app.inject({ method: 'POST', url: '/api/safety/age/confirm', headers, payload: { peerId: 'alice', over18: true } });
    assert.equal(confirmed.statusCode, 200);
    const status = (await app.inject({ method: 'GET', url: '/api/safety/status?peerId=alice', headers })).json();
    assert.equal(status.age.verified, true);
    assert.equal(status.email.required, false);
    assert.equal((await grid(app, 'alice', headers)).statusCode, 200);
});

test('provider age check stores only a hash of the pseudonym and honours bans', async () => {
    const { app } = await startApp({ ageCheck: 'provider', ageProvider: 'dev', safetyKey: randomBytes(32).toString('base64') });
    const { headers } = await register(app, 'alice');
    const start = (await app.inject({ method: 'POST', url: '/api/safety/age/start', headers, payload: { peerId: 'alice' } })).json();
    assert.deepEqual(start, { ok: true, provider: 'dev', kind: 'dev' });
    const refused = await app.inject({ method: 'POST', url: '/api/safety/age/finish', headers, payload: { peerId: 'alice', payload: { over18: false } } });
    assert.equal(refused.statusCode, 403);
    const finished = await app.inject({ method: 'POST', url: '/api/safety/age/finish', headers, payload: { peerId: 'alice', payload: { over18: true, subject: 'person-1' } } });
    assert.equal(finished.statusCode, 200);
    const status = (await app.inject({ method: 'GET', url: '/api/safety/status?peerId=alice', headers })).json();
    assert.equal(status.age.method, 'provider:dev');
    assert.ok(status.age.expiresAt > Date.now());
});

test('unknown age provider falls back to the confirmation instead of locking everyone out', async () => {
    const { app } = await startApp({ ageCheck: 'provider', ageProvider: 'nope' });
    const config = (await app.inject({ method: 'GET', url: '/api/config' })).json();
    assert.equal(config.safety.ageCheck, 'confirm');
});

test('email check: code by mail, wrong codes count, address stored encrypted', async () => {
    const key = randomBytes(32);
    const { app, store } = await startApp({ emailCheck: 'required', emailTransport: 'test', safetyKey: key.toString('base64') });
    const { response, headers } = await register(app, 'alice');
    assert.deepEqual(response.json().verificationRequired, ['email']);

    const bad = await app.inject({ method: 'POST', url: '/api/safety/email/start', headers, payload: { peerId: 'alice', email: 'not-an-email' } });
    assert.equal(bad.statusCode, 400);
    const started = await app.inject({ method: 'POST', url: '/api/safety/email/start', headers, payload: { peerId: 'alice', email: 'Alex@Example.org' } });
    assert.equal(started.statusCode, 200);
    assert.equal(codes.length, 1);
    assert.equal(codes[0].email, 'alex@example.org');

    const wrong = codes[0].code === '000000' ? '000001' : '000000';
    assert.equal((await app.inject({ method: 'POST', url: '/api/safety/email/confirm', headers, payload: { peerId: 'alice', code: wrong } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/safety/email/confirm', headers, payload: { peerId: 'alice', code: codes[0].code } })).statusCode, 200);
    assert.equal((await grid(app, 'alice', headers)).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/api/safety/email/confirm', headers, payload: { peerId: 'alice', code: codes[0].code } })).statusCode, 410, 'codes work once');

    // Gesperrte Adresse: kein neuer Code.
    const safetyCrypto = createSafetyCrypto(key);
    store.safety.addBan('email', safetyCrypto.hash('email', 'alex@example.org'));
    const second = await register(app, 'bob');
    const banned = await app.inject({ method: 'POST', url: '/api/safety/email/start', headers: second.headers, payload: { peerId: 'bob', email: 'alex@example.org' } });
    assert.equal(banned.statusCode, 403);
});

test('email check: a failed send answers 502 and keeps no code', async () => {
    const { app, store } = await startApp({ emailCheck: 'required', emailTransport: 'failing' });
    const { headers } = await register(app, 'alice');
    const started = await app.inject({ method: 'POST', url: '/api/safety/email/start', headers, payload: { peerId: 'alice', email: 'alex@example.org' } });
    assert.equal(started.statusCode, 502);
    assert.equal(store.safety.getEmailCode('alice'), null);
});

test('email codes expire and lock after too many attempts', async () => {
    let clock = Date.now();
    const { app } = await startApp({ emailCheck: 'required', emailTransport: 'test' }, { now: () => clock });
    const { headers } = await register(app, 'alice');
    await app.inject({ method: 'POST', url: '/api/safety/email/start', headers, payload: { peerId: 'alice', email: 'a@b.de' } });
    const wrong = codes[0].code === '000000' ? '000001' : '000000';
    for (let attempt = 0; attempt < 5; attempt += 1) {
        await app.inject({ method: 'POST', url: '/api/safety/email/confirm', headers, payload: { peerId: 'alice', code: wrong } });
    }
    assert.equal((await app.inject({ method: 'POST', url: '/api/safety/email/confirm', headers, payload: { peerId: 'alice', code: codes[0].code } })).statusCode, 410);

    await app.inject({ method: 'POST', url: '/api/safety/email/start', headers, payload: { peerId: 'alice', email: 'a@b.de' } });
    clock += 16 * 60 * 1000;
    assert.equal((await app.inject({ method: 'POST', url: '/api/safety/email/confirm', headers, payload: { peerId: 'alice', code: codes[1].code } })).statusCode, 410);
});

test('banned peers cannot register, safety routes need the peer token', async () => {
    const { app, store } = await startApp({ ageCheck: 'confirm' });
    store.safety.addBan('peer', 'mallory');
    assert.equal((await register(app, 'mallory')).response.statusCode, 403);
    await register(app, 'alice');
    const anonymous = await app.inject({ method: 'GET', url: '/api/safety/status?peerId=alice' });
    assert.equal(anonymous.statusCode, 401);
});

test('access log only when ABUSE_LOG_DAYS is set, deduplicated and pruned', async () => {
    const off = await startApp(undefined);
    await register(off.app, 'alice');
    assert.deepEqual(off.store.safety.listAccess('alice'), []);

    let clock = Date.now();
    const on = await startApp({ abuseLogDays: 2 }, { now: () => clock });
    await register(on.app, 'alice');
    assert.equal(on.store.safety.listAccess('alice').length, 1);
    assert.equal(on.store.safety.logAccess('alice', on.store.safety.listAccess('alice')[0].ip, clock + 1000), false, 'same ip within the hour');
    clock += 3 * 24 * 60 * 60 * 1000;
    on.store.safety.logAccess('alice', '203.0.113.9', clock);
    on.store.safety.pruneAccessLog(clock - 2 * 24 * 60 * 60 * 1000);
    assert.deepEqual(on.store.safety.listAccess('alice').map(entry => entry.ip), ['203.0.113.9'], 'older entries are deleted');
});
