// ================= NACHWEISE (Board T2) =================
// Verlangt der Router einen Alters- oder E-Mail-Nachweis (AGE_CHECK, EMAIL_CHECK; standardmaessig aus),
// bleibt man bis dahin unsichtbar und bekommt kein Grid. Dieses Fenster fuehrt durch die Nachweise.
// Der Router speichert nur den Status; Ausweis- oder Gesichtsdaten gibt es hier nie.

function safetyConfig() {
    return state.appConfig?.safety || { ageCheck: 'off', ageProvider: null, emailCheck: 'off' };
}

function isSafetyGateActive() {
    const config = safetyConfig();
    return config.ageCheck !== 'off' || config.emailCheck === 'required';
}

async function safetyRequest(path, body) {
    const response = await fetch(`${API_BASE}/api/safety/${path}`, body
        ? { method: 'POST', headers: peerAuthHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ peerId: state.myProfile.id, ...body }) }
        : { cache: 'no-store', headers: peerAuthHeaders() });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(data.error || `HTTP ${response.status}`);
        error.status = response.status;
        throw error;
    }
    return data;
}

async function refreshSafetyStatus() {
    if (!isSafetyGateActive() || !state.routerAuthToken) {
        state.verificationRequired = [];
        renderSafetyCard();
        return state.verificationRequired;
    }
    try {
        const status = await safetyRequest(`status?peerId=${encodeURIComponent(state.myProfile.id)}`);
        state.verificationRequired = ['age', 'email'].filter(kind => status[kind]?.required && !status[kind]?.verified);
        // Altersgruppe laut Nachweis (Pflicht-Scan fuer unter 18, nudity.js).
        state.ageGroup = ['adult', 'minor'].includes(status.age?.group) ? status.age.group : null;
        if (typeof renderNuditySettings === 'function') renderNuditySettings();
    } catch (error) {
        logDebug(`Could not load verification status: ${error.message}`);
    }
    renderSafetyCard();
    return state.verificationRequired;
}

// Nach der Registrierung oder einer 403-Antwort des Grids.
function handleVerificationRequired(kinds) {
    state.verificationRequired = Array.isArray(kinds) ? kinds.filter(kind => kind === 'age' || kind === 'email') : [];
    renderSafetyCard();
    if (state.verificationRequired.length && !state.safetyGateDismissed) openSafetyGate();
}

function renderSafetyCard() {
    const card = document.getElementById('safety-card');
    if (!card) return;
    card.classList.toggle('hidden', !isSafetyGateActive());
    const missing = state.verificationRequired || [];
    const status = document.getElementById('safety-card-status');
    if (status) status.textContent = missing.length ? t('safety.verificationMissing') : t('safety.allVerified');
    document.getElementById('safety-card-btn')?.classList.toggle('hidden', !missing.length);
}

function openSafetyGate() {
    const modal = document.getElementById('safety-modal');
    if (!modal) return;
    const config = safetyConfig();
    const missing = state.verificationRequired || [];
    document.getElementById('safety-age-confirm')?.classList.toggle('hidden', !(missing.includes('age') && config.ageCheck === 'confirm'));
    document.getElementById('safety-age-provider')?.classList.toggle('hidden', !(missing.includes('age') && config.ageCheck === 'provider'));
    document.getElementById('safety-email')?.classList.toggle('hidden', !missing.includes('email'));
    document.getElementById('safety-email-code-row')?.classList.add('hidden');
    modal.classList.remove('hidden');
}

function closeSafetyGate() {
    state.safetyGateDismissed = true;
    document.getElementById('safety-modal')?.classList.add('hidden');
}

function reopenSafetyGate() {
    state.safetyGateDismissed = false;
    openSafetyGate();
}

async function afterVerificationStep(message) {
    showToast(message, 'success');
    const missing = await refreshSafetyStatus();
    if (missing.length) {
        openSafetyGate();
        return;
    }
    document.getElementById('safety-modal')?.classList.add('hidden');
    // Neu registrieren: jetzt sichtbar und mit Grid.
    if (typeof refreshPresenceAndGrid === 'function') await refreshPresenceAndGrid();
}

function showSafetyError(error) {
    const messages = { 403: t('safety.notAccepted'), 410: t('safety.codeExpired'), 503: t('safety.unavailable') };
    showToast(messages[error.status] || t('safety.failed'), 'error');
}

async function confirmAgeSelf() {
    if (!document.getElementById('safety-age-checkbox')?.checked) {
        showToast(t('safety.tickTheBoxFirst'), 'warning');
        return;
    }
    try {
        await safetyRequest('age/confirm', { over18: true });
        await afterVerificationStep(t('safety.ageConfirmed'));
    } catch (error) {
        showSafetyError(error);
    }
}

// Anbieter-Nachweis. `dev` (nur Test) bestaetigt sofort; `eudi` fragt die Wallet ueber die Digital
// Credentials API (server/age-eudi.js); `oidc` leitet zum Pruefdienst weiter (kind: 'redirect',
// server/age-oidc.js), der Dienst schickt zurueck auf /age-callback (finishPendingAgeCallback).
async function startAgeProviderCheck() {
    try {
        const start = await safetyRequest('age/start', {});
        if (start.kind === 'dev') {
            await safetyRequest('age/finish', { payload: { over18: true } });
            await afterVerificationStep(t('safety.ageConfirmed'));
        } else if (start.kind === 'eudi') {
            await presentEudiCredential(start);
        } else if (start.kind === 'redirect' && /^https:\/\//.test(start.url || '')) {
            window.location.assign(start.url);
        } else {
            showToast(t('safety.unavailable'), 'error');
        }
    } catch (error) {
        showSafetyError(error);
    }
}

// Rueckkehr vom Pruefdienst: code + state an den Router (der prueft das Token und speichert nur die
// Altersgruppe). Erst wenn die Anmeldung beim Router steht.
async function finishPendingAgeCallback() {
    const callback = state.pendingAgeCallback;
    state.pendingAgeCallback = null;
    const startedAt = Date.now();
    while (!state.routerAuthToken && Date.now() - startedAt < 15000) {
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!callback?.code || !callback?.state) {
        showToast(callback?.error === 'access_denied' ? t('safety.providerCancelled') : t('safety.failed'), 'warning');
        return;
    }
    try {
        const result = await safetyRequest('age/finish', { payload: { code: callback.code, state: callback.state } });
        await afterVerificationStep(result.group === 'minor' ? t('safety.ageMinorConfirmed') : t('safety.ageConfirmed'));
    } catch (error) {
        showSafetyError(error);
    }
}

// EU-Altersnachweis: der Browser zeigt die passenden Wallets, der Nutzer gibt nur "ueber 18" frei.
// Chrome/Edge ab 141, Safari ab 26; ohne Unterstuetzung ein Hinweis statt eines Fehlers.
function digitalCredentialsSupported() {
    return typeof window.DigitalCredential === 'function' && typeof navigator.credentials?.get === 'function';
}

async function presentEudiCredential(start) {
    if (!digitalCredentialsSupported()) {
        showToast(t('safety.walletUnsupported'), 'warning');
        return;
    }
    let credential;
    try {
        credential = await navigator.credentials.get({
            mediation: 'required',
            digital: { requests: [{ protocol: start.protocol, data: start.request }] }
        });
    } catch (error) {
        logDebug(`Wallet request ended: ${error.name} ${error.message}`);
        showToast(['NotAllowedError', 'AbortError'].includes(error.name) ? t('safety.walletCancelled') : t('safety.walletFailed'), 'warning');
        return;
    }
    if (!credential?.data) {
        showToast(t('safety.walletCancelled'), 'warning');
        return;
    }
    await safetyRequest('age/finish', { payload: { protocol: credential.protocol, data: credential.data } });
    await afterVerificationStep(t('safety.ageConfirmed'));
}

// ----- Testseite (Debug-Modus): Wallet-Nachweis pruefen, ohne etwas freizuschalten -----
function renderAgeTestSupport() {
    const line = document.getElementById('age-test-support');
    if (line) line.textContent = digitalCredentialsSupported() ? t('safety.walletTestSupported') : t('safety.walletUnsupported');
}

async function testEudiWallet() {
    const output = document.getElementById('age-test-result');
    const show = text => {
        if (!output) return;
        output.textContent = text;
        output.classList.remove('hidden');
    };
    renderAgeTestSupport();
    if (!digitalCredentialsSupported()) return;
    try {
        show(t('safety.walletTestAsking'));
        const start = await safetyRequest('age-test/start', {});
        let credential;
        try {
            credential = await navigator.credentials.get({
                mediation: 'required',
                digital: { requests: [{ protocol: start.protocol, data: start.request }] }
            });
        } catch (error) {
            show(`${t('safety.walletCancelled')}\n${error.name}: ${error.message}`);
            return;
        }
        const result = await safetyRequest('age-test/finish', { payload: { protocol: credential?.protocol, data: credential?.data } });
        show([
            result.over18 ? t('safety.walletTestPassed') : result.minor ? t('safety.walletTestMinor') : t('safety.walletTestFailed', { reason: result.reason || '?' }),
            JSON.stringify(result.details || {}, null, 2)
        ].join('\n'));
    } catch (error) {
        show(t('safety.walletTestFailed', { reason: error.message }));
    }
}

async function sendEmailCode() {
    const email = document.getElementById('safety-email-input')?.value.trim();
    if (!email) return;
    try {
        await safetyRequest('email/start', { email });
        document.getElementById('safety-email-code-row')?.classList.remove('hidden');
        document.getElementById('safety-email-code')?.focus();
        showToast(t('safety.codeSent'), 'info');
    } catch (error) {
        showSafetyError(error);
    }
}

async function confirmEmailCode() {
    const code = document.getElementById('safety-email-code')?.value.trim();
    if (!/^\d{6}$/.test(code || '')) {
        showToast(t('safety.enterSixDigitCode'), 'warning');
        return;
    }
    try {
        await safetyRequest('email/confirm', { code });
        await afterVerificationStep(t('safety.emailConfirmed'));
    } catch (error) {
        showSafetyError(error);
    }
}
