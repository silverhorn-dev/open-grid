function clearDebugLogs() {
    state.debugLogBuffer = [];
    const output = document.getElementById('debug-log-output');
    if (output) output.innerHTML = '<div>[System] Log cleared.</div>';
}

function buildDebugLogReport() {
    const header = [
        `OpenGrid Debug Log`,
        `Exported: ${new Date().toISOString()}`,
        `Node: ${state.myProfile.id || state.nodeId}`,
        `Geohash: ${state.myProfile.geohash}`,
        `UserAgent: ${navigator.userAgent}`,
        `Signaling: ${describeSocketState()}`,
        `ICE servers: ${summarizeIceServers()}`,
        '---'
    ];
    return header.concat(state.debugLogBuffer).join('\n');
}

function describeSocketState() {
    const states = { 0: 'connecting', 1: 'open', 2: 'closing', 3: 'closed' };
    return state.ws ? (states[state.ws.readyState] || 'unknown') : 'not initialized';
}

function summarizeIceServers() {
    const servers = (typeof rtcConfig !== 'undefined' && rtcConfig.iceServers) || [];
    const urls = servers.flatMap(server => Array.isArray(server.urls) ? server.urls : [server.urls]);
    return urls.length ? urls.join(', ') : 'none';
}

async function copyDebugLogs() {
    const report = buildDebugLogReport();
    try {
        await navigator.clipboard.writeText(report);
        showToast('Protokoll in die Zwischenablage kopiert.', 'success');
    } catch (error) {
        const textarea = document.createElement('textarea');
        textarea.value = report;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand('copy');
        textarea.remove();
        showToast(
            copied ? 'Protokoll in die Zwischenablage kopiert.' : 'Kopieren fehlgeschlagen.',
            copied ? 'success' : 'error'
        );
    }
}

async function runConnectivityDiagnostics() {
    logDebug('--- ICE-Diagnose gestartet ---');
    logDebug(`Konfigurierte ICE-Server: ${summarizeIceServers()}`);

    const found = new Set();
    const probe = new RTCPeerConnection(rtcConfig);
    try {
        probe.createDataChannel('diagnostics');
        probe.onicecandidate = event => {
            if (!event.candidate) return;
            const type = event.candidate.type || 'unknown';
            if (!found.has(type)) {
                found.add(type);
                logDebug(`ICE-Kandidat verfuegbar: ${type} (${event.candidate.protocol || 'n/a'})`);
            }
        };
        await probe.setLocalDescription(await probe.createOffer());
        await new Promise(resolve => {
            const timeout = setTimeout(resolve, 8000);
            probe.onicegatheringstatechange = () => {
                if (probe.iceGatheringState === 'complete') {
                    clearTimeout(timeout);
                    resolve();
                }
            };
        });

        if (!found.size) {
            logDebug('ERGEBNIS: Keine ICE-Kandidaten. Netzwerk blockiert UDP/TCP vollstaendig.');
            showToast('Keine ICE-Kandidaten gefunden.', 'error');
        } else if (!found.has('relay')) {
            logDebug(`ERGEBNIS: Keine relay-Kandidaten. TURN liefert keine Allocation (gefunden: ${[...found].join(', ')}).`);
            showToast('TURN liefert keine relay-Kandidaten.', 'error');
        } else {
            logDebug(`ERGEBNIS: TURN funktioniert, relay-Kandidaten vorhanden (gefunden: ${[...found].join(', ')}).`);
            showToast('TURN liefert relay-Kandidaten.', 'success');
        }
    } catch (error) {
        logDebug(`ICE-Diagnose fehlgeschlagen: ${error.message}`);
        showToast(`ICE-Diagnose fehlgeschlagen: ${error.message}`, 'error');
    } finally {
        probe.close();
        logDebug('--- ICE-Diagnose beendet ---');
    }
}

function updateDebugButtonState() {
    document.documentElement.classList.toggle('debug-on', CONFIG.DEBUG_MODE);
    const button = document.getElementById('toggle-debug-btn');
    const status = document.getElementById('debug-status-text');
    if (!button || !status) return;

    button.setAttribute('aria-checked', String(CONFIG.DEBUG_MODE));
    status.textContent = CONFIG.DEBUG_MODE ? 'AN' : 'AUS';
    status.classList.toggle('is-on', CONFIG.DEBUG_MODE);
}

function renderBlockedPeers() {
    const container = document.getElementById('blocked-peers-list');
    if (!container) return;
    container.innerHTML = '';
    const blockedIds = Object.values(state.chatControls).filter(c => c.blockedAt).map(c => c.peerId);

    if (blockedIds.length === 0) {
        container.innerHTML = '<div class="text-xs text-slate-500 italic">Keine Peers blockiert.</div>';
        return;
    }
    blockedIds.forEach(peerId => {
        const peer = getPeerPresentation(peerId);
        const row = document.createElement('div');
        row.className = 'flex items-center justify-between bg-slate-950 p-2 rounded border border-slate-800';
        const nameDiv = document.createElement('div');
        nameDiv.className = 'text-xs text-slate-300 font-semibold truncate';
        nameDiv.textContent = peer.name || peerId;
        const unblockBtn = document.createElement('button');
        unblockBtn.className = 'text-[10px] bg-slate-800 hover:bg-slate-700 text-slate-300 px-2 py-1 rounded transition';
        unblockBtn.textContent = 'Entblocken';
        unblockBtn.onclick = () => unblockPeerFromSettings(peerId);
        row.append(nameDiv, unblockBtn);
        container.appendChild(row);
    });
}

async function unblockPeerFromSettings(peerId) {
    try {
        const response = await fetch(`${API_BASE}/api/chat-controls/${encodeURIComponent(state.myProfile.id)}/${encodeURIComponent(peerId)}/block`, {
            method: 'DELETE',
            headers: peerAuthHeaders()
        });
        if (!response.ok) throw new Error(`API returned ${response.status}.`);
        await refreshChatControls();
        subscribePresence();
        const operation = { operationId: `unhide:${window.crypto.randomUUID()}`, type: 'PEER_UNHIDE', actorId: state.myProfile.id, createdAt: Date.now() };
        sendSecurePayload(peerId, { type: 'CHAT_OPERATION', operation }).catch(()=>{});
        showToast('Peer wurde entblockt.', 'success');
    } catch (error) { showToast(`Fehler: ${error.message}`, 'error'); }
}

function toggleDebugMode() {
    CONFIG.DEBUG_MODE = !CONFIG.DEBUG_MODE;
    try {
        window.localStorage.setItem(DEBUG_MODE_STORAGE_KEY, CONFIG.DEBUG_MODE ? 'on' : 'off');
    } catch {
        // Ohne localStorage gilt die Einstellung nur fuer diese Sitzung.
    }
    updateDebugButtonState();

    if (CONFIG.DEBUG_MODE) {
        switchTab('keys');
        closeMenu();
        logDebug('Debug logging enabled.');
    } else {
        console.info('[OpenGrid] Debug logging disabled.');
    }
}

async function generateUserIdentityKeys(showNotification = false) {
    const fingerprintOutput = document.getElementById('inspect-pubkey-fingerprint');
    const regenerateButton = document.getElementById('regenerate-key-btn');
    if (regenerateButton) regenerateButton.disabled = true;
    if (fingerprintOutput) fingerprintOutput.textContent = 'Generating...';

    try {
        const storedIdentity = !showNotification && db
            ? await databaseRequest('keys', 'readonly', store => store.get('identity-key'))
            : null;
        const keyPair = storedIdentity?.privateKey && storedIdentity?.publicKey
            ? {
                privateKey: storedIdentity.privateKey,
                publicKey: storedIdentity.publicKey
            }
            : await window.crypto.subtle.generateKey(
                { name: 'ECDH', namedCurve: 'P-256' },
                false,
                ['deriveKey', 'deriveBits']
            );

        let ecdsaKeyPair;
        let jwkEcdsaPublic;
        if (storedIdentity?.ecdsaPrivateKey && storedIdentity?.ecdsaPublicKey && storedIdentity?.jwkEcdsaPublic) {
            ecdsaKeyPair = { privateKey: storedIdentity.ecdsaPrivateKey, publicKey: storedIdentity.ecdsaPublicKey };
            jwkEcdsaPublic = storedIdentity.jwkEcdsaPublic;
        } else {
            ecdsaKeyPair = await window.crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
            jwkEcdsaPublic = await window.crypto.subtle.exportKey('jwk', ecdsaKeyPair.publicKey);
        }

        const [publicKeySpki, jwkPublic] = await Promise.all([
            window.crypto.subtle.exportKey('spki', keyPair.publicKey),
            window.crypto.subtle.exportKey('jwk', keyPair.publicKey)
        ]);

        // Immer in DB sichern/aktualisieren, falls ECDSA-Schlüssel fehlten
        if (db) {
            await putDatabaseRecord('keys', {
                id: 'identity-key',
                privateKey: keyPair.privateKey,
                publicKey: keyPair.publicKey,
                jwkPublic,
                ecdsaPrivateKey: ecdsaKeyPair.privateKey,
                ecdsaPublicKey: ecdsaKeyPair.publicKey,
                jwkEcdsaPublic
            });
        }
        const digest = await window.crypto.subtle.digest('SHA-256', publicKeySpki);
        const fingerprint = Array.from(
            new Uint8Array(digest),
            byte => byte.toString(16).padStart(2, '0')
        ).join(':');

        state.myKeys = { keyPair, jwkPublic, fingerprint, ecdsaKeyPair, jwkEcdsaPublic };
        if (fingerprintOutput) fingerprintOutput.textContent = fingerprint;
        logDebug(storedIdentity
            ? 'Persistent ECDH P-256 identity keypair loaded.'
            : 'New persistent ECDH P-256 identity keypair generated.');

        if (state.ws?.readyState === WebSocket.OPEN) {
            await registerWithWorkerGrid();
        }
        if (showNotification) showToast('New E2EE identity keypair generated.', 'success');
    } catch (error) {
        console.error('Identity key generation failed.', error);
        if (fingerprintOutput) fingerprintOutput.textContent = 'Key generation failed';
        showDebugToast('E2EE key generation failed.', 'error');
    } finally {
        if (regenerateButton) regenerateButton.disabled = false;
    }
}

function logData(msg) { console.log(msg); }
function logDebug(msg) {
    if (!CONFIG.DEBUG_MODE) return;
    console.debug(`[OpenGrid] ${msg}`);
    state.debugLogBuffer.push(`[${new Date().toISOString()}] ${msg}`);
    if (state.debugLogBuffer.length > 2000) state.debugLogBuffer.shift();
    const out = document.getElementById('debug-log-output');
    if (out) {
        const entry = document.createElement('div');
        entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
        out.appendChild(entry);
        out.scrollTop = out.scrollHeight;
    }
}
function showToast(msg, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const styles = {
        info: { icon: 'fa-info-circle text-sky-400', border: 'border-sky-500/40' },
        success: { icon: 'fa-check-circle text-emerald-400', border: 'border-emerald-500/40' },
        error: { icon: 'fa-exclamation-triangle text-red-400', border: 'border-red-500/40' },
        warning: { icon: 'fa-exclamation-circle text-amber-400', border: 'border-amber-500/40' }
    };
    const style = styles[type] || styles.info;
    const toast = document.createElement('div');
    toast.className = `bg-slate-900 border ${style.border} text-slate-200 p-3 rounded-xl shadow-xl text-xs flex items-center gap-2 transition-opacity duration-300`;

    const icon = document.createElement('i');
    icon.className = `fa-solid ${style.icon}`;
    const text = document.createElement('span');
    text.textContent = msg;
    toast.append(icon, text);
    container.appendChild(toast);
    setTimeout(() => {
        toast.classList.add('opacity-0');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// Technische Hinweise (Verbindung, Cache, Schluessel) nur im Debug-Modus als Toast zeigen.
function showDebugToast(msg, type = 'info') {
    logDebug(msg);
    if (CONFIG.DEBUG_MODE) showToast(msg, type);
}

function switchTab(tabName) {
    ['grid', 'chat', 'editprofile', 'cloud', 'keys'].forEach(t => {
        const view = document.getElementById(`view-${t}`);
        if (view) view.classList.toggle('hidden', t !== tabName);
    });
    // Desktop-Navigation oben und Bottom-Navigation auf Smartphones tragen dieselben data-tab-btn-Werte.
    document.querySelectorAll('[data-tab-btn]').forEach(button => {
        const active = button.dataset.tabBtn === tabName;
        button.classList.toggle('is-active', active);
        if (active) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
    });
    window.scrollTo(0, 0);
    syncRoute(tabName);
    syncChatFocus();
}

function openMenu() {
    document.getElementById('app-menu').classList.add('is-open');
    document.getElementById('app-menu').setAttribute('aria-hidden', 'false');
    document.getElementById('app-menu-backdrop').classList.remove('hidden');
    pushModalEntry('menu', hideMenu);
}

function closeMenu() {
    if (!document.getElementById('app-menu').classList.contains('is-open')) return;
    dismissModalEntry('menu', hideMenu);
}

function hideMenu() {
    document.getElementById('app-menu').classList.remove('is-open');
    document.getElementById('app-menu').setAttribute('aria-hidden', 'true');
    document.getElementById('app-menu-backdrop').classList.add('hidden');
}

// ================= SICHTBARKEIT & SPEICHER =================
const GRID_SETTINGS_RECORD_ID = 'grid-settings';
const GRID_TTL_OPTIONS = [1, 10, 30, 60];

async function loadGridSettings() {
    try {
        const stored = await databaseRequest('keys', 'readonly', store => store.get(GRID_SETTINGS_RECORD_ID));
        if (stored) {
            state.gridSettings = {
                silent: stored.silent === true,
                ttlMinutes: GRID_TTL_OPTIONS.includes(stored.ttlMinutes) ? stored.ttlMinutes : 10,
                liveGrid: stored.liveGrid === true,
                cacheEnabled: stored.cacheEnabled !== false,
                useLocation: stored.useLocation === true,
                safeZones: Array.isArray(stored.safeZones) ? stored.safeZones.filter(zone => typeof zone === 'string') : [],
                locationLabel: typeof stored.locationLabel === 'string' ? stored.locationLabel : null
            };
        }
    } catch (error) {
        logDebug(`Could not load grid settings: ${error.message}`);
    }
    renderGridSettings();
    if (state.gridSettings.useLocation) await updateDeviceLocation(false);
}

function isEffectivelySilent() {
    return state.gridSettings.silent || state.gridSettings.safeZones.includes(state.myProfile.geohash);
}

function getDevicePosition() {
    return new Promise((resolve, reject) => {
        if (!navigator.geolocation) {
            reject(new Error('Geolocation is not supported'));
            return;
        }
        navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: false,
            maximumAge: 10 * 60 * 1000,
            timeout: 10000
        });
    });
}

// Der genaue Standort verlaesst das Geraet nie; gespeichert und gesendet wird nur die Zelle.
async function updateDeviceLocation(notify = true) {
    let geohash;
    try {
        const position = await getDevicePosition();
        geohash = encodeGeohash(position.coords.latitude, position.coords.longitude, GRID_PRECISION);
    } catch (error) {
        logDebug(`Geolocation failed: ${error.message}`);
        if (notify) showToast('Standort nicht verfuegbar oder nicht erlaubt.', 'warning');
        return false;
    }
    await applyLocationCell(geohash);
    return true;
}

async function applyLocationCell(geohash) {
    if (geohash === state.myProfile.geohash) return;
    state.myProfile.geohash = geohash;
    state.gridRing = 0;
    await cacheOwnProfile().catch(error => logDebug(`Could not store location cell: ${error.message}`));
    renderGridSettings();
}

// Alternative zum Geraetestandort: Adresse wird nur auf ausdruecklichen Klick an
// OpenStreetMap Nominatim gesendet (Entscheidung 2026-10-23). Der Router sieht weiterhin nur die Zelle.
const GEOCODER_URL = 'https://nominatim.openstreetmap.org/search';

async function searchAddressLocation() {
    const input = document.getElementById('address-input');
    const query = input?.value.trim();
    if (!query) return;
    const button = document.getElementById('address-search-btn');
    if (button) button.disabled = true;
    try {
        const params = new URLSearchParams({ q: query, format: 'jsonv2', limit: '1' });
        const response = await fetch(`${GEOCODER_URL}?${params}`, {
            headers: { 'Accept-Language': navigator.language || 'de' },
            referrerPolicy: 'no-referrer'
        });
        if (!response.ok) throw new Error(`Geocoder returned ${response.status}`);
        const [result] = await response.json();
        const latitude = Number(result?.lat);
        const longitude = Number(result?.lon);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
            showToast('Adresse nicht gefunden.', 'warning');
            return;
        }
        const geohash = encodeGeohash(latitude, longitude, GRID_PRECISION);
        input.value = '';
        await applyLocationCell(geohash);
        await updateGridSetting('locationLabel', result.display_name ? String(result.display_name).substring(0, 200) : query);
        if (state.gridSettings.useLocation) await updateGridSetting('useLocation', false);
        showToast('Standort aus Adresse uebernommen.', 'success');
    } catch (error) {
        logDebug(`Address lookup failed: ${error.message}`);
        showToast('Adresssuche fehlgeschlagen.', 'error');
    } finally {
        if (button) button.disabled = false;
    }
}

async function addCurrentSafeZone() {
    if (!state.gridSettings.useLocation) {
        showToast('Bitte zuerst den Geraetestandort aktivieren.', 'warning');
        return;
    }
    if (!await updateDeviceLocation()) return;
    if (state.gridSettings.safeZones.includes(state.myProfile.geohash)) return;
    await updateGridSetting('safeZones', [...state.gridSettings.safeZones, state.myProfile.geohash]);
}

async function removeSafeZone(geohash) {
    await updateGridSetting('safeZones', state.gridSettings.safeZones.filter(zone => zone !== geohash));
}

function renderSafeZones() {
    const list = document.getElementById('safe-zone-list');
    if (!list) return;
    list.innerHTML = '';
    state.gridSettings.safeZones.forEach((zone, index) => {
        const item = document.createElement('li');
        item.className = 'flex items-center justify-between gap-2 text-xs bg-slate-950/60 border border-slate-800 rounded-lg px-2 py-1';
        const label = document.createElement('span');
        label.textContent = zone === state.myProfile.geohash ? `Zone ${index + 1} (hier)` : `Zone ${index + 1}`;
        const code = document.createElement('span');
        code.className = 'debug-only font-mono text-slate-500';
        code.textContent = zone;
        label.appendChild(code);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'text-red-400 hover:text-red-300';
        remove.textContent = 'Entfernen';
        remove.onclick = () => removeSafeZone(zone);
        item.append(label, remove);
        list.appendChild(item);
    });
}

function renderGridSettings() {
    const settings = state.gridSettings;
    const silent = document.getElementById('silent-mode-toggle');
    const ttl = document.getElementById('grid-ttl-select');
    const live = document.getElementById('live-grid-toggle');
    const cache = document.getElementById('cache-enabled-toggle');
    if (silent) silent.checked = settings.silent;
    if (ttl) ttl.value = String(settings.ttlMinutes);
    if (live) live.checked = settings.liveGrid;
    if (cache) cache.checked = settings.cacheEnabled;
    const location = document.getElementById('use-location-toggle');
    if (location) location.checked = settings.useLocation;
    document.getElementById('use-location-btn')?.classList.toggle('hidden', settings.useLocation);
    const locationLabel = document.getElementById('location-label');
    if (locationLabel) {
        locationLabel.textContent = settings.useLocation
            ? 'Aktuell: Geraetestandort'
            : settings.locationLabel ? `Aktuell: ${settings.locationLabel}` : 'Aktuell: kein Standort gesetzt';
    }
    const hint = document.getElementById('silent-mode-hint');
    if (hint) {
        hint.classList.toggle('hidden', !isEffectivelySilent());
        hint.lastChild.textContent = settings.silent
            ? ' Silent-Modus aktiv: du bist fuer andere nicht im Grid sichtbar.'
            : ' Safe Zone: hier bist du fuer andere nicht im Grid sichtbar.';
    }
    renderSafeZones();
}

async function updateGridSetting(key, value) {
    const previous = state.gridSettings;
    state.gridSettings = { ...previous, [key]: value };
    try {
        await putDatabaseRecord('keys', { id: GRID_SETTINGS_RECORD_ID, ...state.gridSettings });
    } catch (error) {
        state.gridSettings = previous;
        logDebug(`Could not store grid settings: ${error.message}`);
        showToast('Einstellung konnte nicht gespeichert werden.', 'error');
        renderGridSettings();
        return;
    }
    renderGridSettings();
    if (key === 'useLocation' && value && !await updateDeviceLocation()) {
        await updateGridSetting('useLocation', false);
        return;
    }
    // Silent-Modus, TTL, Standort und Safe Zones aendern den Router-Eintrag; Live-Modus nur die Grid-Abfrage, der Cache nur den Versand.
    if (key === 'cacheEnabled') return;
    if (key === 'liveGrid') await fetchPeersFromWorkerGrid();
    else await refreshPresenceAndGrid();
}

// ================= DARSTELLUNG =================
function setChatFontSize(size) {
    if (!CHAT_FONT_SIZES[size]) return;
    try {
        window.localStorage.setItem(CHAT_FONT_SIZE_STORAGE_KEY, size);
    } catch {
        // Ohne localStorage gilt die Einstellung nur fuer diese Sitzung.
    }
    applyChatFontSize(size);
}

function renderAppearanceSettings() {
    const select = document.getElementById('chat-font-size-select');
    if (select) select.value = loadChatFontSize();
}
