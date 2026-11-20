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
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { cosine, decodeJpeg, headYaw, poseMatches } from './face-verify.js';
import { packageRoot, packageVersion } from './nudity-model.js';

export const VERIFY_STEPS = ['straight', 'left', 'right'];
export const VERIFY_SESSION_MS = 3 * 60 * 1000;
export const VERIFY_MAX_FRAMES = 48;
export const VERIFY_MIN_FRAMES_PER_STEP = 2;
export const VERIFY_MIN_DURATION_MS = 1500;
export const VERIFY_IDLE_MS = 5 * 60 * 1000;
export const VERIFY_ATTEMPTS_PER_DAY = 5;
export const VERIFY_SAME_PERSON_STEPS = 0.3;
export const VERIFY_MIN_FACE_PX = 60;
const MAX_FRAME_LENGTH = 300_000;
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

// JPEG aus einer Data-URL (nur die Bytes; dekodiert wird erst im Worker).
function jpegBytes(value, maxLength) {
    if (typeof value !== 'string' || value.length > maxLength) return null;
    const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(value);
    return match ? Buffer.from(match[1], 'base64') : null;
}

function shuffle(list) {
    const copy = [...list];
    for (let index = copy.length - 1; index > 0; index--) {
        const other = Math.floor(Math.random() * (index + 1));
        [copy[index], copy[other]] = [copy[other], copy[index]];
    }
    return copy;
}

// ----- Bildfolge (Board T37, "Video"-Check) -----
// Der Client nimmt waehrend der Kopfbewegung eine Folge von Gesichtsausschnitten auf (je Bild der Schritt, in dem es
// entstand, und die Zeit). Der Router prueft ohne Modell, ob die Folge plausibel ist, und rechnet dann nur eine
// Stichprobe, die er selbst zufaellig waehlt: je Schritt ein Bild plus eins dazu. Wer faelschen will, weiss nicht,
// welche Bilder geprueft werden, und muesste alle faelschen.
export function checkSequence(frames, steps) {
    if (!Array.isArray(frames) || frames.length < steps.length * VERIFY_MIN_FRAMES_PER_STEP || frames.length > VERIFY_MAX_FRAMES) return 'sequence';
    let stepIndex = 0;
    const counts = new Map();
    for (let index = 0; index < frames.length; index++) {
        const frame = frames[index];
        const position = steps.indexOf(frame?.step);
        if (position < 0 || position < stepIndex || !Number.isFinite(frame.t)) return 'sequence';
        if (index > 0 && !(frame.t > frames[index - 1].t)) return 'sequence';
        stepIndex = position;
        counts.set(frame.step, (counts.get(frame.step) || 0) + 1);
    }
    if (steps.some(step => (counts.get(step) || 0) < VERIFY_MIN_FRAMES_PER_STEP)) return 'sequence';
    const duration = frames[frames.length - 1].t - frames[0].t;
    if (duration < VERIFY_MIN_DURATION_MS || duration > VERIFY_SESSION_MS) return 'sequence';
    return null;
}

export function pickFrames(frames, steps, random = Math.random) {
    const picks = steps.map(step => {
        const candidates = frames.map((frame, index) => (frame.step === step ? index : -1)).filter(index => index >= 0);
        return candidates[Math.floor(random() * candidates.length)];
    });
    const rest = frames.map((_, index) => index).filter(index => !picks.includes(index));
    if (rest.length) picks.push(rest[Math.floor(random() * rest.length)]);
    return picks.sort((a, b) => a - b);
}

// Pruefung (rein bis auf die Modelle; models = { detect(image), embed(image, face) }). picks = [{ image, step }].
// Liefert { ok: true } oder { ok: false, reason, step? }.
export async function checkVerification({ picks, profileImage, models, threshold }) {
    if (!profileImage) return { ok: false, reason: 'profile-image' };
    const profileFaces = await models.detect(profileImage);
    if (profileFaces.length !== 1) return { ok: false, reason: 'profile-face' };
    const vectors = [];
    let straight = null;
    for (const { image, step } of picks) {
        if (!image) return { ok: false, reason: 'frame' };
        const faces = await models.detect(image);
        if (faces.length === 0) return { ok: false, reason: 'no-face', step };
        if (faces.length > 1) return { ok: false, reason: 'many-faces', step };
        const face = faces[0];
        if (Math.min(face.box[2], face.box[3]) < VERIFY_MIN_FACE_PX) return { ok: false, reason: 'too-far', step };
        if (!poseMatches(step, headYaw(face.landmarks))) return { ok: false, reason: 'pose', step };
        const vector = await models.embed(image, face);
        vectors.push(vector);
        if (step === 'straight' && !straight) straight = vector;
    }
    if (!straight) return { ok: false, reason: 'frame' };
    if (vectors.some(vector => cosine(vector, straight) < VERIFY_SAME_PERSON_STEPS)) return { ok: false, reason: 'not-same-person' };
    const similarity = cosine(straight, await models.embed(profileImage, profileFaces[0]));
    if (similarity < threshold) return { ok: false, reason: 'mismatch' };
    return { ok: true };
}

// Auftrag mit rohen JPEGs pruefen: im Prozess (Tests, Ersatz-Modelle) oder im Worker (verify-worker.js).
export async function runCheckJob(job, models) {
    const decode = bytes => {
        try {
            return bytes ? decodeJpeg(Buffer.from(bytes)) : null;
        } catch {
            return null;
        }
    };
    return checkVerification({
        picks: job.picks.map(pick => ({ image: decode(pick.jpeg), step: pick.step })),
        profileImage: decode(job.profile),
        models,
        threshold: job.threshold
    });
}

export function inProcessRunner(models) {
    return { run: job => runCheckJob(job, models), close: async () => {} };
}

// Eigener Worker-Thread: der Router bleibt waehrend der Rechnung ansprechbar. Ein Auftrag nach dem anderen; nach
// VERIFY_IDLE_MS ohne Auftrag wird der Worker beendet und gibt Modelle und Speicher frei.
export function createVerifyRunner({ yunetPath, sfacePath, idleMs = VERIFY_IDLE_MS, log }) {
    let worker = null;
    let idleTimer = null;
    let queue = Promise.resolve();
    let nextId = 0;
    const pending = new Map();
    const stop = () => {
        clearTimeout(idleTimer);
        idleTimer = null;
        const current = worker;
        worker = null;
        if (current) current.terminate().catch(() => {});
    };
    const ensureWorker = () => {
        if (worker) return worker;
        worker = new Worker(new URL('./verify-worker.js', import.meta.url), { workerData: { yunetPath, sfacePath } });
        worker.on('message', ({ id, result, error }) => {
            const entry = pending.get(id);
            pending.delete(id);
            if (!entry) return;
            if (error) entry.reject(new Error(error));
            else entry.resolve(result);
        });
        const failAll = error => {
            for (const entry of pending.values()) entry.reject(error);
            pending.clear();
            worker = null;
        };
        worker.on('error', error => {
            log?.warn(`Verification worker failed: ${error.message}`);
            failAll(error);
        });
        worker.on('exit', code => {
            if (pending.size) failAll(new Error(`Verification worker exited (${code})`));
        });
        worker.unref();
        return worker;
    };
    const runNow = job => new Promise((resolve, reject) => {
        clearTimeout(idleTimer);
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        ensureWorker().postMessage({ id, job });
    }).finally(() => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(stop, idleMs);
        idleTimer.unref?.();
    });
    return {
        run(job) {
            const result = queue.then(() => runNow(job));
            queue = result.catch(() => {});
            return result;
        },
        close: async () => stop(),
        get active() {
            return Boolean(worker);
        }
    };
}

// Gesichtserkennung fuer die Live-Anleitung im Browser: YuNet + onnxruntime-web (WASM) vom eigenen Router.
// Nur Komfort; entschieden wird beim Router.
export async function registerDetectorAssets(app, yunetPath) {
    const require = createRequire(import.meta.url);
    const ortRoot = packageRoot(require, 'onnxruntime-web');
    if (!ortRoot || !yunetPath) return null;
    const base = `/vendor/verify/${await packageVersion(ortRoot)}/`;
    const files = {
        'ort.wasm.min.js': 'text/javascript; charset=utf-8',
        'ort-wasm-simd-threaded.mjs': 'text/javascript; charset=utf-8',
        'ort-wasm-simd-threaded.wasm': 'application/wasm'
    };
    for (const [file, type] of Object.entries(files)) {
        app.get(`${base}${file}`, async (_request, reply) => {
            reply.header('cache-control', 'public, max-age=31536000, immutable').type(type);
            return readFile(join(ortRoot, 'dist', file));
        });
    }
    app.get(`${base}${YUNET_FILE}`, async (_request, reply) => {
        reply.header('cache-control', 'public, max-age=31536000, immutable').type('application/octet-stream');
        return readFile(yunetPath);
    });
    return { library: `${base}ort.wasm.min.js`, runtimeUrl: base, modelUrl: `${base}${YUNET_FILE}` };
}

export function registerVerifyRoutes(app, { store, settings, requirePeerAuth, allowRequest, isString, now = Date.now, log, runner, detector = null, badgeKey, random = Math.random }) {
    const sessions = new Map();
    const attempts = new Map();

    const available = () => settings().enabled && Boolean(runner());

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
        // Geradeaus zuerst (Bezugsbild), danach links/rechts in zufaelliger Reihenfolge.
        const session = { id: randomUUID(), peerId, steps: ['straight', ...shuffle(['left', 'right'])], expiresAt: at + VERIFY_SESSION_MS };
        sessions.set(session.id, session);
        return { sessionId: session.id, steps: session.steps, expiresAt: session.expiresAt, maxFrames: VERIFY_MAX_FRAMES };
    });

    app.post('/api/verify/finish', { bodyLimit: 16 * 1024 * 1024 }, async (request, reply) => {
        const { peerId, sessionId, frames, profileImage, avatarSha256 } = request.body || {};
        if (!isString(peerId, 200) || !isString(sessionId, 100) || !Array.isArray(frames) || !isString(avatarSha256, 100)) {
            return reply.code(400).send({ error: 'Invalid request' });
        }
        if (!requirePeerAuth(request, reply, peerId)) return reply;
        const session = sessions.get(sessionId);
        sessions.delete(sessionId);
        if (!session || session.peerId !== peerId || session.expiresAt < now()) return reply.code(410).send({ ok: false, reason: 'expired' });
        if (typeof profileImage !== 'string' || profileImage.length > MAX_PROFILE_LENGTH) return reply.code(400).send({ error: 'Invalid request' });
        // Der Haken gehoert genau zu diesem Profilbild (SHA-256 wie avatarFull.sha256 im signierten Profil).
        if (sha256Base64(profileImage) !== avatarSha256) return reply.code(400).send({ ok: false, reason: 'profile-hash' });
        // Plausibel ohne Modell (Reihenfolge, Anzahl, Zeiten), dann Stichprobe.
        const sequenceProblem = checkSequence(frames, session.steps);
        if (sequenceProblem) {
            log.info(`Profile verification: rejected (${sequenceProblem}).`);
            return { ok: false, reason: sequenceProblem };
        }
        const picks = pickFrames(frames, session.steps, random).map(index => ({ jpeg: jpegBytes(frames[index].data, MAX_FRAME_LENGTH), step: frames[index].step }));
        let result;
        try {
            result = await runner().run({ picks, profile: jpegBytes(profileImage, MAX_PROFILE_LENGTH), threshold: settings().threshold });
        } catch (error) {
            log.warn(`Verification failed to run: ${error.message}`);
            return reply.code(503).send({ ok: false, reason: 'unavailable' });
        }
        // Bilder und Merkmale verlassen den Worker nicht; protokolliert wird nur das Ergebnis.
        log.info(`Profile verification: ${result.ok ? 'passed' : `rejected (${result.reason})`}.`);
        if (!result.ok) return { ok: false, reason: result.reason, step: result.step };
        const issuedAt = now();
        const badge = { subject: peerId, avatarSha256, issuedAt, expiresAt: issuedAt + settings().days * 24 * 60 * 60 * 1000 };
        store.setPeerVerified(peerId, badge.expiresAt);
        return { ok: true, badge, sig: signBadge(badge, badgeKey.privateKey) };
    });

    return {
        publicConfig: () => ({ enabled: available(), key: badgeKey.publicKey, steps: VERIFY_STEPS, days: settings().days, ...(available() && detector ? { detector } : {}) })
    };
}
