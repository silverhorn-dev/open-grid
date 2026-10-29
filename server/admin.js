import { randomBytes } from 'node:crypto';
import {
    generateAuthenticationOptions,
    generateRegistrationOptions,
    verifyAuthenticationResponse,
    verifyRegistrationResponse
} from '@simplewebauthn/server';

// ================= ADMIN-PANEL (Board T25) =================
// Eigene Seite /admin (admin.html, client/admin.js), Login nur per Passkey (WebAuthn, Nutzerpruefung
// Pflicht). Gibt es noch keinen Passkey, schreibt der Router beim Start einen einmaligen Setup-Link
// (24 h) ins Log; damit legt der Betreiber den ersten Passkey an, weitere im Panel. Sitzung per
// HttpOnly-Cookie (SameSite=Strict, Pfad /api/admin, 12 h), aendernde Anfragen brauchen zusaetzlich den
// Header `x-opengrid-admin: 1`. Das Panel sieht nur Technisches und Router-Daten, nie Nutzerinhalte.
const SESSION_COOKIE = 'og_admin';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SETUP_TTL_MS = 24 * 60 * 60 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_CHALLENGES = 200;

function parseCookies(header) {
    return Object.fromEntries(String(header || '').split(';').map(part => part.trim().split('='))
        .filter(([key, value]) => key && value !== undefined).map(([key, ...rest]) => [key, decodeURIComponent(rest.join('='))]));
}

export function registerAdminRoutes(app, {
    store, metrics, status, appUrl = '', log, now = Date.now,
    allowRequest, setupToken: fixedSetupToken = null,
    liveConfig = null, restartOnly = () => [], safety = null, disconnectPeer = () => {}
}) {
    const sessions = new Map();
    const challenges = new Map();
    let configuredOrigin = null;
    try {
        configuredOrigin = appUrl ? new URL(appUrl).origin : null;
    } catch {
        configuredOrigin = null;
    }

    // Einmaliger Setup-Link, solange kein Passkey existiert.
    let setup = null;
    function ensureSetupToken() {
        if (store.admin.countPasskeys() > 0) {
            setup = null;
            return null;
        }
        if (!setup || setup.expiresAt <= now()) {
            setup = { token: fixedSetupToken || randomBytes(24).toString('base64url'), expiresAt: now() + SETUP_TTL_MS };
            const base = configuredOrigin || '<deine-adresse>';
            log.warn(`Admin panel: no passkey yet. Set one up within 24 h: ${base}/admin#setup=${setup.token}`);
        }
        return setup;
    }
    ensureSetupToken();

    const relyingParty = request => {
        const origin = configuredOrigin || `${request.protocol}://${request.host}`;
        return { origin, rpID: new URL(origin).hostname };
    };

    function remember(challenge, data) {
        for (const [key, entry] of challenges) if (entry.expiresAt <= now()) challenges.delete(key);
        while (challenges.size >= MAX_CHALLENGES) challenges.delete(challenges.keys().next().value);
        challenges.set(challenge, { ...data, expiresAt: now() + CHALLENGE_TTL_MS });
    }

    function takeChallenge(challenge, kind) {
        const entry = challenges.get(challenge);
        challenges.delete(challenge);
        return entry && entry.kind === kind && entry.expiresAt > now() ? entry : null;
    }

    function sessionOf(request) {
        const id = parseCookies(request.headers.cookie)[SESSION_COOKIE];
        const session = id ? sessions.get(id) : null;
        if (!session) return null;
        if (session.expiresAt <= now()) {
            sessions.delete(id);
            return null;
        }
        return { id, ...session };
    }

    function startSession(request, reply) {
        const id = randomBytes(32).toString('base64url');
        sessions.set(id, { expiresAt: now() + SESSION_TTL_MS });
        const secure = relyingParty(request).origin.startsWith('https:') ? '; Secure' : '';
        reply.header('Set-Cookie', `${SESSION_COOKIE}=${id}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${secure}`);
    }

    const limited = (request, reply) => !allowRequest('admin', request.ip, reply);
    // Lesen: Sitzung noetig. Aendern: zusaetzlich der eigene Header (gegen Formular-/CSRF-Tricks).
    function requireAdmin(request, reply, { change = false } = {}) {
        if (limited(request, reply)) return null;
        const session = sessionOf(request);
        if (!session) {
            reply.code(401).send({ error: 'Admin login required' });
            return null;
        }
        if (change && request.headers['x-opengrid-admin'] !== '1') {
            reply.code(403).send({ error: 'Missing admin header' });
            return null;
        }
        return session;
    }

    app.get('/api/admin/session', async (request, reply) => {
        if (limited(request, reply)) return reply;
        return { loggedIn: Boolean(sessionOf(request)), setupPending: Boolean(ensureSetupToken()) };
    });

    // ----- Passkey anlegen: mit Setup-Token (erster) oder angemeldet (weitere) -----
    app.post('/api/admin/passkeys/options', async (request, reply) => {
        if (limited(request, reply)) return reply;
        const loggedIn = Boolean(sessionOf(request));
        const current = ensureSetupToken();
        const viaSetup = !loggedIn && current && request.body?.setupToken === current.token;
        if (!loggedIn && !viaSetup) return reply.code(401).send({ error: 'Setup link or login required' });
        if (loggedIn && request.headers['x-opengrid-admin'] !== '1') return reply.code(403).send({ error: 'Missing admin header' });
        const { rpID } = relyingParty(request);
        const options = await generateRegistrationOptions({
            rpName: 'OpenGrid Admin',
            rpID,
            userName: 'admin',
            userDisplayName: 'OpenGrid Admin',
            attestationType: 'none',
            excludeCredentials: store.admin.listPasskeys().map(({ id }) => ({ id })),
            authenticatorSelection: { residentKey: 'required', userVerification: 'required' }
        });
        remember(options.challenge, { kind: 'register', viaSetup });
        return options;
    });

    app.post('/api/admin/passkeys', async (request, reply) => {
        if (limited(request, reply)) return reply;
        const response = request.body?.response;
        const challenge = request.body?.challenge;
        const entry = typeof challenge === 'string' ? takeChallenge(challenge, 'register') : null;
        if (!entry || !response) return reply.code(400).send({ error: 'Unknown or expired challenge' });
        const loggedIn = Boolean(sessionOf(request));
        if (entry.viaSetup ? !ensureSetupToken() : !loggedIn) return reply.code(401).send({ error: 'Not allowed' });
        const { origin, rpID } = relyingParty(request);
        let verification;
        try {
            verification = await verifyRegistrationResponse({
                response, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true
            });
        } catch (error) {
            return reply.code(400).send({ error: 'Passkey not accepted', reason: error.message });
        }
        if (!verification.verified) return reply.code(400).send({ error: 'Passkey not accepted' });
        const { credential } = verification.registrationInfo;
        const name = String(request.body?.name || '').trim().slice(0, 60) || null;
        store.admin.addPasskey({ id: credential.id, publicKey: credential.publicKey, counter: credential.counter, transports: credential.transports, name }, now());
        log.info(`Admin passkey added${name ? ` (${name})` : ''}.`);
        setup = null;
        if (!loggedIn) startSession(request, reply);
        return { ok: true };
    });

    // ----- Anmelden -----
    app.post('/api/admin/login/options', async (request, reply) => {
        if (limited(request, reply)) return reply;
        const { rpID } = relyingParty(request);
        const options = await generateAuthenticationOptions({ rpID, userVerification: 'required', allowCredentials: [] });
        remember(options.challenge, { kind: 'login' });
        return options;
    });

    app.post('/api/admin/login', async (request, reply) => {
        if (limited(request, reply)) return reply;
        const response = request.body?.response;
        const challenge = request.body?.challenge;
        const entry = typeof challenge === 'string' ? takeChallenge(challenge, 'login') : null;
        if (!entry || !response?.id) return reply.code(400).send({ error: 'Unknown or expired challenge' });
        const passkey = store.admin.findPasskey(String(response.id));
        if (!passkey) return reply.code(401).send({ error: 'Unknown passkey' });
        const { origin, rpID } = relyingParty(request);
        let verification;
        try {
            verification = await verifyAuthenticationResponse({
                response, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
                credential: { id: passkey.id, publicKey: passkey.publicKey, counter: passkey.counter, transports: passkey.transports }
            });
        } catch (error) {
            return reply.code(401).send({ error: 'Login failed', reason: error.message });
        }
        if (!verification.verified) return reply.code(401).send({ error: 'Login failed' });
        store.admin.touchPasskey(passkey.id, verification.authenticationInfo.newCounter, now());
        startSession(request, reply);
        return { ok: true };
    });

    app.post('/api/admin/logout', async (request, reply) => {
        const session = sessionOf(request);
        if (session) sessions.delete(session.id);
        reply.header('Set-Cookie', `${SESSION_COOKIE}=; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=0`);
        return { ok: true };
    });

    app.get('/api/admin/passkeys', async (request, reply) => {
        if (!requireAdmin(request, reply)) return reply;
        return { passkeys: store.admin.listPasskeys() };
    });

    app.delete('/api/admin/passkeys/:id', async (request, reply) => {
        if (!requireAdmin(request, reply, { change: true })) return reply;
        if (store.admin.countPasskeys() <= 1) return reply.code(409).send({ error: 'The last passkey cannot be removed' });
        return store.admin.removePasskey(request.params.id) ? { ok: true } : reply.code(404).send({ error: 'Unknown passkey' });
    });

    // ----- Status und Auslastung -----
    app.get('/api/admin/status', async (request, reply) => {
        if (!requireAdmin(request, reply)) return reply;
        return status();
    });

    app.get('/api/admin/metrics', async (request, reply) => {
        if (!requireAdmin(request, reply)) return reply;
        return metrics.series(request.query?.range === '24h' ? '24h' : '1h');
    });

    // ----- Live-Konfiguration (server/live-config.js) -----
    app.get('/api/admin/config', async (request, reply) => {
        if (!requireAdmin(request, reply)) return reply;
        return { live: liveConfig?.list() || {}, restartOnly: restartOnly() };
    });

    app.put('/api/admin/config/:key', async (request, reply) => {
        if (!requireAdmin(request, reply, { change: true })) return reply;
        try {
            liveConfig.set(request.params.key, request.body?.value ?? null);
        } catch (error) {
            return reply.code(400).send({ error: 'Invalid value', reason: error.message });
        }
        return { ok: true, setting: liveConfig.list()[request.params.key] };
    });

    app.delete('/api/admin/config/:key', async (request, reply) => {
        if (!requireAdmin(request, reply, { change: true })) return reply;
        try {
            liveConfig.reset(request.params.key);
        } catch (error) {
            return reply.code(400).send({ error: 'Invalid setting', reason: error.message });
        }
        return { ok: true, setting: liveConfig.list()[request.params.key] };
    });

    // ----- Meldungen (server/reports.js) -----
    app.get('/api/admin/reports', async (request, reply) => {
        if (!requireAdmin(request, reply)) return reply;
        const status = ['open', 'banned', 'dismissed', 'all'].includes(request.query?.status) ? request.query.status : 'open';
        return { reports: store.admin.listReports(status), open: store.admin.openReportCount() };
    });

    app.post('/api/admin/reports/:id', async (request, reply) => {
        if (!requireAdmin(request, reply, { change: true })) return reply;
        const action = request.body?.action;
        const report = store.admin.findReport(request.params.id);
        if (!report) return reply.code(404).send({ error: 'Unknown report' });
        if (!['ban', 'dismiss'].includes(action)) return reply.code(400).send({ error: 'Invalid action' });
        if (action === 'ban') {
            safety.ban('peer', report.reportedId, `report ${report.id}`);
            disconnectPeer(report.reportedId);
        }
        store.admin.resolveReport(report.id, action === 'ban' ? 'banned' : 'dismissed', now());
        log.info(`Admin panel: report ${action === 'ban' ? 'led to a ban' : 'dismissed'}.`);
        return { ok: true };
    });

    // ----- Sperren (wie scripts/safety-admin.mjs) -----
    // Peer-IDs im Klartext; E-Mail und Wallet nur als HMAC (gekuerzt angezeigt).
    app.get('/api/admin/bans', async (request, reply) => {
        if (!requireAdmin(request, reply)) return reply;
        return { bans: store.safety.listBans() };
    });

    app.post('/api/admin/bans', async (request, reply) => {
        if (!requireAdmin(request, reply, { change: true })) return reply;
        const { kind, value, reason } = request.body || {};
        if (!['peer', 'email'].includes(kind) || typeof value !== 'string' || !value.trim() || value.length > 254) {
            return reply.code(400).send({ error: 'Invalid ban' });
        }
        try {
            safety.ban(kind, value.trim(), typeof reason === 'string' ? reason.trim().slice(0, 200) || null : null);
        } catch (error) {
            return reply.code(400).send({ error: 'Invalid ban', reason: error.message });
        }
        // Eine offene Verbindung trennen; beim naechsten Registrieren greift die Sperre.
        if (kind === 'peer') disconnectPeer(value.trim());
        log.info(`Admin panel: ${kind} ban added.`);
        return { ok: true };
    });

    app.delete('/api/admin/bans/:kind/:value', async (request, reply) => {
        if (!requireAdmin(request, reply, { change: true })) return reply;
        const removed = store.safety.removeBan(request.params.kind, request.params.value);
        if (removed) log.info(`Admin panel: ${request.params.kind} ban lifted.`);
        return removed ? { ok: true } : reply.code(404).send({ error: 'Unknown ban' });
    });

    return { sessionCount: () => sessions.size };
}
