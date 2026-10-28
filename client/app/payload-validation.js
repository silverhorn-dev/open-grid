// ================= P2P-EINGABEPRUEFUNG =================
// Jede entschluesselte P2P-Nachricht wird vor der Verarbeitung geprueft: bekannter Typ,
// erwartete Feldtypen, Grenzen fuer Laengen und Listen. Alles andere wird verworfen.
const MAX_SECURE_MESSAGE_LENGTH = 4 * 1024 * 1024;
const MAX_ID_LENGTH = 200;
const MAX_TEXT_LENGTH = 10000;
const MAX_INLINE_IMAGE_LENGTH = 3 * 1024 * 1024;
const MAX_AUDIO_LENGTH = 160000;
const MAX_PROFILE_FIELDS = 50;
const MAX_PROFILE_VALUE_LENGTH = 5000;
const MAX_SYNC_IDS = 50;
const CHAT_OPERATION_TYPES = [
    'MESSAGE_PUT', 'MESSAGE_DELETE', 'MESSAGE_REACT', 'CHAT_WIPE', 'PEER_UNHIDE',
    'MATCH_PING', 'MATCH_RESET', 'FRIEND_PING', 'FRIEND_RESET', 'SNAP_CONSUMED', 'SNAP_SAVED', 'ALBUM_KEYS', 'ALBUM_REVOKE',
    'STATUS_POST', 'STATUS_DELETE'
];

const isId = value => typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
const isOptionalString = (value, max) => value === undefined || value === null || (typeof value === 'string' && value.length <= max);
const isSmallInt = value => Number.isInteger(value) && value >= 0 && value <= 1e9;
const isTimestamp = value => value === undefined || (Number.isFinite(value) && value >= 0);
const isIdList = (value, max) => Array.isArray(value) && value.length <= max && value.every(isId);

function isValidMessage(message) {
    if (!message || typeof message !== 'object') return false;
    return isId(message.id) && isId(message.senderId)
        && isOptionalString(message.text, MAX_TEXT_LENGTH)
        && isOptionalString(message.snapData, MAX_INLINE_IMAGE_LENGTH)
        && isOptionalString(message.timestamp, 40)
        && (message.scope === undefined || ['discovery', 'social'].includes(message.scope))
        && (message.original === undefined || isValidOriginalMeta(message.original))
        && (message.snapExpiry === undefined || ['15m', '30m', '60m', 'off'].includes(message.snapExpiry))
        && (message.downloadable === undefined || ['friends', 'all', 'none'].includes(message.downloadable))
        // Sprachnachricht (voice.js): kleine Data-URL, Laenge in Sekunden, optional lokaler Text.
        && (message.audioData === undefined || (isOptionalString(message.audioData, MAX_AUDIO_LENGTH) && message.audioData.startsWith('data:audio/')))
        && (message.audioDuration === undefined || (Number.isFinite(message.audioDuration) && message.audioDuration >= 0 && message.audioDuration <= 3600))
        // Lange Sprachnachricht: ab audioSplitAt kommt der Rest als Original ueber P2P.
        && (message.audioSplitAt === undefined || (Number.isFinite(message.audioSplitAt) && message.audioSplitAt > 0
            && message.audioSplitAt <= (message.audioDuration || 0) && message.original !== undefined))
        && isOptionalString(message.transcript, 2000)
        // Video (video.js): nur Infos, das Video kommt als Original ueber P2P.
        && (message.video === undefined || (isPlainVideoInfo(message.video) && message.original !== undefined))
        && (message.imageSize === undefined || (Number.isInteger(message.imageSize?.w) && Number.isInteger(message.imageSize?.h)
            && message.imageSize.w > 0 && message.imageSize.h > 0 && message.imageSize.w <= 10000 && message.imageSize.h <= 10000))
        && isTimestamp(message.createdAt);
}

function isPlainVideoInfo(video) {
    return Boolean(video) && typeof video === 'object'
        && Number.isFinite(video.duration) && video.duration >= 0 && video.duration <= 3600
        && Number.isInteger(video.w) && Number.isInteger(video.h)
        && video.w > 0 && video.h > 0 && video.w <= 10000 && video.h <= 10000;
}

function isValidOriginalMeta(original) {
    const mime = String(original?.mime || '');
    const maxSize = mime.startsWith('video/') ? 36 * 1024 * 1024 : mime.startsWith('audio/') ? 6 * 1024 * 1024 : 15 * 1024 * 1024;
    return Boolean(original) && Number.isInteger(original.size) && original.size > 0 && original.size <= maxSize
        && typeof original.sha256 === 'string' && original.sha256.length <= 64 && isOptionalString(original.mime, 40);
}

function isValidChatOperation(operation) {
    if (!operation || typeof operation !== 'object') return false;
    if (!isId(operation.operationId) || !CHAT_OPERATION_TYPES.includes(operation.type)) return false;
    if (!isOptionalString(operation.actorId, MAX_ID_LENGTH) || !isTimestamp(operation.createdAt)) return false;
    if (operation.type === 'MESSAGE_PUT') return isId(operation.messageId) && isValidMessage(operation.message);
    if (['MESSAGE_DELETE', 'MESSAGE_REACT', 'SNAP_CONSUMED', 'SNAP_SAVED'].includes(operation.type)) return isId(operation.messageId);
    if (operation.type === 'STATUS_DELETE') return isId(operation.statusId);
    if (operation.type === 'STATUS_POST') return isId(operation.statusId) && ['text', 'photo'].includes(operation.kind)
        && isOptionalString(operation.text, 280) && isOptionalString(operation.color, 20)
        && isOptionalString(operation.image, 100000) && Number.isFinite(operation.expiresAt);
    if (operation.type === 'ALBUM_REVOKE') return isId(operation.albumId);
    if (operation.type === 'ALBUM_KEYS') return Array.isArray(operation.bundles) && operation.bundles.length <= 4
        && operation.bundles.every(bundle => bundle && (bundle.epochMs === undefined || (Number.isInteger(bundle.epochMs) && bundle.epochMs > 0)))
        && (operation.ticket === undefined || operation.ticket === null || isValidTicket(operation.ticket));
    return true;
}

function isValidProfileEnvelope(envelope) {
    if (!envelope || typeof envelope !== 'object') return false;
    // Signierter Umschlag oder (alt) direktes Profil.
    const profile = envelope.payload || envelope;
    if (!profile || typeof profile !== 'object') return false;
    const fields = profile.fields || {};
    if (typeof fields !== 'object' || Array.isArray(fields) || Object.keys(fields).length > MAX_PROFILE_FIELDS) return false;
    const fieldsOk = Object.values(fields).every(value => {
        if (Array.isArray(value)) return value.length <= 50 && value.every(entry => typeof entry === 'string' && entry.length <= MAX_PROFILE_VALUE_LENGTH);
        return ['string', 'number', 'boolean'].includes(typeof value) && String(value).length <= MAX_PROFILE_VALUE_LENGTH;
    });
    const galleryOk = profile.gallery === undefined
        || (Array.isArray(profile.gallery) && profile.gallery.length <= 100
            && profile.gallery.every(item => isId(item?.id) && isOptionalString(item.sha256, 64)));
    return fieldsOk && galleryOk && isOptionalString(profile.avatar, MAX_INLINE_IMAGE_LENGTH);
}

function isValidTicket(ticket) {
    const payload = ticket?.payload;
    return Boolean(payload) && typeof ticket.signature === 'string' && ticket.signature.length <= 200
        && Boolean(ticket.publicKey) && typeof ticket.publicKey === 'object'
        && isId(payload.albumId) && isId(payload.ownerId) && isId(payload.viewerId) && Number.isFinite(payload.expiresAt);
}

function isEncryptedImage(encrypted) {
    return Boolean(encrypted) && typeof encrypted.iv === 'string' && encrypted.iv.length <= 40
        && typeof encrypted.ciphertext === 'string' && encrypted.ciphertext.length <= MAX_INLINE_IMAGE_LENGTH * 2;
}

function isValidAlbumManifest(manifest) {
    const payload = manifest?.payload;
    return Boolean(payload) && typeof manifest.signature === 'string' && manifest.signature.length <= 200
        && Boolean(manifest.publicKey) && typeof manifest.publicKey === 'object'
        && isId(payload.id) && isId(payload.ownerId) && isOptionalString(payload.name, 200)
        && Array.isArray(payload.items) && payload.items.length <= 500;
}

const PAYLOAD_VALIDATORS = {
    CHAT_OPERATION: payload => isValidChatOperation(payload.operation),
    CHAT_OPERATION_ACK: payload => isId(payload.operationId),
    CHAT_FOCUS: payload => typeof payload.open === 'boolean',
    CHAT_SYNC_HELLO: payload => isIdList(payload.recentOperationIds || [], 20),
    CHAT_SYNC_INVENTORY_REQUEST: payload => payload.cursor === undefined || isSmallInt(payload.cursor),
    CHAT_SYNC_INVENTORY: payload => isIdList(payload.operationIds || [], MAX_SYNC_IDS)
        && (payload.nextCursor === undefined || payload.nextCursor === null || isSmallInt(payload.nextCursor)),
    CHAT_SYNC_OPERATION_REQUEST: payload => isIdList(payload.operationIds || [], MAX_SYNC_IDS),
    CHAT_SYNC_OPERATIONS: payload => Array.isArray(payload.operations) && payload.operations.length <= MAX_SYNC_IDS
        && payload.operations.every(isValidChatOperation),
    CHAT_MESSAGE: payload => isId(payload.id) && isOptionalString(payload.text, MAX_TEXT_LENGTH)
        && isOptionalString(payload.snapData, MAX_INLINE_IMAGE_LENGTH),
    PRESENCE_PING: payload => isId(payload.nonce),
    PRESENCE_PONG: payload => isId(payload.nonce),
    PROFILE_REQUEST: () => true,
    PROFILE_RESPONSE: payload => isValidProfileEnvelope(payload.signedEnvelope || payload.profile),
    SWARM_PROFILE_REQUEST: payload => isId(payload.targetNodeId),
    SWARM_PROFILE_RESPONSE: payload => isId(payload.targetNodeId) && isValidProfileEnvelope(payload.signedEnvelope),
    ALBUM_REQUEST: payload => isId(payload.albumId),
    ALBUM_RESPONSE: payload => isId(payload.album?.id) && isOptionalString(payload.album?.name, 200)
        && Array.isArray(payload.album?.items) && payload.album.items.length <= 500
        && (payload.manifest === undefined || payload.manifest === null || isValidAlbumManifest(payload.manifest)),
    SWARM_IMAGE_REQUEST: payload => isId(payload.ownerId) && isId(payload.imageId) && isSmallInt(payload.version),
    SWARM_IMAGE_RESPONSE: payload => isId(payload.ownerId) && isId(payload.imageId) && isSmallInt(payload.version)
        && typeof payload.data === 'string' && payload.data.length <= MAX_INLINE_IMAGE_LENGTH,
    SWARM_ALBUM_REQUEST: payload => isId(payload.ownerId) && isId(payload.albumId) && isValidTicket(payload.ticket),
    SWARM_ALBUM_RESPONSE: payload => isId(payload.ownerId) && isId(payload.albumId) && isValidAlbumManifest(payload.manifest),
    SWARM_ALBUM_IMAGE_REQUEST: payload => isId(payload.ownerId) && isId(payload.albumId) && isId(payload.imageId)
        && isSmallInt(payload.version) && isValidTicket(payload.ticket),
    SWARM_ALBUM_IMAGE_RESPONSE: payload => isId(payload.ownerId) && isId(payload.albumId) && isId(payload.imageId)
        && isSmallInt(payload.version) && isSmallInt(payload.keyVersion) && isEncryptedImage(payload.encrypted),
    ALBUM_DENIED: payload => isId(payload.albumId),
    ALBUM_REVOKED: payload => isId(payload.albumId),
    ALBUM_KEY_REQUEST: payload => isId(payload.albumId),
    SNAP_VIEW_REQUEST: payload => isId(payload.snapId),
    SNAP_VIEW_GRANT: payload => isId(payload.snapId) && isOptionalString(payload.key, 100),
    SNAP_VIEW_DENIED: payload => payload.snapId === null || isId(payload.snapId),
    SNAP_STREAM_START: payload => isId(payload.snapId) && isId(payload.streamId),
    SNAP_STREAM_PLAYING: payload => isId(payload.snapId),
    SNAP_STREAM_END: payload => isId(payload.snapId),
    SNAP_VIEW_CLOSED: payload => isId(payload.snapId),
    ORIGINAL_REQUEST: payload => isId(payload.messageId),
    ORIGINAL_CHUNK: payload => isId(payload.messageId) && isSmallInt(payload.index) && isSmallInt(payload.total)
        && payload.total <= 400 && typeof payload.data === 'string' && payload.data.length <= 64 * 1024,
    IMAGE_REQUEST: payload => isId(payload.imageId) && (payload.version === undefined || isSmallInt(payload.version)),
    IMAGE_RESPONSE: payload => isId(payload.imageId) && isSmallInt(payload.version)
        && (payload.encrypted ? isEncryptedImage(payload.encrypted) : isOptionalString(payload.data, MAX_INLINE_IMAGE_LENGTH))
};

function isValidSecurePayload(payload) {
    if (!payload || typeof payload !== 'object' || typeof payload.type !== 'string') return false;
    const validator = PAYLOAD_VALIDATORS[payload.type];
    if (!validator) return false;
    try {
        return validator(payload) === true;
    } catch {
        return false;
    }
}
