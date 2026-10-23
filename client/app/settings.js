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
        closeMenu();
        switchTab('keys');
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
    syncChatFocus();
}

function openMenu() {
    document.getElementById('app-menu').classList.add('is-open');
    document.getElementById('app-menu').setAttribute('aria-hidden', 'false');
    document.getElementById('app-menu-backdrop').classList.remove('hidden');
}

function closeMenu() {
    document.getElementById('app-menu').classList.remove('is-open');
    document.getElementById('app-menu').setAttribute('aria-hidden', 'true');
    document.getElementById('app-menu-backdrop').classList.add('hidden');
}
