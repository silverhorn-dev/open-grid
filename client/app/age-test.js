// ================= TESTSEITE WALLET-ALTERSNACHWEIS (Debug-Modus) =================
// Fragt die Wallet wie beim echten Nachweis (server/age-eudi.js), schaltet aber nichts frei und speichert
// nichts. Nur ausgeliefert, wenn der Router die Testseite anbietet (AGE_EUDI_TEST, Feature "agetest").

function walletApiSupported() {
    return typeof window.DigitalCredential === 'function' && typeof navigator.credentials?.get === 'function';
}

async function ageTestRequest(path, body) {
    const response = await fetch(`${API_BASE}/api/safety/age-test/${path}`, {
        method: 'POST',
        headers: peerAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ peerId: state.myProfile.id, ...body })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
}

function renderAgeTestSupport() {
    const line = document.getElementById('age-test-support');
    if (line) line.textContent = walletApiSupported() ? t('safety.walletTestSupported') : t('safety.walletUnsupported');
}

async function testEudiWallet() {
    const output = document.getElementById('age-test-result');
    const show = text => {
        if (!output) return;
        output.textContent = text;
        output.classList.remove('hidden');
    };
    renderAgeTestSupport();
    if (!walletApiSupported()) return;
    try {
        show(t('safety.walletTestAsking'));
        const start = await ageTestRequest('start', {});
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
        const result = await ageTestRequest('finish', { payload: { protocol: credential?.protocol, data: credential?.data } });
        show([
            result.over18 ? t('safety.walletTestPassed') : result.minor ? t('safety.walletTestMinor') : t('safety.walletTestFailed', { reason: result.reason || '?' }),
            JSON.stringify(result.details || {}, null, 2)
        ].join('\n'));
    } catch (error) {
        show(t('safety.walletTestFailed', { reason: error.message }));
    }
}
