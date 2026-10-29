// ================= NACKTBILD-MODELL ANBINDEN (Board T3) =================
// Der Router legt fest, ob und welches Modell es gibt (/api/config `nudity`: model, threshold, classes,
// library, modelUrl, size). Gibt es eins, meldet sich hier ein Klassifikator beim Filter an (nudity.js);
// der Worker samt Modell (~3 MB) startet erst beim ersten Bild, das geprueft werden soll, also nur bei
// eingeschaltetem Filter. Wert eines Bilds = Summe der Wahrscheinlichkeiten der konfigurierten Klassen.
const NUDITY_CLASSIFY_TIMEOUT_MS = 20000;
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
    const config = modelId && active.models?.[modelId] ? { library: active.library, ...active.models[modelId] } : active;
    // Eine Kopie geht in den Worker; das Original zeichnet die Seite weiter.
    const copy = await createImageBitmap(bitmap);
    const id = ++nudityRequestId;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            nudityPending.delete(id);
            reject(new Error('Nudity model timed out.'));
        }, NUDITY_CLASSIFY_TIMEOUT_MS);
        nudityPending.set(id, { resolve, reject, timer });
        nudityWorkerInstance().postMessage({ type: 'classify', id, bitmap: copy, config: { library: config.library, modelUrl: config.modelUrl, size: config.size || 224, type: config.type || 'layers' } }, [copy]);
    });
}

function nudityScoreFromPredictions(predictions, classes = nudityModelConfig()?.classes || ['Porn', 'Hentai']) {
    return predictions.filter(prediction => classes.includes(prediction.className))
        .reduce((sum, prediction) => sum + prediction.probability, 0);
}

function initNudityModel() {
    if (!nudityModelConfig()) return;
    renderNudityTestModels();
    registerNudityClassifier({
        id: nudityModelConfig().model,
        async classify(bitmap) {
            return nudityScoreFromPredictions(await classifyNudity(bitmap));
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
            const score = nudityScoreFromPredictions(predictions);
            detail.textContent = `${modelId} · ${score >= threshold ? t('nudity.wouldBlur') : t('nudity.wouldShow')} · ${Math.round(score * 100)} % · ${Math.round(performance.now() - started)} ms · `
                + predictions.map(prediction => `${prediction.className} ${Math.round(prediction.probability * 100)} %`).join(', ');
            row.classList.toggle('is-blurred', score >= threshold);
        } catch (error) {
            detail.textContent = t('nudity.testFailed', { message: error.message });
        }
    }
}
