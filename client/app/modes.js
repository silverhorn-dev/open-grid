// ================= APP-MODI (P8) =================
// Der Betreiber erlaubt Modi (APP_MODES), der Nutzer waehlt einen davon (Onboarding + Einstellungen).
//   discovery: Grid in der Naehe, Flammen, Matches (wie bisher)
//   chat:      kein Grid, nie sichtbar; Kontakte per Einladungslink/QR
//   friends:   Grid nur mit gegenseitigen Kontakten, fuer Fremde unsichtbar
//   event:     Grid nur mit Teilnehmern desselben Event-Codes (Server sieht nur den Hash)
const APP_MODE_INFO = {
    discovery: { label: t('modes.discover'), icon: 'fa-location-crosshairs', description: t('modes.seePeopleNearbyFlamesAnd') },
    chat: { label: t('modes.chatOnly'), icon: 'fa-comments', description: t('modes.noGridInvisibleToEveryone') },
    friends: { label: t('modes.friendsNearby'), icon: 'fa-user-group', description: t('modes.onlyYourContactsSeeYou') },
    event: { label: t('modes.event'), icon: 'fa-champagne-glasses', description: t('modes.onlyPeopleWithSameEvent') }
};
// Bereich, den der Nutzer beim Onboarding waehlt (keys/app-mode.scope). Fehlt er (bestehende Nutzer) = 'all'.
//   discovery: Nur Entdecken (Grid + Event, Flamme/Match, kein Adden)
//   social:    Social (Chat + Freunde, Freunde-Grid, nur Adden)
//   all:       Entdecken & Freunde (alle Modi)
const MODE_SCOPE_MODES = { discovery: ['discovery', 'event'], social: ['chat', 'friends'] };
const MODE_SCOPES = ['discovery', 'social', 'all'];
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
        // Vom Betreiber erlaubt; `modes` ist davon der Teil im gewaehlten Bereich (applyModeScope).
        routerModes: modes.length ? modes : Object.keys(APP_MODE_INFO),
        modes: modes.length ? modes : Object.keys(APP_MODE_INFO),
        defaultMode: config?.defaultMode,
        // Standards des Betreibers fuer Client-Einstellungen (gelten, solange nichts Eigenes gespeichert ist).
        clientDefaults: config?.clientDefaults && typeof config.clientDefaults === 'object' ? config.clientDefaults : {},
        // Info-Seite fuer alle (eigene Subdomain oder /info), vom Router vorgegeben.
        infoUrl: typeof config?.infoUrl === 'string' && /^(https:\/\/|\/)/.test(config.infoUrl) ? config.infoUrl : '/info',
        // Nachweis-Pflichten des Routers (T2), standardmaessig aus.
        safety: {
            ageCheck: ['confirm', 'provider'].includes(config?.safety?.ageCheck) ? config.safety.ageCheck : 'off',
            ageProvider: typeof config?.safety?.ageProvider === 'string' ? config.safety.ageProvider : null,
            emailCheck: config?.safety?.emailCheck === 'required' ? 'required' : 'off'
        },
        // Nacktbild-Modell vom Router (Board T3): Modell, Schwelle, Klassen, Pfade (nudity-model.js).
        nudity: config?.nudity && typeof config.nudity === 'object' ? config.nudity : { model: 'off' },
        // Mindestwerte des Betreibers fuer "Nur zeigen fuer ..." (der Router mischt sie selbst in die Karte).
        audienceMinimum: config?.audienceMinimum && typeof config.audienceMinimum === 'object' ? config.audienceMinimum : null
    };
    document.querySelectorAll('[data-info-link]').forEach(link => { link.href = state.appConfig.infoUrl; });
    // Sprache: Standard des Betreibers gilt ab dem naechsten Start (oder sofort, wenn noch nichts gewaehlt).
    rememberRouterLanguageDefault(state.appConfig.clientDefaults.language);
    const stored = await databaseRequest('keys', 'readonly', store => store.get(APP_MODE_RECORD_ID)).catch(() => null);
    state.appModeSettings = stored || {};
    applyModeScope();
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
    const preferred = [defaultMode, 'discovery', 'friends', 'chat'].find(mode => mode && mode !== 'event' && modes.includes(mode));
    return preferred || modes[0];
}

// ----- Bereich (Nur Entdecken / Social / Entdecken & Freunde) -----
// Bereiche, fuer die der Betreiber mindestens einen Modus erlaubt.
function availableModeAreas(routerModes = state.appConfig.routerModes) {
    return Object.keys(MODE_SCOPE_MODES).filter(area => MODE_SCOPE_MODES[area].some(mode => routerModes.includes(mode)));
}

// Wirksamer Bereich: erlaubt der Betreiber nur einen, gilt dieser, egal was gespeichert ist.
function effectiveModeScope() {
    const areas = availableModeAreas();
    if (areas.length === 1) return areas[0];
    const stored = state.appModeSettings?.scope;
    return MODE_SCOPES.includes(stored) ? stored : 'all';
}

function modesForScope(scope, routerModes) {
    if (scope === 'all') return [...routerModes];
    const modes = routerModes.filter(mode => MODE_SCOPE_MODES[scope]?.includes(mode));
    return modes.length ? modes : [...routerModes];
}

// true, wenn der Bereich ('discovery' | 'social') im gewaehlten Umfang enthalten ist.
function scopeIncludes(area) {
    const scope = effectiveModeScope();
    return scope === 'all' || scope === area;
}

function applyModeScope() {
    state.appConfig.modes = modesForScope(effectiveModeScope(), state.appConfig.routerModes);
}

// Einstellungen und Knoepfe mit data-scope: "discovery"/"social" = nur, wenn der Bereich dabei ist,
// "all" = nur bei Entdecken & Freunde (z. B. Listen-Wechsel, Adden nach Match).
function applyModeScopeVisibility() {
    const scope = effectiveModeScope();
    document.querySelectorAll('[data-scope]').forEach(element => {
        const wanted = element.dataset.scope;
        const visible = wanted === 'all' ? scope === 'all' : scopeIncludes(wanted);
        element.classList.toggle('scope-hidden', !visible);
    });
}

async function setModeScope(scope) {
    if (!MODE_SCOPES.includes(scope)) return;
    await saveAppModeSettings({ scope });
    applyModeScope();
    state.chatListScopeOverride = null;
    if (!state.appConfig.modes.includes(state.appMode) || (state.appMode === 'event' && !hasActiveEvent())) {
        state.appMode = fallbackMode();
        await saveAppModeSettings({ mode: state.appMode });
        applyProfileSchemaForMode();
    }
    applyAppModeUi();
    if (typeof renderMatchingSettings === 'function') renderMatchingSettings();
    if (typeof renderListSwitch === 'function') renderListSwitch();
    if (typeof renderActivePeerList === 'function') renderActivePeerList();
    if (state.myProfile?.id && typeof refreshPresenceAndGrid === 'function') await refreshPresenceAndGrid();
}

// Schalter "Alle Modi anzeigen" (Einstellungen > Allgemein > Erweitert).
async function setAllModesVisible(enabled) {
    const previous = state.appModeSettings.scopeBeforeAll;
    if (enabled) {
        const current = effectiveModeScope();
        if (current !== 'all') await saveAppModeSettings({ scopeBeforeAll: current });
        await setModeScope('all');
    } else {
        await setModeScope(MODE_SCOPES.includes(previous) && previous !== 'all' ? previous : 'discovery');
    }
}

function renderModeScopeSettings() {
    const card = document.getElementById('mode-scope-settings');
    if (!card) return;
    const areas = availableModeAreas();
    card.classList.toggle('hidden', areas.length < 2);
    const scope = effectiveModeScope();
    const select = document.getElementById('mode-scope-select');
    if (select) select.value = scope;
    const toggle = document.getElementById('all-modes-toggle');
    if (toggle) toggle.checked = scope === 'all';
}

async function saveAppModeSettings(changes) {
    state.appModeSettings = { ...state.appModeSettings, ...changes };
    await putDatabaseRecord('keys', { id: APP_MODE_RECORD_ID, ...state.appModeSettings });
}

async function setAppMode(mode) {
    if (!state.appConfig.modes.includes(mode)) return;
    if (mode === 'event' && !hasActiveEvent()) {
        document.getElementById('event-code-input')?.focus();
        showToast(t('modes.enterEventCodeFirst'), 'info');
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
    // Mit Nachweis-Pflicht will der Router wissen, wer fragt (Bearer-Token dazu in fetchGridRing).
    if (typeof isSafetyGateActive === 'function' && isSafetyGateActive() && !query.has('peerId')) query.set('peerId', state.myProfile.id);
    return query;
}

// ----- Oberflaeche -----
function applyAppModeUi() {
    if (typeof renderMenu === 'function') renderMenu();
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
            ? t('modes.friendsNearby')
            : state.appMode === 'event'
                ? `Event: ${state.appModeSettings.eventCode || ''}`
                : t('common.nearYou');
    }
    document.getElementById('grid-load-more-btn')?.classList.toggle('hidden', state.appMode !== 'discovery' || !state.gridHasMore);
    document.getElementById('leave-event-btn')?.classList.toggle('hidden', state.appMode !== 'event');
    renderAppModeSettings();
}

function renderModeChooser(container, onChoose) {
    if (!container) return;
    container.innerHTML = '';
    state.appConfig.modes.forEach(mode => {
        container.appendChild(renderChoiceButton(APP_MODE_INFO[mode], mode === state.appMode, () => onChoose(mode)));
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
            ? t('modes.activeEnds', { code: state.appModeSettings.eventCode, time: formatClockTime(state.appModeSettings.eventJoinedAt + EVENT_DURATION_MS) })
            : t('common.noEventActive');
    }
    document.getElementById('invite-card')?.classList.toggle('hidden', !['chat', 'friends'].some(mode => state.appConfig.modes.includes(mode)));
    renderModeScopeSettings();
    applyModeScopeVisibility();
    if (typeof renderSafetyCard === 'function') renderSafetyCard();
}

// Erster Start: erst den Bereich waehlen (wenn der Betreiber beide erlaubt), dann ggf. den Modus darin.
const MODE_SCOPE_INFO = {
    discovery: { label: t('modes.scopeDiscovery'), icon: 'fa-location-crosshairs', description: t('modes.scopeDiscoveryDescription') },
    social: { label: t('modes.scopeSocial'), icon: 'fa-user-group', description: t('modes.scopeSocialDescription') },
    all: { label: t('modes.scopeAll'), icon: 'fa-layer-group', description: t('modes.scopeAllDescription') }
};

function renderChoiceButton(info, active, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `w-full flex items-start gap-3 text-left p-3 rounded-xl border transition ${active ? 'border-brand-500 bg-brand-500/10' : 'border-slate-800 bg-slate-950/40 hover:border-slate-600'}`;
    button.setAttribute('aria-pressed', String(active));
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
    button.onclick = onClick;
    return button;
}

function renderOnboardingModeChooser() {
    if (!state.appConfig) return;
    const scopeWrapper = document.getElementById('onboarding-scope');
    const scopeContainer = document.getElementById('onboarding-scope-options');
    const showScopes = availableModeAreas().length > 1;
    scopeWrapper?.classList.toggle('hidden', !showScopes);
    if (scopeContainer) {
        const current = effectiveModeScope();
        scopeContainer.replaceChildren(...MODE_SCOPES.map(scope => renderChoiceButton(MODE_SCOPE_INFO[scope], scope === current, () => {
            saveAppModeSettings({ scope }).then(() => {
                applyModeScope();
                if (!state.appConfig.modes.includes(state.appMode) || state.appMode === 'event') {
                    state.appMode = fallbackMode();
                    return saveAppModeSettings({ mode: state.appMode });
                }
                return undefined;
            }).then(() => {
                applyProfileSchemaForMode();
                renderProfileForm('onboarding-profile-form');
                applyAppModeUi();
                renderOnboardingModeChooser();
            }).catch(logBackgroundError('renderOnboardingModeChooser'));
        })));
    }
    const wrapper = document.getElementById('onboarding-mode');
    if (!wrapper) return;
    // Event braucht einen Code und wird spaeter in den Einstellungen betreten.
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
        showToast(t('modes.eventCodeNeedsAtLeast'), 'warning');
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
    showToast(t('modes.youAreInEvent', { code }), 'success');
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
        showToast(t('modes.eventIsOver'), 'info');
        leaveEvent().catch(logBackgroundError('scheduleEventExpiry'));
    }, Math.min(remaining, 2147483647));
}

// ----- Einladungslinks -----
// Link: /invite#<peerId>.<fingerprint>~<modus>. Der Teil nach # geht nie an den Server. Der Modus ist der,
// in dem eingeladen wurde: der Chat landet bei beiden in dessen Liste (Grid & Event bzw. Chat & Freunde).
// Aeltere Links ohne Modus gelten weiter (Liste wie bisher).
async function keyFingerprint(jwk) {
    const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${jwk.crv}:${jwk.x}:${jwk.y}`));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('').substring(0, INVITE_FINGERPRINT_LENGTH);
}

async function getMyInviteLink() {
    const fingerprint = await keyFingerprint(state.myKeys.jwkEcdsaPublic);
    const mode = APP_MODE_INFO[state.appMode] ? `~${state.appMode}` : '';
    return `${window.location.origin}/invite#${encodeURIComponent(state.myProfile.id)}.${fingerprint}${mode}`;
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
        showToast(t('modes.inviteLinkCopied'), 'success');
    } catch {
        showToast(t('common.copyingIsNotPossible'), 'error');
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
    const [value, modePart] = decodeURIComponent(String(fragment || '').replace(/^#/, '')).split('~');
    const mode = APP_MODE_INFO[modePart] ? modePart : null;
    const separator = value.lastIndexOf('.');
    if (separator <= 0) return null;
    const peerId = value.substring(0, separator);
    const fingerprint = value.substring(separator + 1).toLowerCase();
    if (!peerId || peerId.length > 200 || !new RegExp(`^[0-9a-f]{${INVITE_FINGERPRINT_LENGTH}}$`).test(fingerprint)) return null;
    return { peerId, fingerprint, mode };
}

// Bereich und Modus fuer eine Einladung: null, wenn der Bereich hier ausgeschaltet ist (eigene
// Bereichswahl oder Betreiber). Event-Einladungen landen in "Grid & Event", aber im Entdecken-Modus
// (der Event-Code fehlt hier).
function inviteTarget(mode) {
    if (!mode) return { area: null, mode: null };
    const area = MODE_SCOPE_MODES.discovery.includes(mode) ? 'discovery' : 'social';
    if (!availableModeAreas().includes(area) || !scopeIncludes(area)) return null;
    const usable = candidate => state.appConfig.modes.includes(candidate) && candidate !== 'event';
    const target = usable(mode) ? mode : MODE_SCOPE_MODES[area].find(usable) || null;
    return { area, mode: target };
}

// Einladung annehmen: Kontakt anlegen und den erwarteten Schluessel merken.
async function acceptInvite(fragment) {
    const invite = parseInvite(fragment);
    if (!invite) {
        showToast(t('modes.inviteLinkIsInvalid'), 'error');
        return;
    }
    if (invite.peerId === state.myProfile.id) {
        showToast(t('modes.thisIsYourOwnInvite'), 'info');
        return;
    }
    const target = inviteTarget(invite.mode);
    if (!target) {
        // Bereich ausgeschaltet: nichts oeffnen, nur sagen, warum.
        showToast(t('modes.inviteModeDisabled', { mode: APP_MODE_INFO[invite.mode].label }), 'warning');
        return;
    }
    const known = await getPeerIdentity(invite.peerId).catch(() => null);
    if (known?.profileSigningKey && await keyFingerprint(known.profileSigningKey) !== invite.fingerprint) {
        showToast(t('modes.warningThisContactsKeyDoes'), 'error');
        return;
    }
    await putDatabaseRecord('keys', { id: `invite-expect:${invite.peerId}`, fingerprint: invite.fingerprint });
    if (target.area) {
        if (target.mode && target.mode !== state.appMode) await setAppMode(target.mode);
        await ensureChatScope(invite.peerId, target.area);
    }
    rememberChatPeer(invite.peerId);
    await openChatWithPeer(invite.peerId);
    showToast(t('modes.contactAddedConnectionIsVerified'), 'success');
}

// Wird beim ersten KEY_HELLO aufgerufen: false = Schluessel passt nicht zur Einladung.
async function verifyInvitedPeerKey(peerId, profileSigningKey) {
    const expected = await databaseRequest('keys', 'readonly', store => store.get(`invite-expect:${peerId}`)).catch(() => null);
    if (!expected) return true;
    const matches = await keyFingerprint(profileSigningKey) === expected.fingerprint;
    if (matches) {
        await deleteDatabaseRecord('keys', `invite-expect:${peerId}`);
        showToast(t('modes.contactVerified'), 'success');
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
