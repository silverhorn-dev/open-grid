// ================= APP-MODI (P8) =================
// Der Betreiber erlaubt Modi (APP_MODES), der Nutzer waehlt einen davon (Onboarding + Einstellungen).
//   discovery: Grid in der Naehe, Flammen, Matches (wie bisher)
//   chat:      kein Grid, nie sichtbar; Kontakte per Einladungslink/QR
//   friends:   Grid nur mit gegenseitigen Kontakten, fuer Fremde unsichtbar
//   event:     Grid nur mit Teilnehmern desselben Event-Codes (Server sieht nur den Hash)
const APP_MODE_INFO = {
    discovery: { label: t('Entdecken'), icon: 'fa-location-crosshairs', description: t('Leute in der Naehe sehen, Flammen und Matches.') },
    chat: { label: t('Nur Chat'), icon: 'fa-comments', description: t('Kein Grid, fuer niemanden sichtbar. Kontakte per Einladungslink.') },
    friends: { label: t('Freunde in der Naehe'), icon: 'fa-user-group', description: t('Nur deine Kontakte sehen dich und du sie.') },
    event: { label: t('Event'), icon: 'fa-champagne-glasses', description: t('Nur Leute mit demselben Event-Code, endet nach 12 Stunden.') }
};
const APP_MODE_RECORD_ID = 'app-mode';
const APP_CONFIG_RECORD_ID = 'app-config';
const EVENT_DURATION_MS = 12 * 60 * 60 * 1000;
const INVITE_FINGERPRINT_LENGTH = 32;

// ----- Konfiguration und Auswahl -----
async function loadAppMode() {
    let config = null;
    try {
        const response = await fetch(`${API_BASE}/api/config`, { cache: 'no-store' });
        if (response.ok) config = await response.json();
        if (config) await putDatabaseRecord('keys', { id: APP_CONFIG_RECORD_ID, ...config });
    } catch {
        // Offline: zuletzt bekannte Konfiguration.
        config = await databaseRequest('keys', 'readonly', store => store.get(APP_CONFIG_RECORD_ID)).catch(() => null);
    }
    const modes = (config?.modes || []).filter(mode => APP_MODE_INFO[mode]);
    state.appConfig = {
        modes: modes.length ? modes : Object.keys(APP_MODE_INFO),
        defaultMode: config?.defaultMode,
        // Standards des Betreibers fuer Client-Einstellungen (gelten, solange nichts Eigenes gespeichert ist).
        clientDefaults: config?.clientDefaults && typeof config.clientDefaults === 'object' ? config.clientDefaults : {}
    };
    // Sprache: Standard des Betreibers gilt ab dem naechsten Start (oder sofort, wenn noch nichts gewaehlt).
    rememberRouterLanguageDefault(state.appConfig.clientDefaults.language);
    const stored = await databaseRequest('keys', 'readonly', store => store.get(APP_MODE_RECORD_ID)).catch(() => null);
    state.appModeSettings = stored || {};
    state.appMode = state.appConfig.modes.includes(stored?.mode)
        ? stored.mode
        : (state.appConfig.modes.includes(state.appConfig.defaultMode) ? state.appConfig.defaultMode : state.appConfig.modes[0]);
    if (state.appMode === 'event' && !hasActiveEvent()) state.appMode = fallbackMode();
    if (config?.profileSchemas) {
        try {
            PROFILE_SCHEMAS = normalizeProfileSchemas(config.profileSchemas);
        } catch (error) {
            logDebug(`Invalid profile schemas from router: ${error.message}`);
        }
    }
    applyProfileSchemaForMode();
    scheduleEventExpiry();
    applyAppModeUi();
}

function clientDefault(key, fallback) {
    const value = state.appConfig.clientDefaults?.[key];
    return value === undefined ? fallback : value;
}

// Jeder Modus hat sein eigenes Profil-Schema (z. B. "Nur Chat": Name + Status).
function applyProfileSchemaForMode() {
    PROFILE_SCHEMA = PROFILE_SCHEMAS[state.appMode] || PROFILE_SCHEMAS.discovery || Object.values(PROFILE_SCHEMAS)[0] || DEFAULT_PROFILE_SCHEMA;
    if (typeof renderProfileForm === 'function' && document.getElementById('dynamic-profile-form')) renderProfileForm();
}

function fallbackMode() {
    const { modes, defaultMode } = state.appConfig;
    const preferred = [defaultMode, 'discovery', 'chat', 'friends'].find(mode => mode && mode !== 'event' && modes.includes(mode));
    return preferred || modes[0];
}

async function saveAppModeSettings(changes) {
    state.appModeSettings = { ...state.appModeSettings, ...changes };
    await putDatabaseRecord('keys', { id: APP_MODE_RECORD_ID, ...state.appModeSettings });
}

async function setAppMode(mode) {
    if (!state.appConfig.modes.includes(mode)) return;
    if (mode === 'event' && !hasActiveEvent()) {
        document.getElementById('event-code-input')?.focus();
        showToast(t('Gib zuerst einen Event-Code ein.'), 'info');
        renderAppModeSettings();
        return;
    }
    state.appMode = mode;
    state.chatListScopeOverride = null;
    // Zuletzt genutzter Modus pro Liste (fuer den Listen-Wechsel).
    await saveAppModeSettings({ mode, ...(SOCIAL_MODES.includes(mode) ? { lastSocialMode: mode } : { lastDiscoveryMode: mode }) });
    state.gridRing = 0;
    applyProfileSchemaForMode();
    applyAppModeUi();
    renderActivePeerList();
    await refreshPresenceAndGrid();
}

// Sozialer Bereich (Chat, Freunde): hier duerfen Chat-Bilder gespeichert werden.
function isSocialMode() {
    return state.appMode === 'chat' || state.appMode === 'friends';
}

function isGridAvailable() {
    return state.appMode !== 'chat';
}

// Was der Router zu sehen bekommt: Sichtbarkeit je Modus.
function getRegistrationScope() {
    if (state.appMode === 'friends') return { scope: 'friends' };
    if (state.appMode === 'event' && hasActiveEvent()) return { scope: 'event', eventHash: state.appModeSettings.eventHash };
    return { scope: 'public' };
}

// Im Modus "Nur Chat" ist man nie im Grid.
function isModeSilent() {
    return state.appMode === 'chat';
}

// Grid-Abfrage je Modus.
function buildGridQuery() {
    const query = new URLSearchParams({ geohash: state.myProfile.geohash });
    if (state.appMode === 'friends') {
        query.set('scope', 'friends');
        query.set('peerId', state.myProfile.id);
    } else if (state.appMode === 'event') {
        query.set('scope', 'event');
        query.set('eventHash', state.appModeSettings.eventHash || '');
    } else {
        query.set('ring', String(state.gridRing));
        if (state.gridSettings.liveGrid) query.set('live', '1');
    }
    return query;
}

// ----- Oberflaeche -----
function applyAppModeUi() {
    syncAlbumCardVisibility();
    updateChatAlbumButton();
    const gridAvailable = isGridAvailable();
    document.querySelectorAll('[data-tab-btn="grid"]').forEach(button => button.classList.toggle('hidden', !gridAvailable));
    document.querySelectorAll('nav.bottom-nav').forEach(nav => {
        nav.classList.toggle('grid-cols-3', gridAvailable);
        nav.classList.toggle('grid-cols-2', !gridAvailable);
    });
    if (!gridAvailable && !document.getElementById('view-grid')?.classList.contains('hidden')) switchTab('chat');
    const title = document.getElementById('grid-title');
    if (title) {
        title.textContent = state.appMode === 'friends'
            ? t('Freunde in der Naehe')
            : state.appMode === 'event'
                ? `Event: ${state.appModeSettings.eventCode || ''}`
                : t('In deiner Naehe');
    }
    document.getElementById('grid-load-more-btn')?.classList.toggle('hidden', state.appMode !== 'discovery' || !state.gridHasMore);
    document.getElementById('leave-event-btn')?.classList.toggle('hidden', state.appMode !== 'event');
    renderAppModeSettings();
}

function renderModeChooser(container, onChoose) {
    if (!container) return;
    container.innerHTML = '';
    state.appConfig.modes.forEach(mode => {
        const info = APP_MODE_INFO[mode];
        const button = document.createElement('button');
        button.type = 'button';
        const active = mode === state.appMode;
        button.className = `w-full flex items-start gap-3 text-left p-3 rounded-xl border transition ${active ? 'border-brand-500 bg-brand-500/10' : 'border-slate-800 bg-slate-950/40 hover:border-slate-600'}`;
        const icon = document.createElement('i');
        icon.className = `fa-solid ${info.icon} text-brand-400 mt-0.5`;
        const text = document.createElement('div');
        const label = document.createElement('div');
        label.className = 'text-sm font-semibold text-slate-100';
        label.textContent = info.label;
        const description = document.createElement('div');
        description.className = 'text-xs text-slate-400';
        description.textContent = info.description;
        text.append(label, description);
        button.append(icon, text);
        button.onclick = () => onChoose(mode);
        container.appendChild(button);
    });
}

function renderAppModeSettings() {
    const card = document.getElementById('app-mode-card');
    if (!card || !state.appConfig) return;
    card.classList.toggle('hidden', state.appConfig.modes.length < 2 && !state.appConfig.modes.some(mode => mode !== 'discovery'));
    renderModeChooser(document.getElementById('app-mode-options'), setAppMode);
    document.getElementById('event-settings')?.classList.toggle('hidden', !state.appConfig.modes.includes('event'));
    const status = document.getElementById('event-status');
    if (status) {
        status.textContent = hasActiveEvent()
            ? t('Aktiv: {code} (endet {time})', { code: state.appModeSettings.eventCode, time: formatClockTime(state.appModeSettings.eventJoinedAt + EVENT_DURATION_MS) })
            : t('Kein Event aktiv.');
    }
    document.getElementById('invite-card')?.classList.toggle('hidden', !['chat', 'friends'].some(mode => state.appConfig.modes.includes(mode)));
}

// Erster Start: Modus waehlen, falls mehrere erlaubt sind.
function renderOnboardingModeChooser() {
    const wrapper = document.getElementById('onboarding-mode');
    if (!wrapper || !state.appConfig) return;
    const selectable = state.appConfig.modes.filter(mode => mode !== 'event');
    wrapper.classList.toggle('hidden', selectable.length < 2);
    const container = document.getElementById('onboarding-mode-options');
    const choose = mode => {
        state.appMode = mode;
        saveAppModeSettings({ mode }).catch(logBackgroundError('renderOnboardingModeChooser'));
        applyProfileSchemaForMode();
        renderProfileForm('onboarding-profile-form');
        renderOnboardingModeChooser();
    };
    renderModeChooser(container, choose);
    // Event braucht einen Code und wird spaeter in den Einstellungen betreten.
    container?.querySelectorAll('button').forEach((button, index) => {
        if (state.appConfig.modes[index] === 'event') button.remove();
    });
}

// ----- Events -----
function normalizeEventCode(code) {
    return String(code || '').trim().toUpperCase().replace(/\s+/g, ' ').substring(0, 64);
}

async function hashEventCode(code) {
    const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(`og-event:${code}`));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function hasActiveEvent() {
    const settings = state.appModeSettings || {};
    return Boolean(settings.eventHash && settings.eventJoinedAt && Date.now() < settings.eventJoinedAt + EVENT_DURATION_MS);
}

async function joinEvent() {
    const input = document.getElementById('event-code-input');
    const code = normalizeEventCode(input?.value);
    if (code.length < 3) {
        showToast(t('Der Event-Code braucht mindestens 3 Zeichen.'), 'warning');
        return;
    }
    await saveAppModeSettings({
        eventCode: code,
        eventHash: await hashEventCode(code),
        eventJoinedAt: Date.now(),
        modeBeforeEvent: state.appMode === 'event' ? state.appModeSettings.modeBeforeEvent : state.appMode
    });
    if (input) input.value = '';
    scheduleEventExpiry();
    await setAppMode('event');
    showToast(t('Du bist im Event {code}.', { code }), 'success');
}

async function leaveEvent() {
    const previous = state.appModeSettings.modeBeforeEvent;
    await saveAppModeSettings({ eventCode: null, eventHash: null, eventJoinedAt: null });
    clearTimeout(state.eventExpiryTimer);
    const next = state.appConfig.modes.includes(previous) && previous !== 'event' ? previous : fallbackMode();
    await setAppMode(next);
}

function scheduleEventExpiry() {
    clearTimeout(state.eventExpiryTimer);
    if (!hasActiveEvent()) return;
    const remaining = state.appModeSettings.eventJoinedAt + EVENT_DURATION_MS - Date.now();
    state.eventExpiryTimer = setTimeout(() => {
        showToast(t('Das Event ist vorbei.'), 'info');
        leaveEvent().catch(logBackgroundError('scheduleEventExpiry'));
    }, Math.min(remaining, 2147483647));
}

// ----- Einladungslinks -----
// Link: /invite#<peerId>.<fingerprint>. Der Teil nach # geht nie an den Server.
async function keyFingerprint(jwk) {
    const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${jwk.crv}:${jwk.x}:${jwk.y}`));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('').substring(0, INVITE_FINGERPRINT_LENGTH);
}

async function getMyInviteLink() {
    const fingerprint = await keyFingerprint(state.myKeys.jwkEcdsaPublic);
    return `${window.location.origin}/invite#${encodeURIComponent(state.myProfile.id)}.${fingerprint}`;
}

async function renderInviteCard() {
    const output = document.getElementById('invite-link-output');
    const qr = document.getElementById('invite-qr');
    if (!output || !state.myKeys) return;
    const link = await getMyInviteLink();
    output.value = link;
    if (qr && typeof qrcode === 'function') {
        const code = qrcode(0, 'M');
        code.addData(link);
        code.make();
        qr.src = code.createDataURL(5, 2);
        qr.classList.remove('hidden');
    }
}

async function copyInviteLink() {
    try {
        await navigator.clipboard.writeText(await getMyInviteLink());
        showToast(t('Einladungslink kopiert.'), 'success');
    } catch {
        showToast(t('Kopieren nicht moeglich.'), 'error');
    }
}

async function shareInviteLink() {
    const url = await getMyInviteLink();
    if (navigator.share) {
        navigator.share({ title: 'OpenGrid', text: 'Schreib mir auf OpenGrid', url }).catch(logBackgroundError('shareInviteLink'));
    } else {
        await copyInviteLink();
    }
}

function parseInvite(fragment) {
    const value = decodeURIComponent(String(fragment || '').replace(/^#/, ''));
    const separator = value.lastIndexOf('.');
    if (separator <= 0) return null;
    const peerId = value.substring(0, separator);
    const fingerprint = value.substring(separator + 1).toLowerCase();
    if (!peerId || peerId.length > 200 || !new RegExp(`^[0-9a-f]{${INVITE_FINGERPRINT_LENGTH}}$`).test(fingerprint)) return null;
    return { peerId, fingerprint };
}

// Einladung annehmen: Kontakt anlegen und den erwarteten Schluessel merken.
async function acceptInvite(fragment) {
    const invite = parseInvite(fragment);
    if (!invite) {
        showToast(t('Der Einladungslink ist ungueltig.'), 'error');
        return;
    }
    if (invite.peerId === state.myProfile.id) {
        showToast(t('Das ist dein eigener Einladungslink.'), 'info');
        return;
    }
    const known = await getPeerIdentity(invite.peerId).catch(() => null);
    if (known?.profileSigningKey && await keyFingerprint(known.profileSigningKey) !== invite.fingerprint) {
        showToast(t('Achtung: Der Schluessel dieses Kontakts passt nicht zur Einladung.'), 'error');
        return;
    }
    await putDatabaseRecord('keys', { id: `invite-expect:${invite.peerId}`, fingerprint: invite.fingerprint });
    rememberChatPeer(invite.peerId);
    await openChatWithPeer(invite.peerId);
    showToast(t('Kontakt hinzugefuegt. Die Verbindung wird beim ersten Kontakt geprueft.'), 'success');
}

// Wird beim ersten KEY_HELLO aufgerufen: false = Schluessel passt nicht zur Einladung.
async function verifyInvitedPeerKey(peerId, profileSigningKey) {
    const expected = await databaseRequest('keys', 'readonly', store => store.get(`invite-expect:${peerId}`)).catch(() => null);
    if (!expected) return true;
    const matches = await keyFingerprint(profileSigningKey) === expected.fingerprint;
    if (matches) {
        await deleteDatabaseRecord('keys', `invite-expect:${peerId}`);
        showToast(t('Kontakt verifiziert.'), 'success');
    }
    return matches;
}

// Nach dem Start: Einladung erst annehmen, wenn das Signaling steht (sonst kein P2P-Aufbau).
async function acceptPendingInvite() {
    const fragment = state.pendingInvite;
    state.pendingInvite = null;
    const startedAt = Date.now();
    while (state.ws?.readyState !== WebSocket.OPEN && Date.now() - startedAt < 10000) {
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    await acceptInvite(fragment);
}
