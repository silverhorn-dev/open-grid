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
