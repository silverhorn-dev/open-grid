import { timingSafeEqual } from 'node:crypto';

// ================= MEHRERE ROUTER (Federation) =================
// Ein Haupt-Router kennt die vom Admin freigegebenen weiteren Router (`FEDERATION_PEERS`, je mit eigenem
// Token) und die Regeln, welche Geohash-Zellen wohin gehoeren (`FEDERATION_RULES`). Weitere Router treten
// mit ihrem Token bei und melden sich alle 30 s erneut (Lebenszeichen). Die Clients bekommen Router und
// Regeln mit der Config und ordnen jede Zelle selbst zu (`routerForCell`); kein Router leitet Verkehr
// eines anderen weiter. Der Haupt-Router ruft selbst nie fremde Adressen auf.
//
// Regeln: das laengste passende Praefix gewinnt (so laesst sich eine volle Zelle teilen). Modus `single`:
// der erste erreichbare Router der Liste. Modus `share`: die Zellen unter dem Praefix gehen abwechselnd
// an die Router (Wert des naechsten Geohash-Zeichens modulo Anzahl, bei zwei Routern gerade/ungerade).
// Ist kein Router einer Regel erreichbar, gilt die naechstkuerzere Regel, am Ende der Haupt-Router.
export const GEOHASH_BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
export const FEDERATION_HEARTBEAT_MS = 30_000;
const ROUTER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const PREFIX_PATTERN = /^[0-9b-hjkmnp-z]{1,8}$/;
const MIN_TOKEN_LENGTH = 16;
const MAX_RULES = 500;

function parseJson(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    try {
        const parsed = JSON.parse(String(value));
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        throw new Error('Federation settings must be a JSON array.');
    }
}

export function parseFederationPeers(value) {
    return parseJson(value)
        .filter(peer => peer && ROUTER_ID_PATTERN.test(peer.id) && typeof peer.token === 'string' && peer.token.length >= MIN_TOKEN_LENGTH)
        .map(peer => ({ id: peer.id, token: peer.token }));
}

export function parseFederationRules(value) {
    return parseJson(value)
        .filter(rule => rule && PREFIX_PATTERN.test(rule.prefix) && Array.isArray(rule.routers)
            && rule.routers.length > 0 && rule.routers.length <= 16 && rule.routers.every(id => ROUTER_ID_PATTERN.test(id)))
        .slice(0, MAX_RULES)
        .map(rule => ({ prefix: rule.prefix, routers: [...new Set(rule.routers)], mode: rule.mode === 'share' ? 'share' : 'single' }));
}

// Router fuer eine Zelle. `isUp(id)` sagt, ob ein Router gerade erreichbar ist; `fallback` ist der
// Haupt-Router. Dieselbe Rechnung steht im Client (client/app/federation.js), test/federation.test.js
// prueft den Gleichlauf.
export function routerForCell(cell, rules, isUp = () => true, fallback = null) {
    const value = String(cell || '').toLowerCase();
    const matching = rules
        .filter(rule => value.startsWith(rule.prefix))
        .sort((left, right) => right.prefix.length - left.prefix.length);
    for (const rule of matching) {
        const available = rule.routers.filter(id => isUp(id));
        if (!available.length) continue;
        if (rule.mode !== 'share' || available.length === 1) return available[0];
        const next = value[rule.prefix.length] ?? value[value.length - 1] ?? '0';
        const index = Math.max(0, GEOHASH_BASE32.indexOf(next));
        return available[index % available.length];
    }
    return fallback;
}

function tokensMatch(expected, given) {
    const left = Buffer.from(String(expected));
    const right = Buffer.from(String(given || ''));
    return left.length === right.length && timingSafeEqual(left, right);
}

function isRouterUrl(value) {
    try {
        const url = new URL(String(value));
        return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password && !url.search && !url.hash;
    } catch {
        return false;
    }
}

// Haupt-Router: Beitritte annehmen und die Config fuer Clients bauen.
export function createFederation({ selfId = 'main', selfUrl = '', peers = [], rules = [], now = Date.now } = {}) {
    const joined = new Map();
    const isUp = id => id === selfId || (joined.has(id) && now() - joined.get(id).lastSeen <= FEDERATION_HEARTBEAT_MS * 3);

    return {
        enabled: peers.length > 0 || rules.length > 0,
        selfId,
        isUp,
        // Beitritt bzw. Lebenszeichen eines freigegebenen Routers. Ergebnis: Config oder Fehlergrund.
        join({ id, url, token } = {}) {
            const peer = peers.find(entry => entry.id === id);
            if (!peer || !tokensMatch(peer.token, token)) return { error: 'not-approved' };
            if (!isRouterUrl(url)) return { error: 'invalid-url' };
            joined.set(id, { url: String(url).replace(/\/+$/, ''), lastSeen: now() });
            return { config: this.clientConfig() };
        },
        routerForCell(cell) {
            return routerForCell(cell, rules, isUp, selfId);
        },
        // Fuer /api/config: erreichbare Router (der eigene mit leerer URL = gleiche Herkunft) und Regeln.
        clientConfig() {
            const routers = [{ id: selfId, url: selfUrl }];
            for (const [id, entry] of joined) {
                if (isUp(id)) routers.push({ id, url: entry.url });
            }
            return { main: selfId, routers, rules };
        }
    };
}

// Weiterer Router: beim Haupt-Router beitreten und alle 30 s erneut melden. Die erhaltene Config (Router
// und Regeln) gibt er an seine eigenen Clients weiter.
export function startFederationMember({ parentUrl, id, token, publicUrl, fetchImpl = fetch, log = () => {}, intervalMs = FEDERATION_HEARTBEAT_MS }) {
    const member = { config: null, timer: null };
    const join = async () => {
        try {
            const response = await fetchImpl(`${String(parentUrl).replace(/\/+$/, '')}/api/federation/join`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, url: publicUrl, token })
            });
            if (!response.ok) throw new Error(`join returned ${response.status}`);
            member.config = (await response.json()).config || null;
        } catch (error) {
            log(`Federation join failed: ${error.message}`);
        }
    };
    member.ready = join();
    member.timer = setInterval(join, intervalMs);
    member.timer.unref?.();
    member.stop = () => clearInterval(member.timer);
    return member;
}
