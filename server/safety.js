// Alters- und E-Mail-Nachweis, Sperren und optionales IP-Protokoll (Board T2).
// Alles ist standardmaessig aus (AGE_CHECK=off, EMAIL_CHECK=off, ABUSE_LOG_DAYS=0). Ist ein Nachweis
// verlangt, bleibt ein Peer bis zum Nachweis unsichtbar (silent) und bekommt kein Grid.
//
// Altersnachweis ueber Anbieter: ein Anbieter-Modul liefert nur "ueber 18: ja/nein" und optional ein
// Pseudonym (subject). Der Router speichert davon nur einen HMAC des Pseudonyms (fuer Sperren),
// nie Ausweis-, Gesichts- oder Geburtsdaten. Anbieter: `eudi` (EU-Altersnachweis ueber die Wallet,
// age-eudi.js), jeder OpenID-Connect-Dienst `oidc` (z. B. KJM-anerkannte Pruefdienste, age-oidc.js; beide
// werden in app.js erzeugt) und der Test-Anbieter `dev`.
import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { createSmtpTransport, parseSmtpConfig } from './email-smtp.js';

export const AGE_CHECK_MODES = ['off', 'confirm', 'provider'];
export const EMAIL_CHECK_MODES = ['off', 'required'];
export const MAX_ABUSE_LOG_DAYS = 14;
const EMAIL_CODE_TTL_MS = 15 * 60 * 1000;
const EMAIL_CODE_MAX_ATTEMPTS = 5;
const AGE_PROVIDER_VALIDITY_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_EMAIL_LENGTH = 254;

// Anbieter: { id, start({ peerId }) -> { kind, ... }, finish({ peerId, payload, origin }) -> { over18, subject?, reason? } }.
// `dev` bestaetigt auf Knopfdruck und ist nur zum Testen des Ablaufs gedacht.
export const AGE_PROVIDERS = {
    dev: {
        id: 'dev',
        start: () => ({ kind: 'dev' }),
        finish: ({ peerId, payload }) => ({ over18: payload?.over18 === true, minor: payload?.over18 === false, subject: `dev:${payload?.subject || peerId}` })
    }
};

// Versand der E-Mail-Codes. Enthalten ist nur `log` (Code im Server-Log, zum Testen); ein
// SMTP-Versand ueber den Mailserver des Betreibers folgt, wenn T2 entschieden ist.
export const EMAIL_TRANSPORTS = {
    log: { send: ({ code }, log) => log.warn(`E-Mail-Code (EMAIL_TRANSPORT=log, nur zum Testen): ${code}`) }
};

export function parseSafetyConfig(source = {}) {
    const pick = (value, allowed, fallback) => {
        const normalized = String(value ?? '').trim().toLowerCase();
        return allowed.includes(normalized) ? normalized : fallback;
    };
    const days = Math.floor(Number(source.abuseLogDays));
    return {
        ageCheck: pick(source.ageCheck, AGE_CHECK_MODES, 'off'),
        ageProvider: String(source.ageProvider ?? '').trim().toLowerCase() || null,
        emailCheck: pick(source.emailCheck, EMAIL_CHECK_MODES, 'off'),
        emailTransport: String(source.emailTransport ?? '').trim().toLowerCase() || 'log',
        abuseLogDays: Number.isFinite(days) ? Math.min(MAX_ABUSE_LOG_DAYS, Math.max(0, days)) : 0,
        ageSeparation: String(source.ageSeparation ?? '').trim().toLowerCase() !== 'off',
        safetyKey: source.safetyKey ? String(source.safetyKey).trim() : null,
        // Nur fuer EMAIL_TRANSPORT=smtp (email-smtp.js).
        smtp: parseSmtpConfig({ url: source.smtpUrl, from: source.smtpFrom })
    };
}

export function normalizeEmail(value) {
    const email = String(value ?? '').trim().toLowerCase();
    if (!email || email.length > MAX_EMAIL_LENGTH) return null;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

// Schluessel des Betreibers: SAFETY_KEY (32 Byte, base64 oder hex); fehlt er, einmal erzeugt und in
// SQLite behalten (dann liegen Schluessel und Daten zusammen, im Betrieb besser SAFETY_KEY setzen).
export function loadSafetyKey(config, store) {
    const fromConfig = config.safetyKey;
    if (fromConfig) {
        const bytes = /^[0-9a-f]{64}$/i.test(fromConfig) ? Buffer.from(fromConfig, 'hex') : Buffer.from(fromConfig, 'base64');
        if (bytes.length === 32) return bytes;
        throw new Error('SAFETY_KEY muss 32 Byte lang sein (base64 oder hex).');
    }
    return Buffer.from(store.getOrCreateSetting('safety-key', () => randomBytes(32).toString('base64')), 'base64');
}

export function createSafetyCrypto(key) {
    const hmacKey = createHmac('sha256', key).update('og-safety-hmac').digest();
    const encryptionKey = createHmac('sha256', key).update('og-safety-encryption').digest();
    return {
        hash(kind, value) {
            return createHmac('sha256', hmacKey).update(`${kind}:${value}`).digest('base64url');
        },
        encrypt(text) {
            const iv = randomBytes(12);
            const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
            const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
            return [iv, cipher.getAuthTag(), ciphertext].map(part => part.toString('base64url')).join('.');
        },
        decrypt(value) {
            const [iv, tag, ciphertext] = String(value).split('.').map(part => Buffer.from(part, 'base64url'));
            const decipher = createDecipheriv('aes-256-gcm', encryptionKey, iv);
            decipher.setAuthTag(tag);
            return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
        }
    };
}

function sameHash(left, right) {
    const a = Buffer.from(String(left));
    const b = Buffer.from(String(right));
    return a.length === b.length && timingSafeEqual(a, b);
}

export function createSafety({ config: startConfig, store, log, now = Date.now, ageProviders = {} }) {
    const safetyStore = store.safety;
    // Eigene Kopie: AGE_CHECK, EMAIL_CHECK und ABUSE_LOG_DAYS lassen sich zur Laufzeit aendern (updateConfig,
    // Admin-Panel); Anbieter und Versand stehen ab dem Start fest.
    const config = { ...startConfig };
    let ageCheck = config.ageCheck;
    // Der Anbieter wird auch ohne AGE_CHECK=provider vorbereitet, damit das Panel ihn spaeter einschalten kann.
    const provider = config.ageProvider ? (ageProviders[config.ageProvider] || AGE_PROVIDERS[config.ageProvider] || null) : null;
    if (ageCheck === 'provider') {
        if (!provider) {
            // Ohne Anbieter kann niemand den Nachweis erbringen; dann wenigstens die Bestaetigung.
            log.error(`AGE_CHECK=provider, aber AGE_PROVIDER "${config.ageProvider || ''}" ist unbekannt. Es gilt AGE_CHECK=confirm.`);
            ageCheck = 'confirm';
        } else if (provider.id === 'dev') {
            log.warn('AGE_PROVIDER=dev bestaetigt jedes Alter auf Knopfdruck. Nur zum Testen verwenden.');
        }
    }
    let transport = EMAIL_TRANSPORTS[config.emailTransport] || null;
    if (config.emailTransport === 'smtp') {
        transport = config.smtp ? createSmtpTransport(config.smtp) : null;
        if (!transport && config.emailCheck === 'required') {
            log.error('EMAIL_TRANSPORT=smtp braucht SMTP_URL (smtp:// oder smtps://) und SMTP_FROM; E-Mail-Codes koennen nicht verschickt werden.');
        }
    } else if (config.emailCheck === 'required' && !transport) {
        log.error(`EMAIL_TRANSPORT "${config.emailTransport}" ist unbekannt; E-Mail-Codes koennen nicht verschickt werden.`);
    }
    // Betreiber-Schluessel erst bei Bedarf laden (auch wenn ein Nachweis spaeter eingeschaltet wird).
    let cryptoInstance = null;
    const safetyCrypto = {
        hash: (...args) => (cryptoInstance ||= createSafetyCrypto(loadSafetyKey(config, store))).hash(...args),
        encrypt: (...args) => (cryptoInstance ||= createSafetyCrypto(loadSafetyKey(config, store))).encrypt(...args)
    };

    function required() {
        const kinds = [];
        if (ageCheck !== 'off') kinds.push('age');
        if (config.emailCheck === 'required') kinds.push('email');
        return kinds;
    }

    function missing(peerId) {
        return required().filter(kind => !safetyStore.getVerification(peerId, kind, now()));
    }

    function status(peerId) {
        const result = {};
        for (const kind of ['age', 'email']) {
            const verification = safetyStore.getVerification(peerId, kind, now());
            result[kind] = {
                required: required().includes(kind),
                verified: Boolean(verification),
                method: verification?.method || null,
                expiresAt: verification?.expiresAt ?? null,
                ...(kind === 'age' ? { group: verification ? verification.ageGroup || 'adult' : null } : {})
            };
        }
        return result;
    }

    // Altersgruppe laut Nachweis: 'adult', 'minor' oder null (kein Nachweis).
    function ageGroupOf(peerId) {
        const verification = safetyStore.getVerification(peerId, 'age', now());
        return verification ? verification.ageGroup || 'adult' : null;
    }

    return {
        get active() {
            return required().length > 0;
        },
        publicConfig() {
            return { ageCheck, ageProvider: ageCheck === 'provider' ? provider?.id || null : null, emailCheck: config.emailCheck };
        },
        // Was das Panel einstellen darf (provider nur mit Anbieter, required nur mit Versand).
        options() {
            return {
                ageCheck: AGE_CHECK_MODES.filter(mode => mode !== 'provider' || provider),
                emailCheck: EMAIL_CHECK_MODES.filter(mode => mode !== 'required' || transport),
                ageProvider: provider?.id || null,
                abuseLogDays: config.abuseLogDays
            };
        },
        // Live-Aenderung aus dem Admin-Panel; ungueltige Werte werden abgelehnt (Fehler).
        updateConfig({ ageCheck: nextAgeCheck, emailCheck, abuseLogDays } = {}) {
            const allowed = this.options();
            if (nextAgeCheck !== undefined) {
                if (!allowed.ageCheck.includes(nextAgeCheck)) throw new Error(`AGE_CHECK=${nextAgeCheck} is not possible here`);
                ageCheck = nextAgeCheck;
                if (ageCheck === 'provider' && provider?.id === 'dev') log.warn('AGE_PROVIDER=dev bestaetigt jedes Alter auf Knopfdruck. Nur zum Testen verwenden.');
            }
            if (emailCheck !== undefined) {
                if (!allowed.emailCheck.includes(emailCheck)) throw new Error(`EMAIL_CHECK=${emailCheck} is not possible here`);
                config.emailCheck = emailCheck;
            }
            if (abuseLogDays !== undefined) {
                const days = Number(abuseLogDays);
                if (!Number.isInteger(days) || days < 0 || days > MAX_ABUSE_LOG_DAYS) throw new Error('ABUSE_LOG_DAYS must be 0-14');
                config.abuseLogDays = days;
            }
            return this.publicConfig();
        },
        missing,
        status,
        ageGroupOf,
        // Getrennte Gruppen in Entdecken/Event, sobald ein Altersnachweis verlangt ist.
        get ageSeparationActive() {
            return ageCheck !== 'off' && config.ageSeparation !== false;
        },
        isPeerBanned(peerId) {
            return safetyStore.isBanned('peer', peerId);
        },

        // IP-Protokoll fuer den Rechtsweg (ABUSE_LOG_DAYS > 0), aelteres wird geloescht.
        logAccess(peerId, ip) {
            if (!config.abuseLogDays || !ip) return;
            const timestamp = now();
            safetyStore.logAccess(peerId, String(ip), timestamp);
            safetyStore.pruneAccessLog(timestamp - config.abuseLogDays * 24 * 60 * 60 * 1000);
        },

        confirmAge(peerId) {
            if (ageCheck !== 'confirm') return { error: 'Age confirmation not enabled', code: 400 };
            safetyStore.saveVerification(peerId, 'age', { method: 'confirm', ageGroup: 'adult' }, now());
            return { ok: true };
        },

        async startAgeCheck(peerId, { origin } = {}) {
            if (!provider || ageCheck !== 'provider') return { error: 'Age provider not enabled', code: 400 };
            let start;
            try {
                start = await provider.start({ peerId, origin });
            } catch (error) {
                log.warn(`Age provider ${provider.id} could not start: ${error.message}`);
                return { error: 'Age provider unavailable', code: 503 };
            }
            // Anbieter noch nicht eingerichtet (z. B. OIDC ohne Aussteller).
            if (start?.kind === 'unavailable') return { error: 'Age provider unavailable', code: 503 };
            return { ok: true, provider: provider.id, ...start };
        },

        async finishAgeCheck(peerId, payload, { origin } = {}) {
            if (!provider || ageCheck !== 'provider') return { error: 'Age provider not enabled', code: 400 };
            const result = await provider.finish({ peerId, payload, origin });
            // Ein gueltiger Nachweis "unter 18" ist auch ein Nachweis: Gruppe 'minor' (getrenntes Entdecken).
            if (!result?.over18 && !result?.minor) return { error: 'Age not confirmed', code: 403, ...(result?.reason ? { reason: result.reason } : {}) };
            const subjectHash = result.subject ? safetyCrypto.hash('subject', result.subject) : null;
            if (subjectHash && safetyStore.isBanned('subject', subjectHash)) return { error: 'Banned', code: 403 };
            safetyStore.saveVerification(peerId, 'age', {
                method: `provider:${provider.id}`,
                expiresAt: now() + AGE_PROVIDER_VALIDITY_MS,
                subjectHash,
                ageGroup: result.over18 ? 'adult' : 'minor'
            }, now());
            return { ok: true, group: result.over18 ? 'adult' : 'minor' };
        },

        async startEmailCheck(peerId, rawEmail) {
            if (config.emailCheck !== 'required') return { error: 'Email check not enabled', code: 400 };
            if (!transport) return { error: 'Email transport unavailable', code: 503 };
            const email = normalizeEmail(rawEmail);
            if (!email) return { error: 'Invalid email', code: 400 };
            const emailHash = safetyCrypto.hash('email', email);
            if (safetyStore.isBanned('email', emailHash)) return { error: 'Banned', code: 403 };
            const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
            safetyStore.saveEmailCode(peerId, {
                emailHash,
                emailEncrypted: safetyCrypto.encrypt(email),
                codeHash: safetyCrypto.hash('code', `${peerId}:${code}`),
                expiresAt: now() + EMAIL_CODE_TTL_MS
            });
            try {
                await transport.send({ email, code }, log);
            } catch (error) {
                // Ohne Versand ist der Code nutzlos; der Nutzer kann es gleich erneut versuchen.
                safetyStore.deleteEmailCode(peerId);
                log.error(`E-Mail-Code konnte nicht verschickt werden: ${error.message}`);
                return { error: 'Email could not be sent', code: 502 };
            }
            return { ok: true, expiresAt: now() + EMAIL_CODE_TTL_MS };
        },

        confirmEmail(peerId, code) {
            if (config.emailCheck !== 'required') return { error: 'Email check not enabled', code: 400 };
            const pending = safetyStore.getEmailCode(peerId);
            if (!pending || pending.expiresAt <= now() || pending.attempts >= EMAIL_CODE_MAX_ATTEMPTS) {
                return { error: 'Code expired', code: 410 };
            }
            if (!/^\d{6}$/.test(String(code ?? '')) || !sameHash(safetyCrypto.hash('code', `${peerId}:${code}`), pending.codeHash)) {
                safetyStore.countEmailAttempt(peerId);
                return { error: 'Wrong code', code: 403 };
            }
            safetyStore.deleteEmailCode(peerId);
            safetyStore.saveVerification(peerId, 'email', {
                method: 'code',
                subjectHash: pending.emailHash,
                emailEncrypted: pending.emailEncrypted
            }, now());
            return { ok: true };
        },

        // Fuer Betreiber-Skripte: Sperren per Peer-ID, E-Mail-Adresse oder Anbieter-Pseudonym.
        ban(kind, value, reason = null) {
            if (kind === 'peer') safetyStore.addBan('peer', value, reason, now());
            else if (kind === 'email') {
                const email = normalizeEmail(value);
                if (!email) throw new Error('Invalid email');
                safetyStore.addBan('email', safetyCrypto.hash('email', email), reason, now());
            }
            else if (kind === 'subject') safetyStore.addBan('subject', value, reason, now());
            else throw new Error(`Unknown ban kind ${kind}`);
        }
    };
}

export function registerSafetyRoutes(app, { safety, allowRequest, requirePeerAuth, isString }) {
    const send = (reply, result) => (result.error
        ? reply.code(result.code || 400).send({ error: result.error, ...(result.reason ? { reason: result.reason } : {}) })
        : result);
    const authed = (request, reply) => {
        if (!allowRequest('safety', request.ip, reply)) return null;
        const peerId = request.body?.peerId ?? request.query?.peerId;
        if (!isString(peerId, 200)) {
            reply.code(400).send({ error: 'Missing peerId' });
            return null;
        }
        return requirePeerAuth(request, reply, peerId) ? peerId : null;
    };

    app.get('/api/safety/status', async (request, reply) => {
        const peerId = authed(request, reply);
        if (!peerId) return reply;
        return reply.header('Cache-Control', 'no-store').send(safety.status(peerId));
    });
    app.post('/api/safety/age/confirm', async (request, reply) => {
        const peerId = authed(request, reply);
        if (!peerId) return reply;
        if (request.body?.over18 !== true) return reply.code(400).send({ error: 'Confirmation missing' });
        return send(reply, safety.confirmAge(peerId));
    });
    app.post('/api/safety/age/start', async (request, reply) => {
        const peerId = authed(request, reply);
        if (!peerId) return reply;
        return send(reply, await safety.startAgeCheck(peerId, { origin: `${request.protocol}://${request.host}` }));
    });
    app.post('/api/safety/age/finish', async (request, reply) => {
        const peerId = authed(request, reply);
        if (!peerId) return reply;
        // Herkunft der Seite (fuer die Bindung der Wallet-Antwort, wenn APP_URL fehlt).
        return send(reply, await safety.finishAgeCheck(peerId, request.body?.payload, { origin: `${request.protocol}://${request.host}` }));
    });
    app.post('/api/safety/email/start', async (request, reply) => {
        const peerId = authed(request, reply);
        if (!peerId) return reply;
        return send(reply, await safety.startEmailCheck(peerId, request.body?.email));
    });
    app.post('/api/safety/email/confirm', async (request, reply) => {
        const peerId = authed(request, reply);
        if (!peerId) return reply;
        return send(reply, safety.confirmEmail(peerId, request.body?.code));
    });
}

