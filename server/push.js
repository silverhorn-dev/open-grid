import crypto from 'node:crypto';

// Push-Dienste muessen mindestens 4096 Byte Body annehmen. Abzueglich
// aes128gcm-Header (86 Byte), GCM-Tag und Delimiter bleibt Spielraum fuer
// einen Klartext dieser Groesse.
export const MAX_PUSH_PLAINTEXT_BYTES = 3800;
const RECORD_SIZE = 4096;

function base64UrlToBuffer(value) {
    return Buffer.from(value, 'base64url');
}

function rawPublicKey(publicKeyObject) {
    const jwk = publicKeyObject.export({ format: 'jwk' });
    return Buffer.concat([Buffer.from([0x04]), base64UrlToBuffer(jwk.x), base64UrlToBuffer(jwk.y)]);
}

function publicKeyFromRaw(raw) {
    if (raw.length !== 65 || raw[0] !== 0x04) throw new Error('Invalid P-256 public key.');
    return crypto.createPublicKey({
        key: {
            kty: 'EC',
            crv: 'P-256',
            x: raw.subarray(1, 33).toString('base64url'),
            y: raw.subarray(33, 65).toString('base64url')
        },
        format: 'jwk'
    });
}

export function generateVapidKeys() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    return {
        publicKey: rawPublicKey(publicKey).toString('base64url'),
        privateKey: privateKey.export({ format: 'jwk' }).d
    };
}

function vapidPrivateKeyObject(vapidKeys) {
    const raw = base64UrlToBuffer(vapidKeys.publicKey);
    return crypto.createPrivateKey({
        key: {
            kty: 'EC',
            crv: 'P-256',
            x: raw.subarray(1, 33).toString('base64url'),
            y: raw.subarray(33, 65).toString('base64url'),
            d: vapidKeys.privateKey
        },
        format: 'jwk'
    });
}

export function createVapidAuthorization(endpoint, vapidKeys, subject, now = Date.now()) {
    const header = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(now / 1000) + 12 * 60 * 60,
        sub: subject
    })).toString('base64url');
    const unsigned = `${header}.${claims}`;
    const signature = crypto.sign('sha256', Buffer.from(unsigned), {
        key: vapidPrivateKeyObject(vapidKeys),
        dsaEncoding: 'ieee-p1363'
    }).toString('base64url');
    return `vapid t=${unsigned}.${signature}, k=${vapidKeys.publicKey}`;
}

/**
 * Verschluesselt einen Push-Payload nach RFC 8291 (aes128gcm) fuer genau
 * eine Browser-Subscription. Der Push-Dienst sieht nur diesen Ciphertext.
 */
export function encryptPushPayload(subscription, plaintext, {
    salt = crypto.randomBytes(16),
    ephemeral = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
} = {}) {
    const userAgentPublic = base64UrlToBuffer(subscription.keys.p256dh);
    const authSecret = base64UrlToBuffer(subscription.keys.auth);
    const serverPublic = rawPublicKey(ephemeral.publicKey);
    const sharedSecret = crypto.diffieHellman({
        privateKey: ephemeral.privateKey,
        publicKey: publicKeyFromRaw(userAgentPublic)
    });

    const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), userAgentPublic, serverPublic]);
    const inputKey = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, authSecret, keyInfo, 32));
    const contentKey = Buffer.from(crypto.hkdfSync('sha256', inputKey, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(crypto.hkdfSync('sha256', inputKey, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

    const cipher = crypto.createCipheriv('aes-128-gcm', contentKey, nonce);
    const record = Buffer.concat([
        cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([0x02])])),
        cipher.final(),
        cipher.getAuthTag()
    ]);

    const header = Buffer.alloc(21);
    salt.copy(header, 0);
    header.writeUInt32BE(RECORD_SIZE, 16);
    header.writeUInt8(serverPublic.length, 20);
    return Buffer.concat([header, serverPublic, record]);
}

export function createPushSender({ vapidKeys, subject, fetchImpl = fetch, logger = null }) {
    return async function sendPush(subscription, payload) {
        const body = encryptPushPayload(subscription, JSON.stringify(payload));
        const response = await fetchImpl(subscription.endpoint, {
            method: 'POST',
            headers: {
                Authorization: createVapidAuthorization(subscription.endpoint, vapidKeys, subject),
                'Content-Encoding': 'aes128gcm',
                'Content-Type': 'application/octet-stream',
                TTL: String(24 * 60 * 60),
                Urgency: 'high'
            },
            body,
            signal: AbortSignal.timeout(10000)
        });
        if (!response.ok && logger) {
            logger.warn(`Web Push endpoint answered with status ${response.status}.`);
        }
        return { status: response.status, expired: response.status === 404 || response.status === 410 };
    };
}
