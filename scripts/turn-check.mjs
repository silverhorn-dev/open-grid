#!/usr/bin/env node
/**
 * Echter TURN-Allocate-Test gegen den konfigurierten coturn.
 *
 * Prueft fuer UDP und TCP getrennt:
 *   1. Erreichbarkeit des TURN-Listeners
 *   2. Gueltigkeit der per TURN-REST-API erzeugten Credentials
 *   3. Ob tatsaechlich eine Relay-Adresse zugeteilt wird
 *
 * Aufruf:
 *   node scripts/turn-check.mjs <host> [port] [secret]
 *
 * Secret kann auch aus der Umgebung kommen (TURN_SECRET).
 * Host faellt auf TURN_SERVER zurueck.
 */
import crypto from 'node:crypto';
import net from 'node:net';
import dgram from 'node:dgram';

const MAGIC = 0x2112a442;
const METHOD_ALLOCATE = 0x0003;
const ALLOCATE_SUCCESS = 0x0103;
const ATTR = {
    USERNAME: 0x0006,
    MESSAGE_INTEGRITY: 0x0008,
    ERROR_CODE: 0x0009,
    REALM: 0x0014,
    NONCE: 0x0015,
    XOR_RELAYED_ADDRESS: 0x0016,
    REQUESTED_TRANSPORT: 0x0019
};

function encodeAttribute(type, value) {
    const padded = Math.ceil(value.length / 4) * 4;
    const buffer = Buffer.alloc(4 + padded);
    buffer.writeUInt16BE(type, 0);
    buffer.writeUInt16BE(value.length, 2);
    value.copy(buffer, 4);
    return buffer;
}

function buildHeader(bodyLength, transactionId) {
    const header = Buffer.alloc(20);
    header.writeUInt16BE(METHOD_ALLOCATE, 0);
    header.writeUInt16BE(bodyLength, 2);
    header.writeUInt32BE(MAGIC, 4);
    transactionId.copy(header, 8);
    return header;
}

function buildAllocateRequest(transactionId, attributes, integrityKey) {
    let body = Buffer.concat(attributes);
    if (integrityKey) {
        // Die Laenge im Header muss das noch fehlende MESSAGE-INTEGRITY
        // Attribut (4 Byte Header + 20 Byte HMAC) bereits einschliessen.
        const signingHeader = buildHeader(body.length + 24, transactionId);
        const hmac = crypto
            .createHmac('sha1', integrityKey)
            .update(Buffer.concat([signingHeader, body]))
            .digest();
        body = Buffer.concat([body, encodeAttribute(ATTR.MESSAGE_INTEGRITY, hmac)]);
    }
    return Buffer.concat([buildHeader(body.length, transactionId), body]);
}

function parseStunMessage(buffer) {
    if (buffer.length < 20) return null;
    const type = buffer.readUInt16BE(0);
    const length = buffer.readUInt16BE(2);
    const attributes = {};
    let offset = 20;
    const end = Math.min(20 + length, buffer.length);
    while (offset + 4 <= end) {
        const attributeType = buffer.readUInt16BE(offset);
        const attributeLength = buffer.readUInt16BE(offset + 2);
        attributes[attributeType] = buffer.subarray(offset + 4, offset + 4 + attributeLength);
        offset += 4 + Math.ceil(attributeLength / 4) * 4;
    }
    return { type, attributes };
}

function decodeErrorCode(value) {
    if (!value || value.length < 4) return null;
    return { code: value[2] * 100 + value[3], reason: value.subarray(4).toString('utf8') };
}

function decodeXorRelayedAddress(value) {
    if (!value || value.length < 8) return null;
    const port = value.readUInt16BE(2) ^ (MAGIC >>> 16);
    if (value[1] !== 0x01) return { address: '(non-IPv4)', port };
    const magic = Buffer.alloc(4);
    magic.writeUInt32BE(MAGIC);
    const address = Array.from(value.subarray(4, 8), (byte, index) => byte ^ magic[index]).join('.');
    return { address, port };
}

function buildCredentials(secret) {
    const expiry = Math.floor(Date.now() / 1000) + 24 * 3600;
    const username = `${expiry}:turn-check`;
    const password = crypto.createHmac('sha1', secret).update(username).digest('base64');
    return { username, password };
}

function longTermKey(username, realm, password) {
    return crypto.createHash('md5').update(`${username}:${realm}:${password}`).digest();
}

/**
 * Sendet zwei Allocate-Requests: unauthentifiziert (-> 401 mit Challenge) und
 * danach signiert. Beide muessen ueber dieselbe Verbindung laufen, da coturn
 * die Nonce an das 5-Tupel bindet und sie sonst mit 438 verwirft.
 */
async function probe(transport, host, port, secret, timeoutMs = 6000) {
    const { username, password } = buildCredentials(secret);
    const transportAttr = Buffer.from([17, 0, 0, 0]); // 17 = UDP als Relay-Transport
    const connection = transport === 'tcp'
        ? createTcpTransport(host, port, timeoutMs)
        : createUdpTransport(host, port, timeoutMs);

    try {
        const challengeRaw = await connection.request(
            buildAllocateRequest(
                crypto.randomBytes(12),
                [encodeAttribute(ATTR.REQUESTED_TRANSPORT, transportAttr)],
                null
            )
        );
        const challenge = parseStunMessage(challengeRaw);
        if (!challenge) throw new Error('Keine gueltige STUN-Antwort erhalten.');

        const realmBuffer = challenge.attributes[ATTR.REALM];
        const nonceBuffer = challenge.attributes[ATTR.NONCE];
        if (!realmBuffer || !nonceBuffer) {
            const error = decodeErrorCode(challenge.attributes[ATTR.ERROR_CODE]);
            throw new Error(
                `Server lieferte keine realm/nonce Challenge${error ? ` (${error.code} ${error.reason})` : ''}.`
            );
        }
        const realm = realmBuffer.toString('utf8');
        const key = longTermKey(username, realm, password);

        const responseRaw = await connection.request(
            buildAllocateRequest(
                crypto.randomBytes(12),
                [
                    encodeAttribute(ATTR.REQUESTED_TRANSPORT, transportAttr),
                    encodeAttribute(ATTR.USERNAME, Buffer.from(username, 'utf8')),
                    encodeAttribute(ATTR.REALM, realmBuffer),
                    encodeAttribute(ATTR.NONCE, nonceBuffer)
                ],
                key
            )
        );
        const response = parseStunMessage(responseRaw);
        if (!response) throw new Error('Keine gueltige STUN-Antwort auf den Allocate-Request.');

        if (response.type === ALLOCATE_SUCCESS) {
            return { ok: true, realm, relay: decodeXorRelayedAddress(response.attributes[ATTR.XOR_RELAYED_ADDRESS]) };
        }
        return { ok: false, realm, error: decodeErrorCode(response.attributes[ATTR.ERROR_CODE]) };
    } finally {
        connection.close();
    }
}

/** Haelt eine TCP-Verbindung offen und entnimmt vollstaendige STUN-Nachrichten. */
function createTcpTransport(host, port, timeoutMs) {
    const socket = net.connect({ host, port });
    let buffer = Buffer.alloc(0);
    let pending = null;
    let failure = null;

    const fail = error => {
        failure = error;
        if (pending) {
            pending.reject(error);
            pending = null;
        }
    };

    const drain = () => {
        if (!pending || buffer.length < 20) return;
        const total = 20 + buffer.readUInt16BE(2);
        if (buffer.length < total) return;
        const message = buffer.subarray(0, total);
        buffer = buffer.subarray(total);
        pending.resolve(message);
        pending = null;
    };

    socket.setTimeout(timeoutMs, () => fail(new Error(`TCP-Timeout nach ${timeoutMs} ms`)));
    socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        drain();
    });
    socket.on('error', error => fail(error));
    socket.on('close', () => fail(new Error('Verbindung ohne Antwort geschlossen.')));

    return {
        request(payload) {
            if (failure) return Promise.reject(failure);
            return new Promise((resolve, reject) => {
                pending = { resolve, reject };
                socket.write(payload);
                drain();
            });
        },
        close() {
            socket.destroy();
        }
    };
}

/** Wiederverwendet denselben UDP-Socket, damit die Nonce gueltig bleibt. */
function createUdpTransport(host, port, timeoutMs) {
    const socket = dgram.createSocket('udp4');
    let pending = null;
    let failure = null;

    const fail = error => {
        failure = error;
        if (pending) {
            clearTimeout(pending.timer);
            pending.reject(error);
            pending = null;
        }
    };

    socket.on('message', message => {
        if (!pending) return;
        clearTimeout(pending.timer);
        pending.resolve(message);
        pending = null;
    });
    socket.on('error', error => fail(error));

    return {
        request(payload) {
            if (failure) return Promise.reject(failure);
            return new Promise((resolve, reject) => {
                const timer = setTimeout(
                    () => fail(new Error(`UDP-Timeout nach ${timeoutMs} ms (Pakete vermutlich blockiert)`)),
                    timeoutMs
                );
                pending = { resolve, reject, timer };
                socket.send(payload, port, host);
            });
        },
        close() {
            try {
                socket.close();
            } catch {
                // bereits geschlossen
            }
        }
    };
}

async function main() {
    const [hostArg, portArg, secretArg] = process.argv.slice(2);
    const host = hostArg || process.env.TURN_SERVER;
    const port = Number(portArg || process.env.TURN_PORT || 3478);
    const secret = secretArg || process.env.TURN_SECRET;

    if (!host || !secret) {
        console.error('Aufruf: node scripts/turn-check.mjs <host> [port] [secret]');
        console.error('Alternativ TURN_SERVER / TURN_PORT / TURN_SECRET als Umgebungsvariablen setzen.');
        process.exitCode = 2;
        return;
    }

    console.log(`TURN-Pruefung gegen ${host}:${port}\n`);
    let anySuccess = false;

    for (const transport of ['udp', 'tcp']) {
        process.stdout.write(`  ${transport.toUpperCase().padEnd(4)} `);
        try {
            const result = await probe(transport, host, port, secret);
            if (result.ok) {
                anySuccess = true;
                console.log(`OK  relay=${result.relay?.address}:${result.relay?.port} realm="${result.realm}"`);
            } else {
                console.log(
                    `FEHLER  ${result.error?.code ?? '?'} ${result.error?.reason ?? 'unbekannt'} (realm="${result.realm}")`
                );
            }
        } catch (error) {
            console.log(`NICHT ERREICHBAR  ${error.message}`);
        }
    }

    console.log('');
    if (anySuccess) {
        console.log('Mindestens ein Transport liefert ein Relay. TURN ist grundsaetzlich nutzbar.');
    } else {
        console.log('Kein Transport lieferte ein Relay.');
        console.log('  401/403 => TURN_SECRET passt nicht zum static-auth-secret des coturn.');
        console.log('  Timeout  => Listener/Firewall pruefen (coturn muss auch auf TCP lauschen).');
        process.exitCode = 1;
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
