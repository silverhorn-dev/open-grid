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

// Die Regel gehoert zu "Entdecken" (im Event-Modus zum Event-Schema), nicht zum gerade aktiven Modus:
// im Chat-/Freunde-Modus hat das aktive Schema meist weder Alter noch Auswahlfelder.
function audienceSchema() {
    const schemas = typeof PROFILE_SCHEMAS === 'object' && PROFILE_SCHEMAS ? PROFILE_SCHEMAS : {};
    return (state?.appMode === 'event' && schemas.event) || schemas.discovery || PROFILE_SCHEMA;
}

function audienceSchemaFingerprint(schema = audienceSchema()) {
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
function encodeAudience(rule, schema = audienceSchema()) {
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
function decodeAudience(code, schema = audienceSchema()) {
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
function audienceAllows(code, fields = state.myProfile?.fields || {}, schema = audienceSchema()) {
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

// ----- Relative Regeln -----
// Zahl: { relative: 'same' } = eigener Wert +-3, 'older' = ab eigenem Wert, 'younger' = bis eigenem Wert.
// Auswahl: 'same' = die eigenen Werte. Aufgeloest wird bei jeder Registrierung mit dem aktuellen Profil;
// fehlt der eigene Wert, entfaellt dieser Teil der Regel.
const AUDIENCE_SAME_TOLERANCE = 3;
const AUDIENCE_RELATIVE_MODES = ['same', 'older', 'younger'];

function resolveAudienceRule(rule, fields = state.myProfile?.fields || {}, schema = audienceSchema()) {
    const resolved = { ranges: {}, options: {} };
    (schema || []).forEach(field => {
        const range = rule?.ranges?.[field.key];
        if (field.type === 'number' && range) {
            if (AUDIENCE_RELATIVE_MODES.includes(range.relative)) {
                const mine = Number(fields[field.key]);
                if (fields[field.key] === '' || fields[field.key] == null || !Number.isFinite(mine)) return;
                resolved.ranges[field.key] = range.relative === 'same'
                    ? { min: mine - AUDIENCE_SAME_TOLERANCE, max: mine + AUDIENCE_SAME_TOLERANCE }
                    : range.relative === 'older' ? { min: mine, max: null } : { min: null, max: mine };
            } else {
                resolved.ranges[field.key] = range;
            }
        }
        const option = rule?.options?.[field.key];
        if (['select', 'multiselect'].includes(field.type) && option) {
            if (option === 'same') {
                const mine = Array.isArray(fields[field.key]) ? fields[field.key] : fields[field.key] ? [fields[field.key]] : [];
                if (mine.length) resolved.options[field.key] = mine;
            } else if (Array.isArray(option)) {
                resolved.options[field.key] = option;
            }
        }
    });
    return resolved;
}

// ----- Eigene Regel (Einstellungen > Privatsphaere) -----
// Ohne eigene Wahl gilt die Startregel des Betreibers (`CLIENT_DEFAULTS.audience`).
async function loadAudienceRule() {
    const stored = await databaseRequest('keys', 'readonly', store => store.get(AUDIENCE_RECORD_ID)).catch(() => null);
    const source = stored || clientDefault('audience', null) || {};
    state.audienceRule = {
        ranges: source.ranges && typeof source.ranges === 'object' ? source.ranges : {},
        options: source.options && typeof source.options === 'object' ? source.options : {}
    };
    renderAudienceSettings();
}

// Code fuer die Registrierung (nur in "Entdecken"; sonst keine Regel). Mindestwerte des Betreibers
// mischt der Router selbst hinein.
function myAudienceCode() {
    if (!state.audienceRule || isSocialMode()) return undefined;
    return encodeAudience(resolveAudienceRule(state.audienceRule)) || undefined;
}

async function updateAudienceRule(change) {
    state.audienceRule = { ...state.audienceRule, ...change };
    await putDatabaseRecord('keys', { id: AUDIENCE_RECORD_ID, ...state.audienceRule })
        .catch(error => logDebug(`Could not store audience rule: ${error.message}`));
    renderAudienceSettings();
    // Neu registrieren, damit der Router die neue Regel an die Karte haengt.
    registerWithWorkerGrid().catch(logBackgroundError('updateAudienceRule'));
}

// Felder fuer die Regel: das Alter und alle Auswahlfelder (Einfach- und Mehrfachauswahl).
function audienceFields(schema = audienceSchema()) {
    return (schema || []).filter(field => (field.type === 'number' && field.key === 'age')
        || (['select', 'multiselect'].includes(field.type) && Array.isArray(field.options) && field.options.length));
}

// Ein Feld: Titel oben, darunter die Auswahl (Chips umbrechen statt sich zu quetschen).
function createAudienceField(field, rule) {
    const box = document.createElement('div');
    box.className = 'audience-field';
    const title = document.createElement('span');
    title.className = 'audience-field-title';
    title.textContent = localizedText(field.label);
    box.appendChild(title);
    const controls = document.createElement('div');
    controls.className = 'audience-field-controls';
    box.appendChild(controls);

    if (field.type === 'number') {
        const range = rule.ranges[field.key] || {};
        const current = range.relative || (range.open || Number.isFinite(range.min) || Number.isFinite(range.max) ? 'range' : '');
        const mode = document.createElement('select');
        mode.className = 'setting-select';
        mode.dataset.audienceMode = field.key;
        [['', t('audience.anyValue')], ['same', t('audience.sameAsMe')], ['older', t('audience.olderThanMe')], ['younger', t('audience.youngerThanMe')], ['range', t('audience.range')]]
            .forEach(([value, text]) => {
                const option = document.createElement('option');
                option.value = value;
                option.textContent = text;
                option.selected = current === value;
                mode.appendChild(option);
            });
        mode.onchange = () => {
            const ranges = { ...state.audienceRule.ranges };
            if (mode.value === 'range') ranges[field.key] = { min: null, max: null, open: true };
            else if (mode.value) ranges[field.key] = { relative: mode.value };
            else delete ranges[field.key];
            updateAudienceRule({ ranges });
        };
        controls.appendChild(mode);
        if (current === 'range') {
            const number = (value, placeholder, key) => {
                const input = document.createElement('input');
                input.type = 'number';
                input.inputMode = 'numeric';
                input.className = 'setting-input w-20';
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
            const span = document.createElement('span');
            span.className = 'grid-filter-range';
            span.append(number(range.min, t('grid.filterFrom'), 'min'), document.createTextNode('–'), number(range.max, t('grid.filterTo'), 'max'));
            controls.appendChild(span);
        }
        return box;
    }

    const same = rule.options[field.key] === 'same';
    const selected = new Set(Array.isArray(rule.options[field.key]) ? rule.options[field.key] : []);
    const chips = document.createElement('div');
    chips.className = 'grid-filter-chips';
    const chip = (text, active, key, onClick, extraClass = '') => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `grid-filter-chip${active ? ' is-active' : ''}${extraClass}`;
        button.textContent = text;
        button.dataset.audienceOption = key;
        button.setAttribute('aria-pressed', String(active));
        button.onclick = onClick;
        return button;
    };
    // "Wie ich": dieselben Werte wie im eigenen Profil (ersetzt die einzelnen Chips).
    chips.appendChild(chip(t('audience.sameAsMe'), same, `${field.key}:__same`, () => {
        const options = { ...state.audienceRule.options };
        if (same) delete options[field.key];
        else options[field.key] = 'same';
        updateAudienceRule({ options });
    }, ' is-same'));
    field.options.forEach(value => {
        chips.appendChild(chip(localizedText(value), !same && selected.has(value), `${field.key}:${value}`, () => {
            const next = new Set(same ? [] : selected);
            if (next.has(value)) next.delete(value);
            else next.add(value);
            updateAudienceRule({ options: { ...state.audienceRule.options, [field.key]: [...next] } });
        }, same ? ' is-muted' : ''));
    });
    controls.appendChild(chips);
    return box;
}

function renderAudienceSettings() {
    const container = document.getElementById('audience-fields');
    if (!container || !state.audienceRule) return;
    container.innerHTML = '';
    const fields = audienceFields();
    if (!fields.length) {
        const note = document.createElement('p');
        note.className = 'setting-desc';
        note.textContent = t('audience.noFields');
        container.appendChild(note);
    } else {
        fields.forEach(field => container.appendChild(createAudienceField(field, state.audienceRule)));
    }
    const summary = document.getElementById('audience-summary');
    if (summary) {
        const active = Boolean(encodeAudience(resolveAudienceRule(state.audienceRule)));
        summary.textContent = active ? t('audience.active') : t('audience.everyone');
        summary.classList.toggle('is-active', active);
    }
    renderAudienceMinimum();
}

// Vom Betreiber vorgegebene Mindestwerte (der Router setzt sie in jede Karte, auch ohne eigene Regel).
function renderAudienceMinimum() {
    const note = document.getElementById('audience-minimum');
    if (!note) return;
    const minimum = state.appConfig?.audienceMinimum;
    const parts = [];
    (audienceSchema() || []).forEach(field => {
        const range = minimum?.ranges?.[field.key];
        if (field.type === 'number' && range) {
            const text = Number.isFinite(range.min) && Number.isFinite(range.max) ? `${range.min}-${range.max}`
                : Number.isFinite(range.min) ? t('audience.atLeast', { value: range.min }) : Number.isFinite(range.max) ? t('audience.atMost', { value: range.max }) : '';
            if (text) parts.push(`${localizedText(field.label)} ${text}`);
        }
        const options = minimum?.options?.[field.key];
        if (Array.isArray(options) && options.length) parts.push(`${localizedText(field.label)}: ${options.join(', ')}`);
    });
    note.classList.toggle('hidden', !parts.length);
    note.textContent = parts.length ? t('audience.minimumByServer', { rule: parts.join(' · ') }) : '';
}

async function resetAudienceRule() {
    await updateAudienceRule({ ranges: {}, options: {} });
}
