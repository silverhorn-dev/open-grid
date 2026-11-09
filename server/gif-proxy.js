// ================= GIF-PROXY (Board T34, Phase 3) =================
// Standardmaessig aus (GIF_PROXY=off): der Router ist kein Medienserver. Schaltet der Betreiber ihn an, laden
// die Clients Bibliotheks- und Link-GIFs ueber den Router; der fremde Server sieht dann nur den Router, nicht
// die IP der Nutzer. Anbieter-Medien (Klipy) laufen nie hierueber (dessen Regeln: direkt vom Client).
// Schutz gegen Missbrauch (SSRF, offene Bandbreite):
// - nur https mit Hostnamen (checkGifUrl), DNS-Aufloesung mit Sperre privater/lokaler Adressen; die Verbindung
//   geht an genau die gepruefte Adresse (kein DNS-Rebinding), Weiterleitungen hoechstens 3, jede neu geprueft,
// - nur Bilder (gif, webp, png, jpeg, avif) und Videos (mp4, webm), hoechstens GIF_MAX_MB, Zeitlimit,
// - keine Cookies, kein Referer; Abruf nur mit Tages-Token eines angemeldeten Peers (Bilder koennen keine
//   Kopfzeilen schicken, darum steht das Token in der URL; es verraet nichts ausser "dieser Peer, heute").
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { checkGifUrl, isProviderMediaUrl } from './gifs.js';

const MEDIA_TYPES = /^(image\/(gif|webp|png|jpeg|avif|apng)|video\/(mp4|webm))$/;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 10000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function parseGifProxy(value) {
    return ['1', 'true', 'on', 'yes'].includes(String(value ?? 'off').trim().toLowerCase());
}

export function parseGifMaxBytes(value) {
    const megabytes = Number(value);
    return Math.round((Number.isFinite(megabytes) && megabytes > 0 ? Math.min(megabytes, 50) : 8) * 1024 * 1024);
}

// Private, lokale und reservierte Netze (IPv4 und IPv6). IPv4-in-IPv6 prueft isPublicAddress selbst (BlockList
// wuerde ::ffff:0:0/96 sonst auf jede IPv4-Adresse anwenden).
const blocked = new BlockList();
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
    ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
    ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001::', 32], ['2001:db8::', 32],
    ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) blocked.addSubnet(network, prefix, 'ipv6');

export function isPublicAddress(address) {
    const family = isIP(address);
    if (!family) return false;
    if (family === 6) {
        // IPv4 in IPv6 (::ffff:a.b.c.d) nach der IPv4-Regel pruefen.
        const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
        if (mapped) return isPublicAddress(mapped[1]);
    }
    return !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

// Nur eine oeffentliche Adresse wird benutzt; ist eine der aufgeloesten privat, gilt der Host als gesperrt.
export async function resolvePublicAddress(host, lookup = dnsLookup) {
    const addresses = await lookup(host, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(entry => !isPublicAddress(entry.address))) return null;
    return addresses[0];
}

export function createProxyTokens({ secret = randomBytes(32), now = Date.now } = {}) {
    const sign = (peerId, day) => createHmac('sha256', secret).update(`${peerId}\n${day}`).digest('base64url').slice(0, 32);
    return {
        issue(peerId) {
            const day = Math.floor(now() / DAY_MS);
            return `${day}.${Buffer.from(peerId).toString('base64url')}.${sign(peerId, day)}`;
        },
        // Gueltig am Ausstellungstag und am Tag danach.
        verify(token) {
            const [dayText, peerText, signature] = String(token || '').split('.');
            const day = Number(dayText);
            const today = Math.floor(now() / DAY_MS);
            if (!Number.isInteger(day) || day < today - 1 || day > today || !peerText || !signature) return null;
            const peerId = Buffer.from(peerText, 'base64url').toString();
            const expected = Buffer.from(sign(peerId, day));
            const given = Buffer.from(signature);
            return expected.length === given.length && timingSafeEqual(expected, given) ? peerId : null;
        }
    };
}

// Ein Abruf an genau die gepruefte Adresse; liefert die Antwort (Stream) oder eine Weiterleitung.
function fetchOnce(url, address, signal) {
    return new Promise((resolve, reject) => {
        const target = new URL(url);
        const request = httpsRequest({
            host: target.hostname,
            servername: target.hostname,
            port: 443,
            path: `${target.pathname}${target.search}`,
            method: 'GET',
            headers: { 'User-Agent': 'OpenGrid-GIF-Proxy', Accept: 'image/*,video/mp4,video/webm' },
            lookup: (_host, _options, callback) => callback(null, address.address, address.family),
            signal
        }, resolve);
        request.on('error', reject);
        request.end();
    });
}

export async function proxyGif(url, { maxBytes, lookup = dnsLookup, fetch = fetchOnce } = {}) {
    let current = url;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
            const checked = checkGifUrl(current);
            if (!checked || isProviderMediaUrl(checked)) return { status: 400, error: 'URL not allowed' };
            const address = await resolvePublicAddress(new URL(checked).hostname, lookup).catch(() => null);
            if (!address) return { status: 400, error: 'Host not allowed' };
            const response = await fetch(checked, address, controller.signal);
            const location = response.headers?.location;
            if ([301, 302, 303, 307, 308].includes(response.statusCode) && location) {
                response.resume?.();
                current = new URL(location, checked).href;
                continue;
            }
            if (response.statusCode !== 200) {
                response.resume?.();
                return { status: 502, error: `Upstream ${response.statusCode}` };
            }
            const type = String(response.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
            if (!MEDIA_TYPES.test(type)) {
                response.resume?.();
                return { status: 415, error: 'Not an image or video' };
            }
            const length = Number(response.headers?.['content-length']);
            if (Number.isFinite(length) && length > maxBytes) {
                response.resume?.();
                return { status: 413, error: 'Too large' };
            }
            // Ohne (ehrliche) Laengenangabe: beim Lesen zaehlen und abbrechen.
            const chunks = [];
            let size = 0;
            for await (const chunk of response) {
                size += chunk.length;
                if (size > maxBytes) {
                    response.destroy?.();
                    return { status: 413, error: 'Too large' };
                }
                chunks.push(chunk);
            }
            return { status: 200, type, body: Buffer.concat(chunks) };
        }
        return { status: 508, error: 'Too many redirects' };
    } catch (error) {
        return { status: 502, error: controller.signal.aborted ? 'Timeout' : 'Fetch failed' };
    } finally {
        clearTimeout(timer);
    }
}

export function registerGifProxyRoutes(app, { settings, allowRequest, requirePeerAuth, isString, now = Date.now, log, lookup, fetch } = {}) {
    const tokens = createProxyTokens({ now });

    // Tages-Token fuer die Bild-URLs (angemeldeter Peer).
    app.get('/api/gif-proxy/token', async (request, reply) => {
        if (!settings().proxy) return reply.code(404).send({ error: 'GIF proxy is disabled' });
        const peerId = request.headers['x-peer-id'];
        if (!isString(peerId, 200)) return reply.code(400).send({ error: 'Missing peer id' });
        if (!allowRequest('gifs', peerId, reply)) return;
        if (!requirePeerAuth(request, reply, peerId)) return;
        return { token: tokens.issue(peerId) };
    });

    app.get('/api/gif-proxy', async (request, reply) => {
        if (!settings().proxy) return reply.code(404).send({ error: 'GIF proxy is disabled' });
        const peerId = tokens.verify(request.query?.t);
        if (!peerId) return reply.code(403).send({ error: 'Invalid token' });
        if (!allowRequest('gifProxy', peerId, reply)) return;
        const result = await proxyGif(String(request.query?.url || ''), { maxBytes: settings().maxBytes, lookup, fetch });
        if (result.status !== 200) {
            log?.debug?.(`GIF proxy refused: ${result.error}`);
            return reply.code(result.status).send({ error: result.error });
        }
        return reply
            .header('Content-Type', result.type)
            .header('Cache-Control', 'private, max-age=86400')
            .header('Content-Disposition', 'inline')
            .header('Cross-Origin-Resource-Policy', 'same-origin')
            .send(result.body);
    });
}
