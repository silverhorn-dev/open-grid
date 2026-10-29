// ================= NACKTBILD-FILTER (Board T3) =================
// Eingehende Bilder (Chat, Snaps, Alben) werden nach dem Entschluesseln lokal geprueft; wirkt ein Bild
// wie ein Nacktbild, erscheint es unscharf mit "Tippen zum Ansehen". Das Bild verlaesst das Geraet nie,
// der Server erfaehrt nichts. Standard: aus (CLIENT_DEFAULTS.nudityFilter).
//
// Das Erkennungsmodell ist austauschbar und noch nicht enthalten: registerNudityClassifier() nimmt
// { id, classify(bitmap) -> Promise<number 0..1> } entgegen. Ohne Modell bleibt der Filter wirkungslos
// und die Einstellung sagt das. Kein Schutz gegen veraenderte Clients, nur fuer den Empfaenger.
const NUDITY_SETTINGS_RECORD_ID = 'nudity-settings';
const NUDITY_THRESHOLD = 0.7;
const NUDITY_CACHE_LIMIT = 200;
const nudityClassifiers = [];
const nudityScores = new Map();
const revealedNudityImages = new Set();
const nudityRevealHandlers = new WeakSet();

function registerNudityClassifier(classifier) {
    if (!classifier || typeof classifier.classify !== 'function') return false;
    nudityClassifiers.push(classifier);
    nudityScores.clear();
    renderNuditySettings();
    return true;
}

function hasNudityClassifier() {
    return nudityClassifiers.length > 0;
}

function isNudityFilterActive() {
    return state.nudityFilter === true && hasNudityClassifier();
}

async function loadNuditySettings() {
    const stored = await databaseRequest('keys', 'readonly', store => store.get(NUDITY_SETTINGS_RECORD_ID)).catch(() => null);
    state.nudityFilter = stored ? stored.enabled === true : clientDefault('nudityFilter', false) === true;
    renderNuditySettings();
}

async function updateNudityFilter(enabled) {
    state.nudityFilter = enabled === true;
    try {
        await putDatabaseRecord('keys', { id: NUDITY_SETTINGS_RECORD_ID, enabled: state.nudityFilter });
    } catch (error) {
        logDebug(`Could not store nudity settings: ${error.message}`);
        showToast(t('common.settingCouldNotBeSaved'), 'error');
    }
    renderNuditySettings();
}

function renderNuditySettings() {
    const toggle = document.getElementById('nudity-filter-toggle');
    if (toggle) toggle.checked = state.nudityFilter === true;
    document.getElementById('nudity-filter-no-model')?.classList.toggle('hidden', hasNudityClassifier());
}

// Hoechster Wert aller Modelle, je Quelle gemerkt (Data-URL oder Blob).
async function nudityScore(bitmap, source) {
    if (nudityScores.has(source)) return nudityScores.get(source);
    let score = 0;
    for (const classifier of nudityClassifiers) {
        try {
            const value = Number(await classifier.classify(bitmap));
            if (Number.isFinite(value)) score = Math.max(score, Math.min(1, Math.max(0, value)));
        } catch (error) {
            logDebug(`Nudity classifier ${classifier.id || '?'} failed: ${error.message}`);
        }
    }
    if (nudityScores.size >= NUDITY_CACHE_LIMIT) nudityScores.delete(nudityScores.keys().next().value);
    nudityScores.set(source, score);
    return score;
}

async function shouldBlurImage(bitmap, source) {
    if (!isNudityFilterActive() || revealedNudityImages.has(source)) return false;
    // Schwelle vom Router (NUDITY_THRESHOLD), sonst 0,7.
    return await nudityScore(bitmap, source) >= (state.appConfig?.nudity?.threshold ?? NUDITY_THRESHOLD);
}

// Unscharf zeichnen, abdunkeln, Hinweis darauf. Ein Tippen zeigt das Bild (und dieselbe Quelle
// ueberall, z. B. danach im Viewer) und faengt den Klick ab, bevor er etwa den Viewer oeffnet.
function drawBlurredImage(canvas, bitmap, source, redraw) {
    const context = canvas.getContext('2d');
    const blur = Math.max(16, Math.round(Math.max(bitmap.width, bitmap.height) / 25));
    context.filter = `blur(${blur}px)`;
    context.drawImage(bitmap, 0, 0);
    context.filter = 'none';
    context.fillStyle = 'rgba(2, 6, 23, 0.55)';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#f1f5f9';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.font = `600 ${Math.max(14, Math.round(canvas.width / 18))}px sans-serif`;
    context.fillText(t('nudity.mightBeNude'), canvas.width / 2, canvas.height / 2 - canvas.width / 30);
    context.font = `${Math.max(12, Math.round(canvas.width / 24))}px sans-serif`;
    context.fillText(t('nudity.tapToView'), canvas.width / 2, canvas.height / 2 + canvas.width / 22);
    canvas.dataset.nudityBlurred = 'true';
    canvas.setAttribute('aria-label', t('nudity.mightBeNude'));
    if (nudityRevealHandlers.has(canvas)) return;
    nudityRevealHandlers.add(canvas);
    canvas.addEventListener('click', event => {
        if (canvas.dataset.nudityBlurred !== 'true') return;
        event.preventDefault();
        event.stopImmediatePropagation();
        revealedNudityImages.add(source);
        delete canvas.dataset.nudityBlurred;
        canvas.setAttribute('aria-label', t('common.image'));
        redraw();
    }, true);
}
