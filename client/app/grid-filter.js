// ================= GRID: FILTER UND BLAETTERN =================
// Filter nur auf dem Geraet (der Router erfaehrt nichts): Entfernung und "mit Foto" aus der Grid-Karte,
// Zahlenfelder (von-bis) und Auswahlfelder (ODER innerhalb eines Felds) aus dem Profil, UND zwischen den
// Feldern. Profile kommen nur P2P; wessen Profil noch fehlt, gilt als "unbekannt" (Schalter "Unbekannte
// zeigen"). Passende stehen vorne, unbekannte danach. Die ersten 10 sichtbaren Profile werden im
// Hintergrund geholt, danach wird neu sortiert. Das Panel klappt ueber den Pfeil-Knopf auf und gilt fuer
// Grid, Interaktionen und Matches. Im offenen Profil: seitlich wischen (bzw. Pfeiltasten) = naechstes
// Profil der aktuellen Liste.
const GRID_FILTER_RECORD_ID = 'grid-filter';
const GRID_PREFETCH_COUNT = 10;
const DISTANCE_ORDER = ['lt1', '1-5', '5-20', '20-100', '100-300', '300-500', 'gt500'];

function emptyGridFilter() {
    return { maxDistance: null, photo: false, unknown: true, ranges: {}, options: {} };
}

async function loadGridFilter() {
    const stored = await databaseRequest('keys', 'readonly', store => store.get(GRID_FILTER_RECORD_ID)).catch(() => null);
    const filter = emptyGridFilter();
    if (stored) {
        filter.maxDistance = DISTANCE_ORDER.includes(stored.maxDistance) ? stored.maxDistance : null;
        filter.photo = stored.photo === true;
        filter.unknown = stored.unknown !== false;
        filter.ranges = stored.ranges && typeof stored.ranges === 'object' ? stored.ranges : {};
        filter.options = stored.options && typeof stored.options === 'object' ? stored.options : {};
    }
    state.gridFilter = filter;
}

function saveGridFilter() {
    return putDatabaseRecord('keys', { id: GRID_FILTER_RECORD_ID, ...state.gridFilter })
        .catch(error => logDebug(`Could not store grid filter: ${error.message}`));
}

// Felder, nach denen sich filtern laesst: Zahlen und Auswahlen aus dem aktuellen Profil-Schema.
function filterableFields() {
    return (PROFILE_SCHEMA || []).filter(field => field.type === 'number'
        || (['select', 'multiselect'].includes(field.type) && Array.isArray(field.options) && field.options.length));
}

function profileFilterActive(filter = state.gridFilter) {
    return Object.values(filter.ranges).some(range => Number.isFinite(range?.min) || Number.isFinite(range?.max))
        || Object.values(filter.options).some(values => Array.isArray(values) && values.length > 0);
}

function gridFilterActive(filter = state.gridFilter) {
    return Boolean(filter.maxDistance) || filter.photo || profileFilterActive(filter);
}

// 'match' | 'unknown' | 'no' fuer einen Peer (Grid-Karte optional fuer Entfernung/Foto).
function gridFilterVerdict(peerId, card = null, filter = state.gridFilter) {
    if (filter.maxDistance && card?.distanceBucket
        && DISTANCE_ORDER.indexOf(card.distanceBucket) > DISTANCE_ORDER.indexOf(filter.maxDistance)) return 'no';
    const profile = state.cachedProfiles[peerId];
    if (filter.photo && !(card?.avatar || profile?.avatar)) return 'no';
    if (!profileFilterActive(filter)) return 'match';
    if (!profile?.fields) return 'unknown';
    for (const field of filterableFields()) {
        const value = profile.fields[field.key];
        if (field.type === 'number') {
            const range = filter.ranges[field.key];
            if (!range || (!Number.isFinite(range.min) && !Number.isFinite(range.max))) continue;
            const number = Number(value);
            if (!Number.isFinite(number)) return 'unknown';
            if ((Number.isFinite(range.min) && number < range.min) || (Number.isFinite(range.max) && number > range.max)) return 'no';
        } else {
            const wanted = filter.options[field.key];
            if (!Array.isArray(wanted) || !wanted.length) continue;
            const have = Array.isArray(value) ? value : value ? [value] : [];
            if (!have.length) return 'unknown';
            if (!have.some(item => wanted.includes(item))) return 'no';
        }
    }
    return 'match';
}

// Liste filtern und sortieren: passende vorne (Reihenfolge bleibt), unbekannte danach (wenn erlaubt).
function applyGridFilter(items, idOf = item => item.id, cardOf = item => item) {
    const matching = [];
    const unknown = [];
    for (const item of items) {
        const verdict = gridFilterVerdict(idOf(item), cardOf(item));
        if (verdict === 'match') matching.push(item);
        else if (verdict === 'unknown' && state.gridFilter.unknown) unknown.push(item);
    }
    return [...matching, ...unknown];
}

// Die ersten sichtbaren Profile im Hintergrund holen, damit Filter und Sortierung greifen. Wer im Grid
// steht, ist laut Router gerade da: direkt anfragen (baut P2P auf, wie beim Oeffnen des Profils), je
// Peer hoechstens einmal pro Minute.
const GRID_PREFETCH_INTERVAL_MS = 60 * 1000;
const GRID_PREFETCH_DELAY_MS = 2000;
const gridPrefetchRequests = {};

// Gebuendelt 2 s nach dem Zeichnen: so laufen Ablaeufe beim Start (z. B. eine Einladung) erst in Ruhe an.
// Ausgelassen: wer schon einen Chat hat (dessen Profil kommt ueber den Chat) oder gerade verbunden wird.
function prefetchGridProfiles(peerIds) {
    state.gridPrefetchPeerIds = peerIds;
    if (state.gridPrefetchTimer) return;
    state.gridPrefetchTimer = setTimeout(() => {
        state.gridPrefetchTimer = null;
        runGridPrefetch(state.gridPrefetchPeerIds || []);
    }, GRID_PREFETCH_DELAY_MS);
}

function runGridPrefetch(peerIds) {
    const now = Date.now();
    peerIds.filter(peerId => !state.cachedProfiles[peerId] && !isPeerBlocked(peerId)
        && !state.chatPeerIds.includes(peerId) && peerId !== state.activeChatPeerId)
        .slice(0, GRID_PREFETCH_COUNT)
        .filter(peerId => now - (gridPrefetchRequests[peerId] || 0) >= GRID_PREFETCH_INTERVAL_MS)
        .forEach(peerId => {
            gridPrefetchRequests[peerId] = now;
            const request = () => {
                if (state.cachedProfiles[peerId] || hasConnectionInProgress(peerId)) return;
                sendSecurePayload(peerId, { type: 'PROFILE_REQUEST' }).catch(logBackgroundError('prefetchGridProfiles'));
            };
            // Sehen sich beide im Grid, wuerden beide gleichzeitig verbinden. Die hoefliche Seite wartet kurz.
            if (typeof isPolitePeer === 'function' && isPolitePeer(peerId)) setTimeout(request, 1500);
            else request();
        });
}

// Profil angekommen: bei aktivem Filter das Grid kurz danach neu sortieren (gebuendelt).
function scheduleGridRefilter() {
    if (!profileFilterActive() || state.gridRefilterTimer) return;
    state.gridRefilterTimer = setTimeout(() => {
        state.gridRefilterTimer = null;
        if (!document.getElementById('view-grid')?.classList.contains('hidden')) renderDiscoveryGrid();
    }, 300);
}

// ----- Panel -----
function toggleGridFilterPanel() {
    const panel = document.getElementById('grid-filter-panel');
    if (!panel) return;
    const open = panel.classList.toggle('hidden') === false;
    document.getElementById('grid-filter-btn')?.setAttribute('aria-expanded', String(open));
    if (open) renderGridFilterPanel();
}

async function updateGridFilter(change) {
    state.gridFilter = { ...state.gridFilter, ...change };
    await saveGridFilter();
    renderGridFilterButton();
    renderDiscoveryGrid();
}

async function resetGridFilter() {
    state.gridFilter = emptyGridFilter();
    await saveGridFilter();
    renderGridFilterPanel();
    renderGridFilterButton();
    renderDiscoveryGrid();
}

function renderGridFilterButton() {
    document.getElementById('grid-filter-btn')?.classList.toggle('is-active', gridFilterActive());
}

function renderGridFilterPanel() {
    const panel = document.getElementById('grid-filter-panel');
    if (!panel) return;
    panel.innerHTML = '';
    const filter = state.gridFilter;
    const row = (label, control) => {
        const wrap = document.createElement('label');
        wrap.className = 'grid-filter-row';
        const text = document.createElement('span');
        text.className = 'grid-filter-label';
        text.textContent = label;
        wrap.append(text, control);
        return wrap;
    };
    const toggle = (checked, onChange) => {
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.setAttribute('role', 'switch');
        input.className = 'switch';
        input.checked = checked;
        input.onchange = () => onChange(input.checked);
        return input;
    };

    const distance = document.createElement('select');
    distance.className = 'setting-select';
    [['', t('grid.filterAnyDistance')], ...DISTANCE_ORDER.map(bucket => [bucket, DISTANCE_BUCKET_LABELS[bucket]])].forEach(([value, label]) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        option.selected = (filter.maxDistance || '') === value;
        distance.appendChild(option);
    });
    distance.onchange = () => updateGridFilter({ maxDistance: distance.value || null });
    panel.appendChild(row(t('grid.filterMaxDistance'), distance));
    panel.appendChild(row(t('grid.filterWithPhoto'), toggle(filter.photo, photo => updateGridFilter({ photo }))));

    filterableFields().forEach(field => {
        if (field.type === 'number') {
            const range = filter.ranges[field.key] || {};
            const box = document.createElement('span');
            box.className = 'grid-filter-range';
            const number = (value, placeholder, key) => {
                const input = document.createElement('input');
                input.type = 'number';
                input.inputMode = 'numeric';
                input.className = 'setting-input w-16';
                input.placeholder = placeholder;
                if (Number.isFinite(field.min)) input.min = field.min;
                if (Number.isFinite(field.max)) input.max = field.max;
                if (Number.isFinite(value)) input.value = value;
                input.onchange = () => {
                    const parsed = input.value === '' ? null : Number(input.value);
                    const next = { ...(state.gridFilter.ranges[field.key] || {}), [key]: Number.isFinite(parsed) ? parsed : null };
                    updateGridFilter({ ranges: { ...state.gridFilter.ranges, [field.key]: next } });
                };
                return input;
            };
            box.append(number(range.min, t('grid.filterFrom'), 'min'), document.createTextNode('–'), number(range.max, t('grid.filterTo'), 'max'));
            panel.appendChild(row(localizedText(field.label), box));
            return;
        }
        const chips = document.createElement('span');
        chips.className = 'grid-filter-chips';
        const selected = new Set(filter.options[field.key] || []);
        field.options.forEach(value => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = `grid-filter-chip${selected.has(value) ? ' is-active' : ''}`;
            chip.textContent = localizedText(value);
            chip.setAttribute('aria-pressed', String(selected.has(value)));
            chip.onclick = event => {
                event.preventDefault();
                if (selected.has(value)) selected.delete(value);
                else selected.add(value);
                updateGridFilter({ options: { ...state.gridFilter.options, [field.key]: [...selected] } }).then(renderGridFilterPanel);
            };
            chips.appendChild(chip);
        });
        panel.appendChild(row(localizedText(field.label), chips));
    });

    if (filterableFields().length) {
        panel.appendChild(row(t('grid.filterShowUnknown'), toggle(filter.unknown, unknown => updateGridFilter({ unknown }))));
    }
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'grid-filter-reset';
    reset.textContent = t('grid.filterReset');
    reset.onclick = resetGridFilter;
    panel.appendChild(reset);
}

// ----- Blaettern im Profil -----
// Liste, aus der das Profil geoeffnet wurde (Grid, Interaktionen, Matches), in angezeigter Reihenfolge.
function setProfileBrowseList(peerIds) {
    state.profileBrowseList = peerIds.slice(0, 500);
}

function stepProfile(direction) {
    const list = state.profileBrowseList || [];
    const index = list.indexOf(state.activeModalPeerId);
    if (index < 0) return;
    const next = list[index + direction];
    if (!next) return;
    hapticTick();
    openProfileModal(next);
}

function initProfileBrowsing() {
    const card = document.querySelector('#profile-detail-modal > div');
    if (!card) return;
    let start = null;
    card.addEventListener('touchstart', event => {
        start = event.touches.length === 1 && !event.target.closest('[data-no-sheet-swipe], input, textarea, select')
            ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null;
    }, { passive: true });
    card.addEventListener('touchend', event => {
        if (!start) return;
        const touch = event.changedTouches[0];
        const deltaX = touch.clientX - start.x;
        const deltaY = touch.clientY - start.y;
        start = null;
        if (Math.abs(deltaX) < 70 || Math.abs(deltaX) < Math.abs(deltaY) * 1.5) return;
        stepProfile(deltaX < 0 ? 1 : -1);
    }, { passive: true });
    document.addEventListener('keydown', event => {
        if (document.getElementById('profile-detail-modal')?.classList.contains('hidden')) return;
        if (event.target.closest?.('input, textarea, select')) return;
        if (event.key === 'ArrowRight') stepProfile(1);
        else if (event.key === 'ArrowLeft') stepProfile(-1);
    });
}
