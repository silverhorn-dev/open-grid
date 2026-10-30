import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { cborEncode } from '@animo-id/mdoc';
import { buildApp } from '../server/app.js';
import { createStore } from '../server/database.js';

const ORIGIN = 'https://og.example.org';
const SETUP = 'setup-token-for-tests';
const cleanup = [];
afterEach(async () => {
    while (cleanup.length) await cleanup.pop()();
});

async function adminApp() {
    const store = createStore(':memory:');
    const app = await buildApp({ store, buildVersion: 'test', buildTimestamp: '2026-10-29T00:00:00Z', appUrl: ORIGIN, adminSetupToken: SETUP });
    cleanup.push(async () => { await app.close(); store.close(); });
    return app;
}

// Software-Authenticator (ES256, Attestation "none"), wie ihn ein Handy oder Sicherheitsschluessel spielt.
function authenticator(origin = ORIGIN) {
    const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const credentialId = randomBytes(16);
    const rpIdHash = createHash('sha256').update(new URL(ORIGIN).hostname).digest();
    let counter = 0;
    const b64 = value => Buffer.from(value).toString('base64url');
    const clientData = (type, challenge) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
    return {
        id: b64(credentialId),
        create(options) {
            const jwk = keys.publicKey.export({ format: 'jwk' });
            const coseKey = cborEncode(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
            const length = Buffer.alloc(2);
            length.writeUInt16BE(credentialId.length);
            const authData = Buffer.concat([rpIdHash, Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), length, credentialId, Buffer.from(coseKey)]);
            const attestationObject = cborEncode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
            return {
                id: b64(credentialId), rawId: b64(credentialId), type: 'public-key', clientExtensionResults: {},
                response: { clientDataJSON: b64(clientData('webauthn.create', options.challenge)), attestationObject: b64(attestationObject), transports: ['internal'] }
            };
        },
        get(options) {
            counter += 1;
            const count = Buffer.alloc(4);
            count.writeUInt32BE(counter);
            const authData = Buffer.concat([rpIdHash, Buffer.from([0x05]), count]);
            const clientDataJSON = clientData('webauthn.get', options.challenge);
            const signature = sign('sha256', Buffer.concat([authData, createHash('sha256').update(clientDataJSON).digest()]), keys.privateKey);
            return {
                id: b64(credentialId), rawId: b64(credentialId), type: 'public-key', clientExtensionResults: {},
                response: { clientDataJSON: b64(clientDataJSON), authenticatorData: b64(authData), signature: b64(signature) }
            };
        }
    };
}

const cookieOf = response => String(response.headers['set-cookie'] || '').split(';')[0];
const post = (app, url, payload, headers = {}) => app.inject({ method: 'POST', url, payload, headers });

async function setupPasskey(app, device) {
    const options = (await post(app, '/api/admin/passkeys/options', { setupToken: SETUP })).json();
    const response = await post(app, '/api/admin/passkeys', { challenge: options.challenge, response: device.create(options), name: 'Handy' });
    assert.equal(response.statusCode, 200, response.body);
    return cookieOf(response);
}

test('admin: first passkey only via the setup link, then the link is gone', async () => {
    const app = await adminApp();
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/admin/session' })).json(), { loggedIn: false, setupPending: true });
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/status' })).statusCode, 401);
    assert.equal((await post(app, '/api/admin/passkeys/options', { setupToken: 'wrong' })).statusCode, 401);

    const cookie = await setupPasskey(app, authenticator());
    assert.match(cookie, /^og_admin=/);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/admin/session', headers: { cookie } })).json(), { loggedIn: true, setupPending: false });
    assert.equal((await post(app, '/api/admin/passkeys/options', { setupToken: SETUP })).statusCode, 401, 'setup link is used up');
});

test('admin: passkey login, wrong origin and replayed challenges are rejected', async () => {
    const app = await adminApp();
    const device = authenticator();
    await setupPasskey(app, device);

    const options = (await post(app, '/api/admin/login/options', {})).json();
    const assertion = device.get(options);
    const login = await post(app, '/api/admin/login', { challenge: options.challenge, response: assertion });
    assert.equal(login.statusCode, 200, login.body);
    const cookie = cookieOf(login);
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/status', headers: { cookie } })).statusCode, 200);
    assert.equal((await post(app, '/api/admin/login', { challenge: options.challenge, response: assertion })).statusCode, 400, 'challenge used once');

    const phishing = authenticator('https://evil.example');
    const other = (await post(app, '/api/admin/login/options', {})).json();
    assert.equal((await post(app, '/api/admin/login', { challenge: other.challenge, response: phishing.get(other) })).statusCode, 401, 'unknown passkey');
    const third = (await post(app, '/api/admin/login/options', {})).json();
    const forged = { ...device.get(third) };
    forged.response = { ...forged.response, clientDataJSON: Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: third.challenge, origin: 'https://evil.example' })).toString('base64url') };
    assert.equal((await post(app, '/api/admin/login', { challenge: third.challenge, response: forged })).statusCode, 401, 'other origin');

    const logout = await post(app, '/api/admin/logout', {}, { cookie });
    assert.equal(logout.statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/status', headers: { cookie } })).statusCode, 401, 'session ended');
});

test('admin: status, load series, passkey management with the admin header', async () => {
    const app = await adminApp();
    const cookie = await setupPasskey(app, authenticator());
    const status = (await app.inject({ method: 'GET', url: '/api/admin/status', headers: { cookie } })).json();
    assert.equal(status.version, 'test');
    assert.deepEqual(Object.keys(status.peers).sort(), ['online', 'registered', 'sockets']);
    assert.equal(status.safety.ageCheck, 'off');
    assert.ok(status.system.cores >= 1);

    const series = (await app.inject({ method: 'GET', url: '/api/admin/metrics?range=1h', headers: { cookie } })).json();
    assert.equal(series.intervalMs, 10000);
    assert.ok(series.points.length >= 1, 'first sample at start');
    for (const key of ['cpu', 'memory', 'eventLoopMs', 'sockets', 'peersOnline', 'requestsPerSecond', 'errorsPerSecond', 'queueMessages', 'diskFreeBytes']) {
        assert.ok(key in series.points[0], key);
    }
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/metrics?range=24h', headers: { cookie } })).json().intervalMs, 60000);

    const list = (await app.inject({ method: 'GET', url: '/api/admin/passkeys', headers: { cookie } })).json().passkeys;
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'Handy');
    const id = encodeURIComponent(list[0].id);
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/admin/passkeys/${id}`, headers: { cookie } })).statusCode, 403, 'admin header required');
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/admin/passkeys/${id}`, headers: { cookie, 'x-opengrid-admin': '1' } })).statusCode, 409, 'last passkey stays');

    // Zweiter Passkey nur angemeldet (und mit Header).
    const second = authenticator();
    assert.equal((await post(app, '/api/admin/passkeys/options', {}, { cookie })).statusCode, 403);
    const options = (await post(app, '/api/admin/passkeys/options', {}, { cookie, 'x-opengrid-admin': '1' })).json();
    assert.equal(options.excludeCredentials.length, 1);
    assert.equal((await post(app, '/api/admin/passkeys', { challenge: options.challenge, response: second.create(options), name: 'Laptop' }, { cookie })).statusCode, 200);
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/admin/passkeys/${id}`, headers: { cookie, 'x-opengrid-admin': '1' } })).statusCode, 200);
});

test('admin page is served with the app CSP, never indexed, and the cookie is strict', async () => {
    const app = await adminApp();
    const page = await app.inject({ method: 'GET', url: '/admin' });
    assert.equal(page.statusCode, 200);
    assert.match(page.headers['content-security-policy'], /script-src 'self'(;|$)/);
    assert.match(page.body, /<meta name="robots" content="noindex, nofollow">/);
    assert.match(page.body, /\/client\/admin\.js\?v=/);
    assert.equal((await app.inject({ method: 'GET', url: '/client/admin.js' })).statusCode, 200);
    const options = (await post(app, '/api/admin/passkeys/options', { setupToken: SETUP })).json();
    const response = await post(app, '/api/admin/passkeys', { challenge: options.challenge, response: authenticator().create(options) });
    assert.match(response.headers['set-cookie'], /HttpOnly; SameSite=Strict; Max-Age=43200; Secure/);
    assert.match(response.headers['set-cookie'], /Path=\/api\/admin/);
});

// ----- Phase 2: Live-Konfiguration und Sperren -----
const H = cookie => ({ cookie, 'x-opengrid-admin': '1' });
const put = (app, key, value, cookie) => app.inject({ method: 'PUT', url: `/api/admin/config/${key}`, payload: { value }, headers: H(cookie) });
const appConfig = async app => (await app.inject({ method: 'GET', url: '/api/config' })).json();

test('admin live config: takes effect at once, survives a restart, rejects invalid values, resets to env', async () => {
    const store = createStore(':memory:');
    const build = () => buildApp({ store, buildVersion: 'test', buildTimestamp: 'x', appUrl: ORIGIN, adminSetupToken: SETUP });
    let app = await build();
    cleanup.push(async () => store.close());
    const cookie = await setupPasskey(app, authenticator());

    const config = (await app.inject({ method: 'GET', url: '/api/admin/config', headers: { cookie } })).json();
    assert.equal(config.live.NUDITY_THRESHOLD.source, 'env');
    assert.ok(config.live.NUDITY_MODEL.options.includes('off'));
    assert.deepEqual(config.live.AGE_CHECK.options, ['off', 'confirm'], 'provider only with a configured provider');
    const secret = config.restartOnly.find(entry => entry.key === 'SAFETY_KEY');
    assert.deepEqual(Object.keys(secret).sort(), ['key', 'secret', 'set'], 'secrets never with their value');

    assert.equal((await put(app, 'NUDITY_THRESHOLD', 0.85, cookie)).statusCode, 200);
    assert.equal((await appConfig(app)).nudity.threshold, 0.85, 'effective without restart');
    assert.equal((await put(app, 'NUDITY_THRESHOLD', 2, cookie)).statusCode, 400);
    assert.equal((await put(app, 'NUDITY_THRESHOLD', 0.1, cookie)).statusCode, 400);
    assert.equal((await put(app, 'NUDITY_THRESHOLD', 0.4, cookie)).statusCode, 200, 'low thresholds allowed (NudeNet hits around 0.46)');
    assert.equal((await appConfig(app)).nudity.threshold, 0.4);
    assert.equal((await put(app, 'NUDITY_THRESHOLD', null, cookie)).statusCode, 200, 'empty = default of the model');
    assert.equal((await appConfig(app)).nudity.threshold, 0.7);
    assert.equal((await put(app, 'NUDITY_THRESHOLD', 0.85, cookie)).statusCode, 200);
    assert.equal((await put(app, 'CLIENT_DEFAULTS', '{"language":"en"}', cookie)).statusCode, 200);
    assert.equal((await appConfig(app)).clientDefaults.language, 'en');
    assert.equal((await put(app, 'CLIENT_DEFAULTS', '{oops', cookie)).statusCode, 400);
    assert.equal((await put(app, 'AGE_CHECK', 'provider', cookie)).statusCode, 400);
    assert.equal((await put(app, 'AGE_CHECK', 'confirm', cookie)).statusCode, 200);
    assert.equal((await appConfig(app)).safety.ageCheck, 'confirm');
    assert.equal((await put(app, 'AUDIENCE_MINIMUM', { ranges: { age: { min: 18 } } }, cookie)).statusCode, 200);
    assert.deepEqual((await appConfig(app)).audienceMinimum, { ranges: { age: { min: 18 } } });
    assert.equal((await put(app, 'NUDITY_MODEL', 'off', cookie)).statusCode, 200);
    assert.equal((await appConfig(app)).nudity.model, 'off');
    assert.equal((await put(app, 'NUDITY_MODEL', 'missing-model', cookie)).statusCode, 400);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/admin/config/NUDITY_THRESHOLD', payload: { value: 0.9 }, headers: { cookie } })).statusCode, 403, 'admin header required');

    // Neustart: Panel-Werte gelten weiter.
    await app.close();
    app = await build();
    cleanup.push(async () => app.close());
    assert.equal((await appConfig(app)).nudity.model, 'off');
    assert.equal((await appConfig(app)).safety.ageCheck, 'confirm');

    // Sitzung und Auslastungs-Verlauf ueberstehen den Neustart (Datenbank).
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/session', headers: { cookie } })).json().loggedIn, true);
    assert.ok((await app.inject({ method: 'GET', url: '/api/admin/metrics?range=1h', headers: { cookie } })).json().points.length >= 2, 'samples from before and after the restart');
});

test('admin live config: reset brings back the environment value', async () => {
    const app = await adminApp();
    const cookie = await setupPasskey(app, authenticator());
    assert.equal((await put(app, 'NUDITY_THRESHOLD', 0.9, cookie)).statusCode, 200);
    const reset = await app.inject({ method: 'DELETE', url: '/api/admin/config/NUDITY_THRESHOLD', headers: H(cookie) });
    assert.equal(reset.statusCode, 200);
    assert.equal(reset.json().setting.source, 'env');
    assert.equal((await appConfig(app)).nudity.threshold, 0.7);
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/admin/config/UNKNOWN', headers: H(cookie) })).statusCode, 400);
});

test('admin bans: list, ban a peer (registration refused), lift it; email only as HMAC', async () => {
    const app = await adminApp();
    const cookie = await setupPasskey(app, authenticator());
    const register = peerId => {
        const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
        const registrationId = `registration-${peerId}`;
        const authToken = randomBytes(32).toString('base64url');
        const signature = sign('sha256', Buffer.from(JSON.stringify({ peerId, registrationId, authToken })), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' });
        return app.inject({ method: 'POST', url: '/api/register', payload: { peerId, registrationId, geohash: 'u10j2k', authToken, registrationProof: { publicKey: keys.publicKey.export({ format: 'jwk' }), signature: signature.toString('base64') } } });
    };
    assert.equal((await post(app, '/api/admin/bans', { kind: 'peer', value: 'mallory', reason: 'leak' }, { cookie })).statusCode, 403, 'admin header required');
    assert.equal((await post(app, '/api/admin/bans', { kind: 'peer', value: 'mallory', reason: 'leak' }, H(cookie))).statusCode, 200);
    assert.equal((await post(app, '/api/admin/bans', { kind: 'email', value: 'Leaker@Example.org' }, H(cookie))).statusCode, 200);
    assert.equal((await post(app, '/api/admin/bans', { kind: 'email', value: 'not-an-email' }, H(cookie))).statusCode, 400);
    assert.equal((await post(app, '/api/admin/bans', { kind: 'nope', value: 'x' }, H(cookie))).statusCode, 400);
    const bans = (await app.inject({ method: 'GET', url: '/api/admin/bans', headers: { cookie } })).json().bans;
    assert.equal(bans.length, 2);
    assert.equal(bans.find(ban => ban.kind === 'peer').reason, 'leak');
    assert.doesNotMatch(bans.find(ban => ban.kind === 'email').value, /@/, 'email stored as HMAC only');
    assert.equal((await register('mallory')).statusCode, 403);
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/admin/bans/peer/mallory', headers: H(cookie) })).statusCode, 200);
    assert.equal((await register('mallory')).statusCode, 200);
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/admin/bans/peer/mallory', headers: H(cookie) })).statusCode, 404);
});

// ----- Phase 3: Meldungen -----
async function registerPeer(app, peerId) {
    const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const registrationId = `registration-${peerId}`;
    const authToken = randomBytes(32).toString('base64url');
    const signature = sign('sha256', Buffer.from(JSON.stringify({ peerId, registrationId, authToken })), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' });
    const response = await app.inject({ method: 'POST', url: '/api/register', payload: { peerId, registrationId, geohash: 'u10j2k', authToken, registrationProof: { publicKey: keys.publicKey.export({ format: 'jwk' }), signature: signature.toString('base64') } } });
    return { response, headers: { authorization: `Bearer ${authToken}` } };
}

test('reports: peers report a leak (no image), the panel bans with one click or dismisses', async () => {
    const app = await adminApp();
    const cookie = await setupPasskey(app, authenticator());
    const alice = await registerPeer(app, 'alice');
    const bob = await registerPeer(app, 'bob');
    await registerPeer(app, 'mallory');
    const report = (who, payload) => post(app, '/api/reports', { kind: 'leak', matches: 31, ...payload, peerId: who }, who === 'alice' ? alice.headers : bob.headers);

    assert.equal((await post(app, '/api/reports', { peerId: 'alice', reportedPeerId: 'mallory', matches: 31 })).statusCode, 401, 'peer login required');
    assert.equal((await report('alice', { reportedPeerId: 'alice' })).statusCode, 400, 'not yourself');
    assert.equal((await report('alice', { reportedPeerId: 'mallory', matches: 40 })).statusCode, 400);
    assert.equal((await report('alice', { reportedPeerId: 'mallory', note: 'auf einer Seite gefunden' })).statusCode, 200);
    assert.equal((await report('alice', { reportedPeerId: 'mallory' })).json().duplicate, true, 'no duplicate open report');
    assert.equal((await report('bob', { reportedPeerId: 'mallory', matches: 29 })).statusCode, 200);
    assert.equal((await report('bob', { reportedPeerId: 'alice', matches: 28 })).statusCode, 200);

    const listed = (await app.inject({ method: 'GET', url: '/api/admin/reports', headers: { cookie } })).json();
    assert.equal(listed.open, 3);
    const aboutMallory = listed.reports.filter(entry => entry.reportedId === 'mallory');
    assert.equal(aboutMallory.length, 2);
    assert.equal(aboutMallory[0].reportersAboutPeer, 2);
    assert.equal(listed.reports.find(entry => entry.reporterId === 'alice').note, 'auf einer Seite gefunden');
    assert.ok(listed.reports.every(entry => !('image' in entry)));

    // Sperren: Peer gesperrt, alle offenen Meldungen zu ihm erledigt.
    assert.equal((await post(app, `/api/admin/reports/${aboutMallory[0].id}`, { action: 'ban' }, { cookie })).statusCode, 403, 'admin header required');
    assert.equal((await post(app, `/api/admin/reports/${aboutMallory[0].id}`, { action: 'ban' }, H(cookie))).statusCode, 200);
    assert.equal((await registerPeer(app, 'mallory')).response.statusCode, 403);
    const afterBan = (await app.inject({ method: 'GET', url: '/api/admin/reports', headers: { cookie } })).json();
    assert.equal(afterBan.open, 1);
    const other = afterBan.reports[0];
    assert.equal(other.reportedId, 'alice');
    assert.equal((await post(app, `/api/admin/reports/${other.id}`, { action: 'dismiss' }, H(cookie))).statusCode, 200);
    const bans = (await app.inject({ method: 'GET', url: '/api/admin/bans', headers: { cookie } })).json().bans;
    assert.deepEqual(bans.map(ban => ban.value), ['mallory'], 'dismiss does not ban');
    const all = (await app.inject({ method: 'GET', url: '/api/admin/reports?status=all', headers: { cookie } })).json();
    assert.deepEqual(all.reports.map(entry => entry.status).sort(), ['banned', 'banned', 'dismissed']);
    assert.equal((await post(app, '/api/admin/reports/unknown', { action: 'ban' }, H(cookie))).statusCode, 404);
});

test('admin sessions are stored only as a hash; old load samples are pruned', async () => {
    const store = createStore(':memory:');
    const app = await buildApp({ store, buildVersion: 'test', buildTimestamp: 'x', appUrl: ORIGIN, adminSetupToken: SETUP });
    cleanup.push(async () => { await app.close(); store.close(); });
    const cookie = await setupPasskey(app, authenticator());
    const sessionId = cookie.split('=')[1];
    const stored = store.admin.findSession(createHash('sha256').update(sessionId).digest('hex'));
    assert.ok(stored, 'session found by its hash');
    assert.equal(store.admin.findSession(sessionId), null, 'never stored in plain text');

    store.admin.saveMetric('live', { at: Date.now() - 2 * 60 * 60 * 1000, cpu: 1 });
    assert.equal(store.admin.loadMetrics('live', 0).length, 2);
    store.admin.pruneMetrics('live', Date.now() - 60 * 60 * 1000);
    assert.equal(store.admin.loadMetrics('live', 0).length, 1, 'older than one hour removed');
});

// ----- Zwischenspeicher -----
test('queue analysis: only metadata (age, size, recipients, pairs), never content or type', async () => {
    const { analyzeQueue, createdAtOf } = await import('../server/queue-analysis.js');
    const now = Date.UTC(2026, 9, 29, 12);
    const row = (minutesAgo, recipientId, senderId, bytes = 100, expiresIn = 60) => ({
        msgId: `msg_${now - minutesAgo * 60000}_x`, recipientId, senderId, bytes, expiresAt: now + expiresIn * 60000
    });
    const result = analyzeQueue([
        row(10, 'gone', 'alice'), row(20, 'gone', 'alice'), row(30, 'gone', 'bob'),
        row(120, 'carol', 'alice', 300), row(26 * 60, 'carol', 'bob', 50, -5)
    ], { now, registered: new Set(['carol']), isOnline: id => id === 'carol' });
    assert.equal(result.total, 5);
    assert.equal(result.bytes, 650);
    assert.equal(result.expired, 1);
    assert.deepEqual(result.byAge, { lt1h: 3, '1to6h': 1, '6to24h': 0, gt24h: 1 });
    assert.equal(result.oldestAt, now - 26 * 60 * 60000);
    assert.deepEqual(result.recipients.map(entry => [entry.recipientId, entry.count, entry.registered, entry.online]), [['gone', 3, false, false], ['carol', 2, true, true]]);
    assert.equal(result.recipientsUnknown, 1);
    assert.deepEqual(result.pairs[0], { senderId: 'alice', recipientId: 'gone', count: 2 });
    assert.equal('byKind' in result, false);
    assert.equal(createdAtOf('weird'), null);
});

test('queue: admin sees the analysis and clears expired, per recipient or everything', async () => {
    const store = createStore(':memory:');
    const app = await buildApp({ store, buildVersion: 'test', buildTimestamp: 'x', appUrl: ORIGIN, adminSetupToken: SETUP, metrics: false });
    cleanup.push(async () => { await app.close(); store.close(); });
    const cookie = await setupPasskey(app, authenticator());
    const old = Date.now() - 48 * 60 * 60 * 1000;
    store.enqueueMessage({ recipientId: 'gone', senderId: 'alice', ciphertextPayload: 'x'.repeat(10), ttlHours: 1 }, old);
    store.enqueueMessage({ recipientId: 'gone', senderId: 'alice', ciphertextPayload: 'y'.repeat(10) });
    store.enqueueMessage({ recipientId: 'carol', senderId: 'bob', ciphertextPayload: 'z'.repeat(10) });
    const queue = (await app.inject({ method: 'GET', url: '/api/admin/queue', headers: { cookie } })).json();
    assert.equal(queue.total, 3);
    assert.equal(queue.expired, 1);
    assert.equal(JSON.stringify(queue).includes('xxxxxxxxxx'), false, 'no ciphertext in the analysis');
    const clear = body => post(app, '/api/admin/queue/clear', body, H(cookie));
    assert.equal((await post(app, '/api/admin/queue/clear', { scope: 'expired' }, { cookie })).statusCode, 403, 'admin header required');
    assert.equal((await clear({ scope: 'expired' })).json().removed, 1);
    assert.equal((await clear({ scope: 'recipient' })).statusCode, 400);
    assert.equal((await clear({ scope: 'recipient', recipientId: 'gone' })).json().removed, 1);
    assert.equal((await clear({ scope: 'all' })).json().removed, 1);
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/queue', headers: { cookie } })).json().total, 0);
});

test('admin live config: OIDC age service, client secret encrypted and never shown', async () => {
    const store = createStore(':memory:');
    const build = () => buildApp({
        store, buildVersion: 'test', buildTimestamp: 'x', appUrl: ORIGIN, adminSetupToken: SETUP,
        safety: { ageCheck: 'provider', ageProvider: 'oidc' }, ageOidc: {}
    });
    let app = await build();
    cleanup.push(async () => store.close());
    const cookie = await setupPasskey(app, authenticator());
    const live = async () => (await app.inject({ method: 'GET', url: '/api/admin/config', headers: { cookie } })).json().live.AGE_OIDC;
    assert.equal((await live()).value, null, 'not set up yet');

    const value = JSON.stringify({ issuer: 'https://idp.example.org', clientId: 'og', clientSecret: 'top-secret', claim: 'age.over18' });
    assert.equal((await put(app, 'AGE_OIDC', value, cookie)).statusCode, 200);
    const shown = await live();
    assert.equal(shown.value.clientSecretSet, true);
    assert.equal(JSON.stringify(shown).includes('top-secret'), false, 'secret never leaves the router');
    const stored = JSON.stringify(store.admin.settings().AGE_OIDC);
    assert.equal(stored.includes('top-secret'), false, 'encrypted in the database');
    assert.match(stored, /clientSecretEncrypted/);

    // Speichern ohne clientSecret (so wie das Panel es anzeigt) behaelt das Geheimnis.
    assert.equal((await put(app, 'AGE_OIDC', JSON.stringify({ ...shown.value, scope: 'openid age' }), cookie)).statusCode, 200);
    assert.equal((await live()).value.clientSecretSet, true);
    assert.equal((await live()).value.scope, 'openid age');
    assert.equal((await put(app, 'AGE_OIDC', '{"issuer":"http://idp.example.org","clientId":"og"}', cookie)).statusCode, 400, 'https only');

    // Nach einem Neustart wieder entschluesselt und aktiv.
    await app.close();
    app = await build();
    cleanup.push(async () => app.close());
    const after = (await app.inject({ method: 'GET', url: '/api/admin/config', headers: { cookie } })).json().live.AGE_OIDC;
    assert.equal(after.source, 'panel');
    assert.equal(after.value.clientSecretSet, true, 'decrypted again after the restart');
    assert.equal(after.value.claim, 'age.over18');
    // Leeres clientSecret loescht es (oeffentlicher Client mit PKCE).
    assert.equal((await put(app, 'AGE_OIDC', JSON.stringify({ issuer: 'https://idp.example.org', clientId: 'og', clientSecret: '' }), cookie)).statusCode, 200);
    assert.equal((await live()).value.clientSecretSet, false);
});
