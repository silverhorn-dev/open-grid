// ================= ABSCHALTBARE TEILE (Feature-Module) =================
// Was der Router ausgeschaltet hat, liefert er nicht aus: weder Skript noch Oberflaeche (server/app.js,
// Marker <!-- feature:<name> --> in index.html). Damit der Rest der App ohne diese Teile laeuft, stehen
// hier neutrale Platzhalter; das echte Modul (spaeter geladen) ersetzt sie.
//   nudity  -> nudity.js, nudity-model.js (Nacktbild-Filter, NUDITY_MODEL != off)
//   safety  -> safety.js (Alters-/E-Mail-Nachweis, AGE_CHECK/EMAIL_CHECK != off)
//   agetest -> age-test.js (Testseite Wallet-Nachweis, AGE_EUDI_TEST)
const FEATURE_SCRIPTS = {
    nudity: ['app/nudity.js', 'app/nudity-model.js'],
    safety: ['app/safety.js'],
    agetest: ['app/age-test.js']
};
const FEATURE_ASSET_VERSION = (document.currentScript?.src.match(/[?&]v=([^&]+)/) || [])[1] || '';

// ----- Platzhalter: Nacktbild-Filter aus = nichts pruefen, nichts unscharf -----
function outgoingNudityScanFlag() { return false; }
function markForcedNudityScan() {}
async function loadNuditySettings() {}
function renderNuditySettings() {}
async function shouldBlurImage() { return false; }
function drawBlurredImage() {}
function revealBlurredImage() { return false; }
async function confirmNudeSend() { return true; }
function initNudityModel() {}
function warmUpNudityModel() {}

// ----- Platzhalter: keine Nachweise verlangt -----
function isSafetyGateActive() { return false; }
function renderSafetyCard() {}
async function finishPendingAgeCallback() {}
// Verlangt der Router doch einen Nachweis (gerade eingeschaltet), das Modul nachladen und weitergeben.
function handleVerificationRequired(kinds) {
    if (!Array.isArray(kinds) || !kinds.length) return;
    const placeholder = window.handleVerificationRequired;
    loadFeatureScripts(['safety']).then(() => {
        if (window.handleVerificationRequired !== placeholder) window.handleVerificationRequired(kinds);
    }).catch(error => logDebug(`Safety module failed: ${error.message}`));
}

function featureLoaded(name) {
    return FEATURE_SCRIPTS[name].every(file => document.querySelector(`script[src^="/client/${file}"]`));
}

function loadScript(file) {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = `/client/${file}?v=${FEATURE_ASSET_VERSION}`;
        script.onload = resolve;
        script.onerror = () => reject(new Error(`Could not load ${file}`));
        document.body.append(script);
    });
}

// Fehlende Module nachladen (z. B. App-Shell aus dem Cache, waehrenddessen im Admin-Panel eingeschaltet).
// Ohne die Oberflaeche aus index.html wirken sie bis zum naechsten Laden nur im Hintergrund.
async function loadFeatureScripts(names) {
    for (const name of names) {
        if (!FEATURE_SCRIPTS[name] || featureLoaded(name)) continue;
        for (const file of FEATURE_SCRIPTS[name]) {
            if (!document.querySelector(`script[src^="/client/${file}"]`)) await loadScript(file);
        }
    }
}

async function loadEnabledFeatures() {
    const features = Array.isArray(state.appConfig?.features) ? state.appConfig.features : [];
    await loadFeatureScripts(features.filter(name => FEATURE_SCRIPTS[name]));
}
