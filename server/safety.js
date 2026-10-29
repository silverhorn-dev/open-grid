// Alters- und E-Mail-Nachweis, Sperren und optionales IP-Protokoll (Board T2).
// Alles ist standardmaessig aus (AGE_CHECK=off, EMAIL_CHECK=off, ABUSE_LOG_DAYS=0). Ist ein Nachweis
// verlangt, bleibt ein Peer bis zum Nachweis unsichtbar (silent) und bekommt kein Grid.
//
// Altersnachweis ueber Anbieter: ein Anbieter-Modul liefert nur "ueber 18: ja/nein" und optional ein
// Pseudonym (subject). Der Router speichert davon nur einen HMAC des Pseudonyms (fuer Sperren),
// nie Ausweis-, Gesichts- oder Geburtsdaten. Echte Anbieter (EU-Altersnachweis, KJM-anerkannte
// Dienste) kommen spaeter; enthalten ist nur der Test-Anbieter `dev`.
import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const AGE_CHECK_MODES = ['off', 'confirm', 'provider'];
export const EMAIL_CHECK_MODES = ['off', 'required'];
export const MAX_ABUSE_LOG_DAYS = 14;
const EMAIL_CODE_TTL_MS = 15 * 60 * 1000;
const EMAIL_CODE_MAX_ATTEMPTS = 5;
const AGE_PROVIDER_VALIDITY_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_EMAIL_LENGTH = 254;

// Anbieter: { id, start({ peerId }) -> { kind, ... }, finish({ peerId, payload }) -> { over18, subject? } }.
// `dev` bestaetigt auf Knopfdruck und ist nur zum Testen des Ablaufs gedacht.
export const AGE_PROVIDERS = {
    dev: {
        id: 'dev',
        start: () => ({ kind: 'dev' }),
        finish: ({ peerId, payload }) => ({ over18: payload?.over18 === true, subject: `dev:${payload?.subject || peerId}` })
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
        safetyKey: source.safetyKey ? String(source.safetyKey).trim() : null
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

export function createSafety({ config, store, log, now = Date.now }) {
    const safetyStore = store.safety;
    let ageCheck = config.ageCheck;
    let provider = null;
    if (ageCheck === 'provider') {
        provider = AGE_PROVIDERS[config.ageProvider] || null;
        if (!provider) {
            // Ohne Anbieter kann niemand den Nachweis erbringen; dann wenigstens die Bestaetigung.
            log.error(`AGE_CHECK=provider, aber AGE_PROVIDER "${config.ageProvider || ''}" ist unbekannt. Es gilt AGE_CHECK=confirm.`);
            ageCheck = 'confirm';
        } else if (provider.id === 'dev') {
            log.warn('AGE_PROVIDER=dev bestaetigt jedes Alter auf Knopfdruck. Nur zum Testen verwenden.');
        }
    }
    const transport = EMAIL_TRANSPORTS[config.emailTransport] || null;
    if (config.emailCheck === 'required' && !transport) {
        log.error(`EMAIL_TRANSPORT "${config.emailTransport}" ist unbekannt; E-Mail-Codes koennen nicht verschickt werden.`);
    }
    const needsKey = config.emailCheck === 'required' || ageCheck === 'provider';
    const safetyCrypto = needsKey ? createSafetyCrypto(loadSafetyKey(config, store)) : null;

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
                expiresAt: verification?.expiresAt ?? null
            };
        }
        return result;
    }

    return {
        get active() {
            return required().length > 0;
        },
        publicConfig() {
            return { ageCheck, ageProvider: provider?.id || null, emailCheck: config.emailCheck };
        },
        missing,
        status,
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
            safetyStore.saveVerification(peerId, 'age', { method: 'confirm' }, now());
            return { ok: true };
        },

        async startAgeCheck(peerId) {
            if (!provider) return { error: 'Age provider not enabled', code: 400 };
            return { ok: true, provider: provider.id, ...(await provider.start({ peerId })) };
        },

        async finishAgeCheck(peerId, payload) {
            if (!provider) return { error: 'Age provider not enabled', code: 400 };
            const result = await provider.finish({ peerId, payload });
            if (!result?.over18) return { error: 'Age not confirmed', code: 403 };
            const subjectHash = result.subject ? safetyCrypto.hash('subject', result.subject) : null;
            if (subjectHash && safetyStore.isBanned('subject', subjectHash)) return { error: 'Banned', code: 403 };
            safetyStore.saveVerification(peerId, 'age', {
                method: `provider:${provider.id}`,
                expiresAt: now() + AGE_PROVIDER_VALIDITY_MS,
                subjectHash
            }, now());
            return { ok: true };
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
            await transport.send({ email, code }, log);
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
            else if (kind === 'email') safetyStore.addBan('email', createSafetyCrypto(loadSafetyKey(config, store)).hash('email', normalizeEmail(value)), reason, now());
            else if (kind === 'subject') safetyStore.addBan('subject', value, reason, now());
            else throw new Error(`Unknown ban kind ${kind}`);
        }
    };
}

export function registerSafetyRoutes(app, { safety, allowRequest, requirePeerAuth, isString }) {
    const send = (reply, result) => (result.error
        ? reply.code(result.code || 400).send({ error: result.error })
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
        return send(reply, await safety.startAgeCheck(peerId));
    });
    app.post('/api/safety/age/finish', async (request, reply) => {
        const peerId = authed(request, reply);
        if (!peerId) return reply;
        return send(reply, await safety.finishAgeCheck(peerId, request.body?.payload));
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

