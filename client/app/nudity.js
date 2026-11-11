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
// Unscharf gezeichnete Canvas -> { source, redraw } (zum Aufdecken, auch von aussen: Snap-Viewer).
const blurredCanvases = new WeakMap();

function registerNudityClassifier(classifier) {
    if (!classifier || typeof classifier.classify !== 'function') return false;
    nudityClassifiers.push(classifier);
    nudityScores.clear();
    renderNuditySettings();
    bumpNudityRevision();
    return true;
}

// Stand des Filters (an/aus, Modelle). Aendert er sich, gelten schon gezeichnete Bilder als veraltet:
// secure-canvas.js nimmt dann keinen zwischengespeicherten Canvas mehr, der offene Chat zeichnet neu
// (z. B. Filter eingeschaltet: schon sichtbare Chat-Bilder werden jetzt geprueft).
function bumpNudityRevision() {
    state.nudityRevision = (state.nudityRevision || 0) + 1;
    if (state.activeChatPeerId && typeof renderChatHistory === 'function') renderChatHistory();
}

function hasNudityClassifier() {
    return nudityClassifiers.length > 0;
}

// Pflicht-Scan (Router: NUDITY_SCAN_REQUIRED): dann laesst sich der Filter nicht abschalten.
function nudityScanForced() {
    const mode = state.appConfig?.nudity?.required;
    if (mode === 'everyone') return true;
    if (mode === 'minors' || mode === 'minor-chats') return state.ageGroup === 'minor';
    return false;
}

// 'minor-chats': Bilder von unter 18 tragen in der (verschluesselten) Nachricht `nudityScan`; jeder
// Empfaenger prueft sie dann, auch mit abgeschaltetem Filter. Der Router erfaehrt davon nichts.
function outgoingNudityScanFlag() {
    return state.appConfig?.nudity?.required === 'minor-chats' && state.ageGroup === 'minor';
}

const forcedNudityScanSources = new Set();
const FORCED_SCAN_SOURCE_LIMIT = 500;
function markForcedNudityScan(source) {
    if (!source) return;
    if (forcedNudityScanSources.size >= FORCED_SCAN_SOURCE_LIMIT) forcedNudityScanSources.delete(forcedNudityScanSources.values().next().value);
    forcedNudityScanSources.add(source);
}

// Fuer Bilder, die nicht als Canvas gezeichnet werden (GIFs, gifs.js): pruefen noetig? Aufgedeckt merken.
function nudityCheckNeeded(source) {
    if (!source || revealedNudityImages.has(source)) return false;
    return isNudityFilterActive() || (forcedNudityScanSources.has(source) && hasNudityClassifier());
}

function markNudityRevealed(source) {
    if (source) revealedNudityImages.add(source);
}

function isNudityFilterActive() {
    return (state.nudityFilter === true || nudityScanForced()) && hasNudityClassifier();
}

async function loadNuditySettings() {
    const stored = await databaseRequest('keys', 'readonly', store => store.get(NUDITY_SETTINGS_RECORD_ID)).catch(() => null);
    state.nudityFilter = stored ? stored.enabled === true : clientDefault('nudityFilter', false) === true;
    // Warnung vor dem Senden: Standard an (Router: CLIENT_DEFAULTS.nudityWarnBeforeSend).
    state.nudityWarnBeforeSend = stored && 'warnBeforeSend' in stored ? stored.warnBeforeSend !== false : clientDefault('nudityWarnBeforeSend', true) !== false;
    renderNuditySettings();
    bumpNudityRevision();
}

async function saveNuditySettings() {
    try {
        await putDatabaseRecord('keys', { id: NUDITY_SETTINGS_RECORD_ID, enabled: state.nudityFilter, warnBeforeSend: state.nudityWarnBeforeSend });
    } catch (error) {
        logDebug(`Could not store nudity settings: ${error.message}`);
        showToast(t('common.settingCouldNotBeSaved'), 'error');
    }
    renderNuditySettings();
}

async function updateNudityFilter(enabled) {
    state.nudityFilter = enabled === true;
    await saveNuditySettings();
    bumpNudityRevision();
}

async function updateNudityWarnBeforeSend(enabled) {
    state.nudityWarnBeforeSend = enabled === true;
    await saveNuditySettings();
}

function renderNuditySettings() {
    const toggle = document.getElementById('nudity-filter-toggle');
    const forced = nudityScanForced();
    if (toggle) {
        toggle.checked = state.nudityFilter === true || forced;
        toggle.disabled = forced;
    }
    document.getElementById('nudity-filter-forced')?.classList.toggle('hidden', !forced);
    const warn = document.getElementById('nudity-warn-toggle');
    if (warn) warn.checked = state.nudityWarnBeforeSend !== false;
    document.getElementById('nudity-filter-no-model')?.classList.toggle('hidden', hasNudityClassifier());
}

// Hoechster Wert aller Modelle, je Quelle gemerkt (Data-URL oder Blob). null = kein Modell hat ein
// Ergebnis geliefert (Fehler, Frist): nicht merken, beim naechsten Anzeigen neu pruefen.
// Laufende Pruefungen je Quelle: zeichnet die Seite ein Bild neu, waehrend es noch geprueft wird, haengt
// sich der zweite Aufruf an die erste Pruefung an (sonst stand dasselbe Bild mehrfach in der Warteschlange).
const nudityChecksInFlight = new Map();

function nudityScore(bitmap, source) {
    if (nudityScores.has(source)) return Promise.resolve(nudityScores.get(source));
    if (source && nudityChecksInFlight.has(source)) return nudityChecksInFlight.get(source);
    const check = computeNudityScore(bitmap, source).finally(() => nudityChecksInFlight.delete(source));
    if (source) nudityChecksInFlight.set(source, check);
    return check;
}

// Letzter Fehler je Quelle (nur fuer den Debug-Hinweis auf dem unscharfen Bild).
const nudityCheckErrors = new Map();

async function computeNudityScore(bitmap, source) {
    let score = null;
    for (const classifier of nudityClassifiers) {
        try {
            const value = Number(await classifier.classify(bitmap));
            if (Number.isFinite(value)) score = Math.max(score ?? 0, Math.min(1, Math.max(0, value)));
        } catch (error) {
            logDebug(`Nudity classifier ${classifier.id || '?'} failed: ${error.message}`);
            if (source) nudityCheckErrors.set(source, error.message);
        }
    }
    if (score === null) return null;
    nudityCheckErrors.delete(source);
    if (nudityScores.size >= NUDITY_CACHE_LIMIT) nudityScores.delete(nudityScores.keys().next().value);
    nudityScores.set(source, score);
    return score;
}

// false = scharf zeigen; 'nude' = moegliches Nacktbild; 'unchecked' = Pruefung fehlgeschlagen. Bei
// eingeschaltetem Filter lieber unscharf als ungeprueft durchlassen (vorher galt ein Fehler als 0).
async function shouldBlurImage(bitmap, source) {
    const active = isNudityFilterActive() || (forcedNudityScanSources.has(source) && hasNudityClassifier());
    if (!active || revealedNudityImages.has(source)) return false;
    const score = await nudityScore(bitmap, source);
    if (score === null) return 'unchecked';
    // Schwelle vom Router (NUDITY_THRESHOLD), sonst 0,7.
    return score >= (state.appConfig?.nudity?.threshold ?? NUDITY_THRESHOLD) ? 'nude' : false;
}

// Unscharf zeichnen, abdunkeln, Hinweis darauf. Ein Tippen zeigt das Bild (und dieselbe Quelle
// ueberall, z. B. danach im Viewer) und faengt den Klick ab, bevor er etwa den Viewer oeffnet.
function drawBlurredImage(canvas, bitmap, source, redraw, reason = 'nude') {
    const label = reason === 'unchecked' ? t('nudity.notChecked') : t('nudity.mightBeNude');
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
    context.fillText(label, canvas.width / 2, canvas.height / 2 - canvas.width / 30);
    context.font = `${Math.max(12, Math.round(canvas.width / 24))}px sans-serif`;
    context.fillText(t('nudity.tapToView'), canvas.width / 2, canvas.height / 2 + canvas.width / 22);
    // Debug-Modus: Grund und Wert direkt auf dem Bild (zum Vergleich mit der Testseite).
    if (typeof CONFIG === 'object' && CONFIG.DEBUG_MODE) {
        const detail = reason === 'unchecked'
            ? nudityCheckErrors.get(source) || '?'
            : `${Math.round((nudityScores.get(source) ?? 0) * 100)} % / ${Math.round((state.appConfig?.nudity?.threshold ?? NUDITY_THRESHOLD) * 100)} % (${state.appConfig?.nudity?.model || '?'})`;
        context.font = `${Math.max(11, Math.round(canvas.width / 30))}px monospace`;
        context.fillText(detail.slice(0, 60), canvas.width / 2, canvas.height / 2 + canvas.width / 9);
    }
    canvas.dataset.nudityBlurred = 'true';
    canvas.setAttribute('aria-label', label);
    blurredCanvases.set(canvas, { source, redraw });
    if (nudityRevealHandlers.has(canvas)) return;
    nudityRevealHandlers.add(canvas);
    canvas.addEventListener('click', event => {
        if (canvas.dataset.nudityBlurred !== 'true') return;
        event.preventDefault();
        event.stopImmediatePropagation();
        revealBlurredImage(canvas);
    }, true);
}

// Aufdecken (Tippen). Fuer Ansichten, deren Canvas keine Klicks bekommt (Snap-Viewer: pointer-events-none,
// die Gesten liegen auf dem Viewer), ruft der Viewer das selbst auf. true = war unscharf.
function revealBlurredImage(canvas) {
    const entry = blurredCanvases.get(canvas);
    if (!entry || canvas.dataset.nudityBlurred !== 'true') return false;
    revealedNudityImages.add(entry.source);
    delete canvas.dataset.nudityBlurred;
    canvas.setAttribute('aria-label', t('common.image'));
    entry.redraw();
    return true;
}

// ----- Warnung vor dem Senden -----
// Eigene Bilder werden vor dem Senden (Chat, Snaps, Status) lokal mit demselben Modell geprueft; bei
// einem Treffer fragt die App nach. Nur eine Warnung: schlaegt die Pruefung fehl, wird normal gesendet.
// Nichts davon verlaesst das Geraet. true = senden.
// Dating-Chat (T37 P3, nur Entdecken, nicht Chat & Freunde): an jemanden, den man nur aus dem Entdecken kennt.
function isDatingChat(peerId) {
    if (!peerId || (typeof isGroupId === 'function' && isGroupId(peerId))) return false;
    const scope = typeof chatScopeOf === 'function' ? chatScopeOf(peerId) : null;
    if (scope) return scope === 'discovery';
    return typeof inExploringMode === 'function' && inExploringMode();
}

// Auswahl im Dating-Chat: 'secure' (als Secure Snap), true (trotzdem normal) oder false (abbrechen).
// Eigenes Fenster ueber allem (auch ueber der Snap-Kamera), Standard-Knopf = Secure Snap.
function nudeDatingChoice() {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.id = 'nude-dating-choice';
        overlay.className = 'fixed inset-0 z-80 bg-slate-950/90 flex items-center justify-center p-4';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        const card = document.createElement('div');
        card.className = 'w-full max-w-sm rounded-2xl bg-slate-900 border border-slate-700 p-4 space-y-3';
        const title = document.createElement('h2');
        title.className = 'text-base font-bold text-white';
        title.textContent = t('nudity.datingTitle');
        const text = document.createElement('p');
        text.className = 'text-sm text-slate-300';
        text.textContent = t('nudity.datingText');
        const finish = value => {
            overlay.remove();
            resolve(value);
        };
        const button = (id, label, className, value) => {
            const element = document.createElement('button');
            element.type = 'button';
            element.id = id;
            element.className = `w-full rounded-full px-4 py-2.5 text-sm font-semibold ${className}`;
            element.textContent = label;
            element.addEventListener('click', () => finish(value));
            return element;
        };
        card.append(title, text,
            button('nude-dating-secure', t('nudity.datingSecure'), 'bg-brand-600 hover:bg-brand-500 text-white', 'secure'),
            button('nude-dating-send', t('nudity.datingSendAnyway'), 'bg-slate-800 hover:bg-slate-700 text-slate-200', true),
            button('nude-dating-cancel', t('nudity.datingCancel'), 'text-slate-400 hover:text-white', false));
        overlay.appendChild(card);
        document.body.appendChild(overlay);
        document.getElementById('nude-dating-secure')?.focus();
    });
}

async function confirmNudeSend(canvases, { peerId = null } = {}) {
    if (state.nudityWarnBeforeSend === false || !hasNudityClassifier() || !canvases?.length) return true;
    const threshold = state.appConfig?.nudity?.threshold ?? NUDITY_THRESHOLD;
    let hits = 0;
    for (const canvas of canvases) {
        let bitmap = null;
        try {
            bitmap = await createImageBitmap(canvas);
        } catch {
            continue;
        }
        try {
            let score = null;
            for (const classifier of nudityClassifiers) {
                try {
                    const value = Number(await classifier.classify(bitmap));
                    if (Number.isFinite(value)) score = Math.max(score ?? 0, value);
                } catch (error) {
                    logDebug(`Nudity check before sending failed: ${error.message}`);
                }
            }
            if (score !== null && score >= threshold) hits += 1;
        } finally {
            bitmap.close?.();
        }
    }
    if (!hits) return true;
    if (isDatingChat(peerId)) return nudeDatingChoice();
    return window.confirm(canvases.length === 1 ? t('nudity.sendWarningOne') : t('nudity.sendWarningMany', { count: hits, total: canvases.length }));
}

