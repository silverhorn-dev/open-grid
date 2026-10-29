// ================= "NUR ZEIGEN FUER ..." AM ROUTER =================
// Derselbe Code wie in client/app/audience.js (test/audience-parity.test.js prueft den Gleichlauf).
// Der Router wertet Regeln nie fuer Betrachter aus; er mischt nur die Mindestwerte des Betreibers
// (`AUDIENCE_MINIMUM`) in jeden Karten-Code, auch in Karten ohne eigene Regel. So kann auch eine
// veraenderte App des Besitzers den Mindestwert nicht entfernen.
const AUDIENCE_VERSION = 1;

const isFilterable = field => field?.type === 'number' || ['select', 'multiselect'].includes(field?.type);

export function audienceSchemaFingerprint(schema) {
    const text = (schema || []).map((field, index) => (
        isFilterable(field) ? `${index}:${field.key}:${field.type}:${(field.options || []).join(',')}` : ''
    )).join('|');
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return (hash ^ (hash >>> 8) ^ (hash >>> 16) ^ (hash >>> 24)) & 0xff;
}

function toCode(bytes) {
    return Buffer.from(bytes).toString('base64url');
}

export function decodeAudience(code, schema) {
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{2,64}$/.test(code)) return null;
    const bytes = [...Buffer.from(code, 'base64url')];
    if (bytes[0] !== AUDIENCE_VERSION || bytes[1] !== audienceSchemaFingerprint(schema)) return null;
    const entries = [];
    let position = 2;
    while (position < bytes.length) {
        const head = bytes[position];
        const index = head & 0x7f;
        if (head & 0x80) {
            if (position + 3 > bytes.length) return null;
            entries.push({ index, kind: 'range', min: bytes[position + 1], max: bytes[position + 2] });
            position += 3;
        } else {
            const length = bytes[position + 1];
            if (!(length >= 1 && length <= 4) || position + 2 + length > bytes.length) return null;
            let mask = 0;
            for (let byte = 0; byte < length; byte += 1) mask = (mask | (bytes[position + 2 + byte] << (8 * byte))) >>> 0;
            entries.push({ index, kind: 'mask', mask });
            position += 2 + length;
        }
    }
    return entries;
}

export function encodeEntries(entries, schema) {
    const bytes = [AUDIENCE_VERSION, audienceSchemaFingerprint(schema)];
    [...entries].sort((left, right) => left.index - right.index).forEach(entry => {
        if (entry.kind === 'range') {
            bytes.push(entry.index | 0x80, entry.min, entry.max);
            return;
        }
        if (!entry.mask) return;
        const length = entry.mask > 0xffffff ? 4 : entry.mask > 0xffff ? 3 : entry.mask > 0xff ? 2 : 1;
        bytes.push(entry.index, length);
        for (let byte = 0; byte < length; byte += 1) bytes.push((entry.mask >>> (8 * byte)) & 0xff);
    });
    return bytes.length > 2 ? toCode(bytes) : null;
}

// Regel { ranges: { key: { min, max } }, options: { key: [werte] } } -> Eintraege (nur feste Werte).
export function ruleToEntries(rule, schema) {
    const entries = [];
    (schema || []).forEach((field, index) => {
        if (index > 127 || !isFilterable(field)) return;
        if (field.type === 'number') {
            const range = rule?.ranges?.[field.key];
            if (!range || (!Number.isFinite(range.min) && !Number.isFinite(range.max))) return;
            const clamp = value => Math.max(0, Math.min(255, Math.round(value)));
            entries.push({ index, kind: 'range', min: clamp(Number.isFinite(range.min) ? range.min : 0), max: clamp(Number.isFinite(range.max) ? range.max : 255) });
            return;
        }
        const wanted = rule?.options?.[field.key];
        if (!Array.isArray(wanted) || !wanted.length) return;
        let mask = 0;
        (field.options || []).slice(0, 32).forEach((option, bit) => {
            if (wanted.includes(option)) mask = (mask | (1 << bit)) >>> 0;
        });
        if (mask) entries.push({ index, kind: 'mask', mask });
    });
    return entries;
}

export function encodeAudience(rule, schema) {
    return encodeEntries(ruleToEntries(rule, schema), schema);
}

// AUDIENCE_MINIMUM (JSON, wie eine Regel, nur feste Werte) gegen das Schema pruefen.
export function parseAudienceMinimum(value, schema) {
    if (!value) return null;
    let rule;
    try {
        rule = typeof value === 'string' ? JSON.parse(value) : value;
    } catch {
        throw new Error('AUDIENCE_MINIMUM must be JSON.');
    }
    const entries = ruleToEntries(rule, schema);
    return entries.length ? entries : null;
}

// Code des Besitzers (oder keiner) + Mindestwerte -> Code fuer die Karte. Bereiche werden enger
// (min = max(min), max = min(max)), Auswahlen geschnitten; fehlt ein Feld, gilt der Mindestwert.
// Ungueltiger oder fremder Code des Besitzers zaehlt wie keine Regel.
export function applyAudienceMinimum(code, minimum, schema) {
    if (!minimum) return code || null;
    const entries = decodeAudience(code, schema) || [];
    for (const required of minimum) {
        const existing = entries.find(entry => entry.index === required.index && entry.kind === required.kind);
        if (!existing) {
            entries.push({ ...required });
        } else if (required.kind === 'range') {
            existing.min = Math.max(existing.min, required.min);
            existing.max = Math.min(existing.max, required.max);
        } else {
            existing.mask = (existing.mask & required.mask) >>> 0 || required.mask;
        }
    }
    return encodeEntries(entries, schema);
}
