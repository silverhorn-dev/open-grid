// ================= PROFILBILD-VERIFIZIERUNG: ROUTER (documentation/VERIFIZIERUNG.md, Board T37 V1) =================
// Nur fuer Dating. Der Client schickt je Schritt (geradeaus, Kopf links, Kopf rechts; zufaellige Reihenfolge) ein
// Selfie und dazu sein Profilbild in voller Groesse. Der Router prueft im Arbeitsspeicher (server/face-verify.js):
// genau ein Gesicht je Bild, passende Kopfhaltung (live, kein Foto vom Foto), dieselbe Person in allen Schritten und
// dieselbe Person wie auf dem Profilbild. Danach ist alles verworfen; gespeichert wird nur "verifiziert bis".
// Ergebnis: ein vom Router signierter Haken { subject, avatarSha256, issuedAt, expiresAt } (ECDSA P-256, Signatur wie
// signOperation im Client: kanonisches JSON, roh r||s, base64), den der Client im Dating-Profil mitschickt.
//
// Konfiguration (Betreiber):
//   VERIFY            on | off (Standard off)
//   VERIFY_THRESHOLD  Mindest-Aehnlichkeit Selfie <-> Profilbild (SFace-Kosinus, Standard 0.363)
//   VERIFY_DAYS       Gueltigkeit des Hakens in Tagen (Standard 90)
//   VERIFY_MODEL_DIR  Ordner mit face_detection_yunet_2023mar.onnx und face_recognition_sface_2021dec.onnx
//                     (Standard: data/verify-models, sonst models/verify im Image)
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { cosine, decodeJpeg, headYaw, poseMatches } from './face-verify.js';

export const VERIFY_STEPS = ['straight', 'left', 'right'];
export const VERIFY_SESSION_MS = 2 * 60 * 1000;
export const VERIFY_ATTEMPTS_PER_DAY = 5;
export const VERIFY_SAME_PERSON_STEPS = 0.3;
export const VERIFY_MIN_FACE_PX = 60;
const MAX_FRAME_LENGTH = 1_500_000;
const MAX_PROFILE_LENGTH = 3_000_000;
export const YUNET_FILE = 'face_detection_yunet_2023mar.onnx';
export const SFACE_FILE = 'face_recognition_sface_2021dec.onnx';

// Einzelwerte fuer das Admin-Panel (live-config.js): werfen bei ungueltigen Werten.
export function parseVerifyEnabled(value) {
    const text = String(value ?? 'off').trim().toLowerCase();
    if (!['on', 'off'].includes(text)) throw new Error('VERIFY must be on or off');
    return text === 'on';
}

export function parseVerifyThreshold(value) {
    const number = Number(value ?? 0.363);
    if (!Number.isFinite(number) || number <= 0 || number >= 1) throw new Error('VERIFY_THRESHOLD must be between 0 and 1');
    return number;
}

export function parseVerifyDays(value) {
    const number = Number(value ?? 90);
    if (!Number.isInteger(number) || number < 1 || number > 365) throw new Error('VERIFY_DAYS must be 1-365');
    return number;
}

export function parseVerifySettings(env = process.env) {
    const threshold = Number(env.VERIFY_THRESHOLD ?? 0.363);
    const days = Number(env.VERIFY_DAYS ?? 90);
    return {
        enabled: String(env.VERIFY || 'off').toLowerCase() === 'on',
        threshold: Number.isFinite(threshold) && threshold > 0 && threshold < 1 ? threshold : 0.363,
        days: Number.isFinite(days) && days >= 1 && days <= 365 ? Math.round(days) : 90
    };
}

export function findVerifyModels(directories) {
    for (const directory of directories.filter(Boolean)) {
        const yunetPath = join(directory, YUNET_FILE);
        const sfacePath = join(directory, SFACE_FILE);
        if (existsSync(yunetPath) && existsSync(sfacePath)) return { yunetPath, sfacePath };
    }
    return null;
}

// Gleiches kanonisches JSON wie client/crypto.client.js (sortierte Schluessel, ohne `sig`/`peerId` oben).
export function canonicalJson(value, top = true) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(entry => (entry === undefined ? 'null' : canonicalJson(entry, false))).join(',')}]`;
    const keys = Object.keys(value).filter(key => value[key] !== undefined && !(top && ['sig', 'peerId'].includes(key))).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key], false)}`).join(',')}}`;
}

// Eigener Router-Schluessel fuer Haken (einmal erzeugt, in der Datenbank).
export function loadBadgeKey(store) {
    const stored = JSON.parse(store.getOrCreateSetting('verify-badge-key', () => {
        const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
        return JSON.stringify({ privateJwk: privateKey.export({ format: 'jwk' }) });
    }));
    const privateKey = createPrivateKey({ key: stored.privateJwk, format: 'jwk' });
    const publicJwk = createPublicKey(privateKey).export({ format: 'jwk' });
    return { privateKey, publicKey: { x: publicJwk.x, y: publicJwk.y } };
}

export function signBadge(badge, privateKey) {
    return sign('sha256', Buffer.from(canonicalJson(badge)), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
}

const sha256Base64 = text => createHash('sha256').update(text).digest('base64');

function decodeDataUrl(value, maxLength) {
    if (typeof value !== 'string' || value.length > maxLength) return null;
    const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(value);
    if (!match) return null;
    try {
        return decodeJpeg(Buffer.from(match[1], 'base64'));
    } catch {
        return null;
    }
}

function shuffle(list) {
    const copy = [...list];
    for (let index = copy.length - 1; index > 0; index--) {
        const other = Math.floor(Math.random() * (index + 1));
        [copy[index], copy[other]] = [copy[other], copy[index]];
    }
    return copy;
}

// Pruefung einer Sitzung (rein bis auf die Modelle; models = { detect(image), embed(image, face) }).
// Liefert { ok: true } oder { ok: false, reason }.
export async function checkVerification({ steps, frames, profileImage, models, threshold }) {
    const profile = profileImage;
    if (!profile) return { ok: false, reason: 'profile-image' };
    const profileFaces = await models.detect(profile);
    if (profileFaces.length !== 1) return { ok: false, reason: 'profile-face' };
    const vectors = [];
    for (let index = 0; index < steps.length; index++) {
        const image = frames[index];
        if (!image) return { ok: false, reason: 'frame' };
        const faces = await models.detect(image);
        if (faces.length === 0) return { ok: false, reason: 'no-face', step: steps[index] };
        if (faces.length > 1) return { ok: false, reason: 'many-faces', step: steps[index] };
        const face = faces[0];
        if (Math.min(face.box[2], face.box[3]) < VERIFY_MIN_FACE_PX) return { ok: false, reason: 'too-far', step: steps[index] };
        if (!poseMatches(steps[index], headYaw(face.landmarks))) return { ok: false, reason: 'pose', step: steps[index] };
        vectors.push(await models.embed(image, face));
    }
    const straight = vectors[steps.indexOf('straight')];
    if (vectors.some(vector => cosine(vector, straight) < VERIFY_SAME_PERSON_STEPS)) return { ok: false, reason: 'not-same-person' };
    const similarity = cosine(straight, await models.embed(profile, profileFaces[0]));
    if (similarity < threshold) return { ok: false, reason: 'mismatch' };
    return { ok: true };
}

export function registerVerifyRoutes(app, { store, settings, requirePeerAuth, allowRequest, isString, now = Date.now, log, getModels, badgeKey }) {
    const sessions = new Map();
    const attempts = new Map();

    const available = () => settings().enabled && Boolean(getModels.available?.());

    app.post('/api/verify/start', async (request, reply) => {
        const { peerId } = request.body || {};
        if (!isString(peerId, 200)) return reply.code(400).send({ error: 'Invalid request' });
        if (!requirePeerAuth(request, reply, peerId)) return reply;
        if (!allowRequest('verify', peerId, reply)) return reply;
        if (!available()) return reply.code(404).send({ error: 'Verification is not enabled' });
        const at = now();
        const day = (attempts.get(peerId) || []).filter(time => at - time < 24 * 60 * 60 * 1000);
        if (day.length >= VERIFY_ATTEMPTS_PER_DAY) return reply.code(429).send({ error: 'Too many attempts today' });
        attempts.set(peerId, [...day, at]);
        for (const [id, session] of sessions) if (session.expiresAt < at) sessions.delete(id);
        const session = { id: randomUUID(), peerId, steps: shuffle(VERIFY_STEPS), expiresAt: at + VERIFY_SESSION_MS };
        sessions.set(session.id, session);
        return { sessionId: session.id, steps: session.steps, expiresAt: session.expiresAt };
    });

    app.post('/api/verify/finish', { bodyLimit: 8 * 1024 * 1024 }, async (request, reply) => {
        const { peerId, sessionId, frames, profileImage, avatarSha256 } = request.body || {};
        if (!isString(peerId, 200) || !isString(sessionId, 100) || !Array.isArray(frames) || !isString(avatarSha256, 100)) {
            return reply.code(400).send({ error: 'Invalid request' });
        }
        if (!requirePeerAuth(request, reply, peerId)) return reply;
        const session = sessions.get(sessionId);
        sessions.delete(sessionId);
        if (!session || session.peerId !== peerId || session.expiresAt < now()) return reply.code(410).send({ ok: false, reason: 'expired' });
        if (frames.length !== session.steps.length || typeof profileImage !== 'string') return reply.code(400).send({ error: 'Invalid request' });
        // Der Haken gehoert genau zu diesem Profilbild (SHA-256 wie avatarFull.sha256 im signierten Profil).
        if (sha256Base64(profileImage) !== avatarSha256) return reply.code(400).send({ ok: false, reason: 'profile-hash' });
        let result;
        try {
            const models = await getModels();
            result = await checkVerification({
                steps: session.steps,
                frames: frames.map(frame => decodeDataUrl(frame, MAX_FRAME_LENGTH)),
                profileImage: decodeDataUrl(profileImage, MAX_PROFILE_LENGTH),
                models,
                threshold: settings().threshold
            });
        } catch (error) {
            log.warn(`Verification failed to run: ${error.message}`);
            return reply.code(503).send({ ok: false, reason: 'unavailable' });
        }
        // Bilder und Merkmale verlassen die Funktion nicht; protokolliert wird nur das Ergebnis.
        log.info(`Profile verification: ${result.ok ? 'passed' : `rejected (${result.reason})`}.`);
        if (!result.ok) return { ok: false, reason: result.reason, step: result.step };
        const issuedAt = now();
        const badge = { subject: peerId, avatarSha256, issuedAt, expiresAt: issuedAt + settings().days * 24 * 60 * 60 * 1000 };
        store.setPeerVerified(peerId, badge.expiresAt);
        return { ok: true, badge, sig: signBadge(badge, badgeKey.privateKey) };
    });

    return { publicConfig: () => ({ enabled: available(), key: badgeKey.publicKey, steps: VERIFY_STEPS, days: settings().days }) };
}
