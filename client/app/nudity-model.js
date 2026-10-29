// ================= NACKTBILD-MODELL ANBINDEN (Board T3) =================
// Der Router legt fest, ob und welches Modell es gibt (/api/config `nudity`: model, kind, threshold,
// classes, combine, library, modelUrl, size; `models` = alle verfuegbaren fuer die Testseite). Gibt es eins, meldet sich hier ein Klassifikator beim Filter an (nudity.js);
// der Worker samt Modell (~3 MB) startet erst beim ersten Bild, das geprueft werden soll, also nur bei
// eingeschaltetem Filter. Wert eines Bilds aus den konfigurierten Klassen: Summe (NSFWJS, Bumble) bzw.
// hoechste Fundstelle (NudeNet).
// Grosszuegig: beim ersten Bild laedt der Worker Bibliothek und Modell (Bumble ~51 MB). Die Frist gilt je
// Bild ab dem Moment, in dem der Worker es bekommt (Bilder laufen nacheinander, siehe nudityQueue).
const NUDITY_CLASSIFY_TIMEOUT_MS = 90000;
// Warteschlange: immer nur ein Bild im Worker. Vorher liefen alle Bilder eines Chats gleichzeitig los,
// ihre Fristen liefen schon beim Warten ab, und sie erschienen ungeprueft.
let nudityQueue = Promise.resolve();
// Version der App-Dateien (vom eigenen Script-Tag), damit der Worker nach Updates neu geladen wird.
const NUDITY_ASSET_VERSION = (document.currentScript?.src.match(/[?&]v=([^&]+)/) || [])[1] || '';
let nudityWorker = null;
let nudityRequestId = 0;
const nudityPending = new Map();

function nudityModelConfig() {
    const config = state.appConfig?.nudity;
    return config && config.model !== 'off' && typeof config.library === 'string' && typeof config.modelUrl === 'string' ? config : null;
}

function nudityWorkerInstance() {
    if (nudityWorker) return nudityWorker;
    nudityWorker = new Worker(`/client/app/nudity-worker.js?v=${NUDITY_ASSET_VERSION}`);
    nudityWorker.onmessage = event => {
        const { id, predictions, error } = event.data || {};
        const pending = nudityPending.get(id);
        if (!pending) return;
        nudityPending.delete(id);
        clearTimeout(pending.timer);
        if (error) pending.reject(new Error(error));
        else pending.resolve(predictions);
    };
    nudityWorker.onerror = event => logDebug(`Nudity worker error: ${event.message}`);
    return nudityWorker;
}

// Alle Klassen mit Wahrscheinlichkeit (fuer den Filter und die Testseite im Debug-Modus).
// `modelId` (nur Testseite): ein anderes vom Router ausgeliefertes Modell statt des aktiven.
async function classifyNudity(bitmap, modelId = null) {
    const active = nudityModelConfig();
    if (!active) throw new Error('No nudity model configured.');
    const config = modelId && active.models?.[modelId] ? active.models[modelId] : active;
    // Eine Kopie geht in den Worker; das Original zeichnet die Seite weiter.
    const copy = await createImageBitmap(bitmap);
    const job = nudityQueue.then(() => new Promise((resolve, reject) => {
        const id = ++nudityRequestId;
        const timer = setTimeout(() => {
            nudityPending.delete(id);
            reject(new Error('Nudity model timed out.'));
        }, NUDITY_CLASSIFY_TIMEOUT_MS);
        nudityPending.set(id, { resolve, reject, timer });
        const { kind, library, runtimeUrl, modelUrl, size, type, classes } = config;
        nudityWorkerInstance().postMessage({ type: 'classify', id, bitmap: copy, config: { kind: kind || 'nsfwjs', library, runtimeUrl, modelUrl, size: size || 224, type: type || 'layers', classes } }, [copy]);
    }));
    // Die Kette laeuft auch nach einem Fehler weiter.
    nudityQueue = job.catch(() => {});
    return job;
}

function nudityScoreFromPredictions(predictions, classes = nudityModelConfig()?.classes || ['Porn', 'Hentai'], combine = nudityModelConfig()?.combine || 'sum') {
    const values = predictions.filter(prediction => classes.includes(prediction.className)).map(prediction => prediction.probability);
    const score = combine === 'max' ? Math.max(0, ...values) : values.reduce((sum, value) => sum + value, 0);
    return Math.min(1, score);
}

function initNudityModel() {
    if (!nudityModelConfig()) return;
    renderNudityTestModels();
    registerNudityClassifier({
        id: nudityModelConfig().model,
        async classify(bitmap) {
            const predictions = await classifyNudity(bitmap);
            const score = nudityScoreFromPredictions(predictions);
            // Fuer das Einstellen der Schwelle (Debug-Log): Wert und die staerksten Klassen.
            logDebug(`Nudity ${nudityModelConfig().model}: ${Math.round(score * 100)} % (${[...predictions].sort((left, right) => right.probability - left.probability).slice(0, 3).map(entry => `${entry.className} ${Math.round(entry.probability * 100)} %`).join(', ')})`);
            return score;
        }
    });
}

// ----- Testseite (Debug-Modus, Medien > Schutz) -----
// Auswahl: alle Modelle, die der Router ausliefert; vorgewaehlt das aktive.
function renderNudityTestModels() {
    const select = document.getElementById('nudity-test-model');
    const config = nudityModelConfig();
    if (!select || !config) return;
    select.replaceChildren(...Object.keys(config.models || { [config.model]: true }).map(id => {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = id === config.model ? `${id} (${t('nudity.activeModel')})` : id;
        option.selected = id === config.model;
        return option;
    }));
}
// Eigene Bilder pruefen: Werte je Klasse und ob der Filter sie unscharf zeigen wuerde. Alles lokal.
async function testNudityImages(input) {
    const results = document.getElementById('nudity-test-results');
    const files = Array.from(input.files || []).slice(0, 20);
    input.value = '';
    if (!results || !files.length) return;
    results.innerHTML = '';
    if (!nudityModelConfig()) {
        results.textContent = t('nudity.noModel');
        return;
    }
    const threshold = state.appConfig.nudity.threshold;
    const modelId = document.getElementById('nudity-test-model')?.value || state.appConfig.nudity.model;
    for (const file of files) {
        const row = document.createElement('div');
        row.className = 'nudity-test-row';
        const name = document.createElement('div');
        name.className = 'font-semibold truncate';
        name.textContent = file.name;
        const detail = document.createElement('div');
        detail.className = 'text-slate-400';
        detail.textContent = t('nudity.testing');
        row.append(name, detail);
        results.appendChild(row);
        try {
            const bitmap = await createImageBitmap(file);
            const started = performance.now();
            const predictions = await classifyNudity(bitmap, modelId);
            bitmap.close?.();
            // Fremdes Modell auf der Testseite: dessen Standard-Klassen, sonst die vom Betreiber gewaehlten.
            const active = state.appConfig.nudity;
            const model = active.models?.[modelId] || active;
            const score = nudityScoreFromPredictions(predictions, modelId === active.model ? active.classes : model.defaultClasses, model.combine);
            detail.textContent = `${modelId} · ${score >= threshold ? t('nudity.wouldBlur') : t('nudity.wouldShow')} · ${Math.round(score * 100)} % · ${Math.round(performance.now() - started)} ms · `
                + [...predictions].sort((left, right) => right.probability - left.probability).slice(0, 5)
                    .map(prediction => `${prediction.className} ${Math.round(prediction.probability * 100)} %`).join(', ');
            row.classList.toggle('is-blurred', score >= threshold);
        } catch (error) {
            detail.textContent = t('nudity.testFailed', { message: error.message });
        }
    }
}

// Vorladen, sobald Kamera/Bildauswahl aufgeht (Warnung vor dem Senden an): Bibliothek und Modell sind dann
// meist schon da, wenn "Senden" kommt. Einmal je Sitzung; Fehler sind hier egal.
let nudityWarmedUp = false;
function warmUpNudityModel() {
    if (nudityWarmedUp || !nudityModelConfig() || state.nudityWarnBeforeSend === false) return;
    nudityWarmedUp = true;
    const canvas = new OffscreenCanvas(8, 8);
    createImageBitmap(canvas).then(bitmap => classifyNudity(bitmap).finally(() => bitmap.close?.()))
        .catch(error => logDebug(`Nudity warm-up failed: ${error.message}`));
}

