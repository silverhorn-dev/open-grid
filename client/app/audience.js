// ================= "NUR ZEIGEN FUER ..." (Sichtbarkeitsregel) =================
// Der Besitzer legt fest, wer seine Grid-Karte sehen soll (z. B. Position: Top, Bottom; Alter 21-35).
// Die Regel geht als kurzer Binaer-Code mit der Registrierung an den Router und kommt mit der Karte
// zurueck; die App des Betrachters vergleicht sie mit dem eigenen Profil und zeigt die Karte sonst nicht.
// Der Router erfaehrt nichts ueber Betrachter; die Regel selbst ist fuer jeden lesbar, der die Karte
// abruft, und ein veraenderter Client koennte sie ignorieren (Hinweis bei der Einstellung).
//
// Code (base64url): Byte 0 = Version, Byte 1 = Schema-Fingerabdruck (8 Bit ueber Schluessel, Typen und
// Optionen der filterbaren Felder), dann Eintraege:
//   Kopf = Feldnummer (Index im Profil-Schema, 0-127) | Art << 7  (Art 0 = Auswahl, 1 = Zahlenbereich)
//   Auswahl: Laenge L (1-4) + L Byte Bitmaske (Option n = Bit n, little endian)
//   Bereich: min + max (je 1 Byte, 0-255)
// Passt der Fingerabdruck nicht (Schema geaendert) oder ist der Code kaputt, wird die Regel ignoriert.
const AUDIENCE_VERSION = 1;
const AUDIENCE_RECORD_ID = 'audience-rule';
const AUDIENCE_MAX_CODE_LENGTH = 64;

function audienceSchemaFingerprint(schema = PROFILE_SCHEMA) {
    const text = (schema || []).map((field, index) => (
        field.type === 'number' || ['select', 'multiselect'].includes(field.type)
            ? `${index}:${field.key}:${field.type}:${(field.options || []).join(',')}` : ''
    )).join('|');
    // FNV-1a, auf 8 Bit gefaltet.
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return (hash ^ (hash >>> 8) ^ (hash >>> 16) ^ (hash >>> 24)) & 0xff;
}

function audienceBytesToCode(bytes) {
    let binary = '';
    bytes.forEach(byte => { binary += String.fromCharCode(byte); });
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function audienceCodeToBytes(code) {
    const base64 = code.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
    return Array.from(binary, character => character.charCodeAt(0));
}

// Regel { ranges: { key: { min, max } }, options: { key: [werte] } } -> Code oder null (keine Regel).
function encodeAudience(rule, schema = PROFILE_SCHEMA) {
    const bytes = [AUDIENCE_VERSION, audienceSchemaFingerprint(schema)];
    (schema || []).forEach((field, index) => {
        if (index > 127) return;
        if (field.type === 'number') {
            const range = rule?.ranges?.[field.key];
            if (!range || (!Number.isFinite(range.min) && !Number.isFinite(range.max))) return;
            const clamp = value => Math.max(0, Math.min(255, Math.round(value)));
            bytes.push(index | 0x80, clamp(Number.isFinite(range.min) ? range.min : 0), clamp(Number.isFinite(range.max) ? range.max : 255));
            return;
        }
        if (!['select', 'multiselect'].includes(field.type) || !Array.isArray(field.options)) return;
        const wanted = rule?.options?.[field.key];
        if (!Array.isArray(wanted) || !wanted.length) return;
        let mask = 0;
        field.options.slice(0, 32).forEach((option, bit) => {
            if (wanted.includes(option)) mask = (mask | (1 << bit)) >>> 0;
        });
        if (!mask) return;
        const length = mask > 0xffffff ? 4 : mask > 0xffff ? 3 : mask > 0xff ? 2 : 1;
        bytes.push(index, length);
        for (let byte = 0; byte < length; byte += 1) bytes.push((mask >>> (8 * byte)) & 0xff);
    });
    return bytes.length > 2 ? audienceBytesToCode(bytes) : null;
}

// Code -> [{ index, kind: 'mask', mask } | { index, kind: 'range', min, max }] oder null (ignorieren).
function decodeAudience(code, schema = PROFILE_SCHEMA) {
    if (typeof code !== 'string' || !code || code.length > AUDIENCE_MAX_CODE_LENGTH || !/^[A-Za-z0-9_-]+$/.test(code)) return null;
    let bytes;
    try {
        bytes = audienceCodeToBytes(code);
    } catch {
        return null;
    }
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
            // Kopf + Laenge + L Byte Maske muessen vollstaendig da sein.
            if (!(length >= 1 && length <= 4) || position + 2 + length > bytes.length) return null;
            let mask = 0;
            for (let byte = 0; byte < length; byte += 1) mask = (mask | (bytes[position + 2 + byte] << (8 * byte))) >>> 0;
            entries.push({ index, kind: 'mask', mask });
            position += 2 + length;
        }
    }
    return entries;
}

// Darf ich (eigene Felder) diese Karte sehen? Ohne gueltige Regel: ja. Fehlt mir ein Wert: nein.
function audienceAllows(code, fields = state.myProfile?.fields || {}, schema = PROFILE_SCHEMA) {
    const entries = decodeAudience(code, schema);
    if (!entries) return true;
    return entries.every(entry => {
        const field = schema[entry.index];
        if (!field) return true;
        const value = fields[field.key];
        if (entry.kind === 'range') {
            const number = Number(value);
            return value !== '' && value != null && Number.isFinite(number) && number >= entry.min && number <= entry.max;
        }
        const values = Array.isArray(value) ? value : value ? [value] : [];
        return values.some(item => {
            const bit = (field.options || []).indexOf(item);
            return bit >= 0 && bit < 32 && ((entry.mask >>> bit) & 1) === 1;
        });
    });
}

// ----- Eigene Regel (Einstellungen > Privatsphaere) -----
async function loadAudienceRule() {
    const stored = await databaseRequest('keys', 'readonly', store => store.get(AUDIENCE_RECORD_ID)).catch(() => null);
    state.audienceRule = {
        ranges: stored?.ranges && typeof stored.ranges === 'object' ? stored.ranges : {},
        options: stored?.options && typeof stored.options === 'object' ? stored.options : {}
    };
    renderAudienceSettings();
}

// Code fuer die Registrierung (nur in "Entdecken"; sonst keine Regel).
function myAudienceCode() {
    if (!state.audienceRule || isSocialMode()) return undefined;
    return encodeAudience(state.audienceRule) || undefined;
}

async function updateAudienceRule(change) {
    state.audienceRule = { ...state.audienceRule, ...change };
    await putDatabaseRecord('keys', { id: AUDIENCE_RECORD_ID, ...state.audienceRule })
        .catch(error => logDebug(`Could not store audience rule: ${error.message}`));
    renderAudienceSettings();
    // Neu registrieren, damit der Router die neue Regel an die Karte haengt.
    registerWithWorkerGrid().catch(logBackgroundError('updateAudienceRule'));
}

function renderAudienceSettings() {
    const container = document.getElementById('audience-fields');
    if (!container || !state.audienceRule) return;
    container.innerHTML = '';
    const rule = state.audienceRule;
    const fields = filterableFields();
    if (!fields.length) {
        const note = document.createElement('p');
        note.className = 'setting-desc';
        note.textContent = t('audience.noFields');
        container.appendChild(note);
        return;
    }
    fields.forEach(field => {
        const row = document.createElement('div');
        row.className = 'grid-filter-row';
        const label = document.createElement('span');
        label.className = 'grid-filter-label';
        label.textContent = localizedText(field.label);
        row.appendChild(label);
        if (field.type === 'number') {
            const range = rule.ranges[field.key] || {};
            const box = document.createElement('span');
            box.className = 'grid-filter-range';
            const number = (value, placeholder, key) => {
                const input = document.createElement('input');
                input.type = 'number';
                input.inputMode = 'numeric';
                input.className = 'setting-input w-16';
                input.placeholder = placeholder;
                input.dataset.audienceRange = `${field.key}:${key}`;
                if (Number.isFinite(value)) input.value = value;
                input.onchange = () => {
                    const parsed = input.value === '' ? null : Number(input.value);
                    const next = { ...(state.audienceRule.ranges[field.key] || {}), [key]: Number.isFinite(parsed) ? parsed : null };
                    updateAudienceRule({ ranges: { ...state.audienceRule.ranges, [field.key]: next } });
                };
                return input;
            };
            box.append(number(range.min, t('grid.filterFrom'), 'min'), document.createTextNode('–'), number(range.max, t('grid.filterTo'), 'max'));
            row.appendChild(box);
        } else {
            const chips = document.createElement('span');
            chips.className = 'grid-filter-chips';
            const selected = new Set(rule.options[field.key] || []);
            field.options.forEach(value => {
                const chip = document.createElement('button');
                chip.type = 'button';
                chip.className = `grid-filter-chip${selected.has(value) ? ' is-active' : ''}`;
                chip.textContent = localizedText(value);
                chip.dataset.audienceOption = `${field.key}:${value}`;
                chip.setAttribute('aria-pressed', String(selected.has(value)));
                chip.onclick = () => {
                    if (selected.has(value)) selected.delete(value);
                    else selected.add(value);
                    updateAudienceRule({ options: { ...state.audienceRule.options, [field.key]: [...selected] } });
                };
                chips.appendChild(chip);
            });
            row.appendChild(chips);
        }
        container.appendChild(row);
    });
    const summary = document.getElementById('audience-summary');
    if (summary) summary.textContent = encodeAudience(rule) ? t('audience.active') : t('audience.everyone');
}

async function resetAudienceRule() {
    await updateAudienceRule({ ranges: {}, options: {} });
}
