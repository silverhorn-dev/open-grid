// ================= FORWARD SECRECY (Board T36, P5) =================
// Ziel: wird ein Geraet spaeter kompromittiert, bleiben alte Nachrichten unlesbar.
// - P2P: je Verbindung ein Wegwerf-ECDH-Paar (signiert mit dem Identitaets-ECDSA-Schluessel im KEY_HELLO).
//   Sitzungsschluessel = HKDF(ECDH(Wegwerf, Wegwerf) || ECDH(Identitaet, Identitaet)); der private Wegwerf-
//   Schluessel wird nach der Ableitung verworfen, der Sitzungsschluessel lebt nur im Speicher.
// - Pfad C (1:1): der Absender nimmt je Nachricht ein Wegwerf-Paar und, wenn bekannt, den signierten "Prekey"
//   des Empfaengers (wechselt taeglich, der private Teil wird nach 7 Tagen geloescht).
//   Schluessel = HKDF(ECDH(Wegwerf, Prekey) || ECDH(Identitaet, Identitaet)).
// - Gruppen (Absender-Schluessel): Kette je Nachricht (HMAC-SHA-256), alte Glieder werden verworfen.
// Die statische Mischung (Identitaet x Identitaet) belegt weiter, wer gesendet hat.
const FS_SALT = 'opengrid-fs-v1';
const PREKEY_RECORD_ID = 'prekeys';
const PEER_PREKEY_PREFIX = 'peer-prekey:';
const PREKEY_ROTATE_MS = 24 * 60 * 60 * 1000;
const PREKEY_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
// Absender nehmen einen Prekey nur, solange er sicher noch beim Empfaenger liegt (Pfad-C-TTL 24 h passt dazu).
const PREKEY_USE_MS = 6 * 24 * 60 * 60 * 1000;
const GROUP_CHAIN_MAX_SKIP = 500;

const fsSubtle = () => window.crypto.subtle;
const fsText = text => new TextEncoder().encode(text);

function fsPublicJwk(key) {
    return { kty: 'EC', crv: 'P-256', x: key.x, y: key.y, ext: true };
}

async function fsEcdhBits(privateKey, publicKey) {
    const imported = await fsSubtle().importKey('jwk', fsPublicJwk(publicKey), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    return new Uint8Array(await fsSubtle().deriveBits({ name: 'ECDH', public: imported }, privateKey, 256));
}

async function fsAesKey(secrets, info, usages = ['encrypt', 'decrypt']) {
    const material = new Uint8Array(secrets.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of secrets) {
        material.set(part, offset);
        offset += part.length;
    }
    const base = await fsSubtle().importKey('raw', material, 'HKDF', false, ['deriveKey']);
    return fsSubtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: fsText(FS_SALT), info: fsText(info) }, base,
        { name: 'AES-GCM', length: 256 }, false, usages);
}

async function fsGenerateEphemeral() {
    // Privat nicht exportierbar; der oeffentliche Teil ist immer exportierbar.
    const keyPair = await fsSubtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const jwk = await fsSubtle().exportKey('jwk', keyPair.publicKey);
    return { privateKey: keyPair.privateKey, publicKey: { x: jwk.x, y: jwk.y } };
}

// ----- P2P: Wegwerf-Schluessel je Kanal -----
function ephemeralSignable(fromId, toId, key) {
    return { purpose: 'p2p-ephemeral', from: fromId, to: toId, x: key.x, y: key.y };
}

// Einmal je Kanal (Promise wird geteilt, auch wenn KEY_HELLO der Gegenseite zuerst ankommt).
function ensureChannelEphemeral(peerId, channel) {
    const current = state.channelEphemerals?.[peerId];
    if (current && current.channel === channel) return current.ready;
    const entry = { channel, ready: null, privateKey: null, publicKey: null, sig: null, peerKey: null };
    entry.ready = (async () => {
        // Prekey fehlt noch (z. B. frisch eingerichtet, die Rotation beim Start lief vor den Schluesseln).
        if (!state.ownPrekey) await rotatePrekeys().catch(() => null);
        const ephemeral = await fsGenerateEphemeral();
        entry.privateKey = ephemeral.privateKey;
        entry.publicKey = ephemeral.publicKey;
        entry.sig = await signOperation(ephemeralSignable(state.myProfile.id, peerId, ephemeral.publicKey), state.myKeys.ecdsaKeyPair.privateKey);
        return entry;
    })();
    state.channelEphemerals = { ...(state.channelEphemerals || {}), [peerId]: entry };
    return entry.ready;
}

function forgetChannelEphemeral(peerId) {
    if (state.channelEphemerals) delete state.channelEphemerals[peerId];
}

function channelEphemeralHello(peerId) {
    const entry = state.channelEphemerals?.[peerId];
    if (!entry?.publicKey || entry.channel !== state.dataChannels?.[peerId]) return null;
    return { x: entry.publicKey.x, y: entry.publicKey.y, sig: entry.sig };
}

// Sitzungsschluessel mit Forward Secrecy; null = Gegenseite bietet keinen (alte Version).
async function deriveForwardSecureSessionKey(peerId, peerStaticJwk, peerSigningKey, peerEphemeral) {
    if (!peerEphemeral?.x || !peerEphemeral?.y || typeof peerEphemeral.sig !== 'string') return null;
    const valid = await verifyOperationSignature({ ...ephemeralSignable(peerId, state.myProfile.id, peerEphemeral), sig: peerEphemeral.sig }, peerSigningKey);
    if (!valid) throw new Error('Invalid ephemeral key signature.');
    const entry = await ensureChannelEphemeral(peerId, state.dataChannels?.[peerId]);
    // Schon abgeleitet (KEY_HELLO wiederholt): gleicher Schluessel.
    if (entry.sessionKey && entry.peerKey?.x === peerEphemeral.x && entry.peerKey?.y === peerEphemeral.y) return entry.sessionKey;
    if (!entry.privateKey) throw new Error('Ephemeral key already used for another key.');
    const ephemeralSecret = await fsEcdhBits(entry.privateKey, peerEphemeral);
    const staticSecret = await fsEcdhBits(state.myKeys.keyPair.privateKey, peerStaticJwk);
    const ids = [state.myProfile.id, peerId].sort();
    const keys = [entry.publicKey.x, peerEphemeral.x].sort();
    entry.sessionKey = await fsAesKey([ephemeralSecret, staticSecret], `p2p|${ids.join('|')}|${keys.join('|')}`);
    entry.peerKey = { x: peerEphemeral.x, y: peerEphemeral.y };
    // Privaten Wegwerf-Schluessel verwerfen: ohne ihn laesst sich die Sitzung nicht mehr ableiten.
    entry.privateKey = null;
    return entry.sessionKey;
}

// ----- Prekeys (Pfad C) -----
function prekeySignable(prekey) {
    return { purpose: 'prekey', id: prekey.id, x: prekey.x, y: prekey.y, createdAt: prekey.createdAt };
}

async function loadPrekeys() {
    return await databaseRequest('keys', 'readonly', store => store.get(PREKEY_RECORD_ID)).catch(() => null)
        || { id: PREKEY_RECORD_ID, keys: [] };
}

// Neuen Prekey anlegen, wenn der aktuelle aelter als ein Tag ist; private Teile nach 7 Tagen loeschen.
async function rotatePrekeys(now = Date.now()) {
    if (!state.myKeys?.ecdsaKeyPair?.privateKey) return null;
    const record = await loadPrekeys();
    let keys = (record.keys || []).filter(entry => now - entry.createdAt < PREKEY_KEEP_MS);
    const newest = keys.reduce((latest, entry) => (!latest || entry.createdAt > latest.createdAt ? entry : latest), null);
    if (!newest || now - newest.createdAt >= PREKEY_ROTATE_MS) {
        const ephemeral = await fsGenerateEphemeral();
        const prekey = { id: window.crypto.randomUUID().replace(/-/g, '').slice(0, 16), x: ephemeral.publicKey.x, y: ephemeral.publicKey.y, createdAt: now };
        const sig = await signOperation(prekeySignable(prekey), state.myKeys.ecdsaKeyPair.privateKey);
        keys = [...keys, { ...prekey, sig, privateKey: ephemeral.privateKey }];
    }
    await putDatabaseRecord('keys', { id: PREKEY_RECORD_ID, keys });
    const current = keys.reduce((latest, entry) => (!latest || entry.createdAt > latest.createdAt ? entry : latest), null);
    state.ownPrekey = current ? { ...prekeySignable(current), sig: current.sig } : null;
    return state.ownPrekey;
}

function ownPrekeyHello() {
    const prekey = state.ownPrekey;
    return prekey ? { id: prekey.id, x: prekey.x, y: prekey.y, createdAt: prekey.createdAt, sig: prekey.sig } : null;
}

async function prekeyPrivateKey(prekeyId) {
    const record = await loadPrekeys();
    return (record.keys || []).find(entry => entry.id === prekeyId)?.privateKey || null;
}

// Prekey der Gegenseite pruefen und merken (nur neuere).
async function storePeerPrekey(peerId, prekey, peerSigningKey) {
    if (!prekey?.id || !prekey.x || !prekey.y || !Number.isFinite(prekey.createdAt) || typeof prekey.sig !== 'string') return false;
    if (prekey.createdAt > Date.now() + 5 * 60 * 1000) return false;
    if (!await verifyOperationSignature({ ...prekeySignable(prekey), sig: prekey.sig }, peerSigningKey)) return false;
    const known = await databaseRequest('keys', 'readonly', store => store.get(`${PEER_PREKEY_PREFIX}${peerId}`)).catch(() => null);
    if (known?.prekey && known.prekey.createdAt >= prekey.createdAt) return true;
    await putDatabaseRecord('keys', { id: `${PEER_PREKEY_PREFIX}${peerId}`, prekey: { ...prekeySignable(prekey), sig: prekey.sig } });
    return true;
}

// Hat die Gegenseite schon einmal Forward Secrecy angeboten? Dann kein Rueckfall auf rein statische Schluessel.
async function peerSupportsForwardSecrecy(peerId) {
    return Boolean((await databaseRequest('keys', 'readonly', store => store.get(`${PEER_PREKEY_PREFIX}${peerId}`)).catch(() => null))?.prekey);
}

function usablePrekey(prekey, now = Date.now()) {
    return Boolean(prekey) && now - prekey.createdAt < PREKEY_USE_MS;
}

async function peerPrekeyFor(peerId) {
    const record = await databaseRequest('keys', 'readonly', store => store.get(`${PEER_PREKEY_PREFIX}${peerId}`)).catch(() => null);
    return usablePrekey(record?.prekey) ? record.prekey : null;
}

// Pfad-C-Umschlag v3 (1:1). Liefert { envelope (ohne Chiffrat), key }.
async function sealPathCKey(recipientId, recipientStaticJwk) {
    const prekey = await peerPrekeyFor(recipientId);
    const ephemeral = await fsGenerateEphemeral();
    const ephemeralSecret = await fsEcdhBits(ephemeral.privateKey, prekey || recipientStaticJwk);
    const staticSecret = await fsEcdhBits(state.myKeys.keyPair.privateKey, recipientStaticJwk);
    const prekeyId = prekey?.id || null;
    const key = await fsAesKey([ephemeralSecret, staticSecret], `pathc|${state.myProfile.id}|${recipientId}|${prekeyId || 'static'}`, ['encrypt']);
    return { key, envelope: { version: 3, senderPublicKey: state.myKeys.jwkPublic, ephemeralKey: ephemeral.publicKey, prekeyId } };
}

async function openPathCKey(senderId, envelope) {
    const privateKey = envelope.prekeyId ? await prekeyPrivateKey(envelope.prekeyId) : state.myKeys.keyPair.privateKey;
    if (!privateKey) throw new Error('Prekey expired.');
    const ephemeralSecret = await fsEcdhBits(privateKey, envelope.ephemeralKey);
    const staticSecret = await fsEcdhBits(state.myKeys.keyPair.privateKey, envelope.senderPublicKey);
    return fsAesKey([ephemeralSecret, staticSecret], `pathc|${senderId}|${state.myProfile.id}|${envelope.prekeyId || 'static'}`, ['decrypt']);
}

// ----- Gruppen: Kette je Nachricht -----
async function hmacBytes(keyBytes, label) {
    const key = await fsSubtle().importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await fsSubtle().sign('HMAC', key, new Uint8Array([label])));
}

// Glied -> (Nachrichtenschluessel, naechstes Glied).
async function chainStep(chainKeyBase64) {
    const chainKey = base64ToBytes(chainKeyBase64);
    const [messageKey, nextKey] = await Promise.all([hmacBytes(chainKey, 1), hmacBytes(chainKey, 2)]);
    return { messageKey: bytesToBase64(messageKey), next: bytesToBase64(nextKey) };
}

// Empfaenger: Nachrichtenschluessel fuer Index n aus dem Kettenstand; liefert { messageKey, state } oder null.
// Uebersprungene Schluessel werden (begrenzt) aufgehoben, damit spaetere Nachrichten in anderer Reihenfolge passen.
async function chainMessageKey(chain, index) {
    if (!chain || !Number.isInteger(index) || index < 0) return null;
    const skipped = { ...(chain.skipped || {}) };
    if (index < chain.n) {
        const messageKey = skipped[index];
        if (!messageKey) return null;
        delete skipped[index];
        return { messageKey, state: { ...chain, skipped } };
    }
    if (index - chain.n > GROUP_CHAIN_MAX_SKIP) return null;
    let chainKey = chain.ck;
    for (let position = chain.n; position < index; position++) {
        const step = await chainStep(chainKey);
        skipped[position] = step.messageKey;
        chainKey = step.next;
    }
    const step = await chainStep(chainKey);
    // Nur die letzten Luecken behalten.
    const kept = Object.fromEntries(Object.entries(skipped).sort((a, b) => Number(a[0]) - Number(b[0])).slice(-GROUP_CHAIN_MAX_SKIP));
    return { messageKey: step.messageKey, state: { ck: step.next, n: index + 1, skipped: kept } };
}
