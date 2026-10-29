// ================= NACKTBILD-MODELLE IM WORKER (Board T3) =================
// Laeuft getrennt von der Oberflaeche, damit das Rechnen nichts ruckeln laesst. Bibliotheken und Modelle
// kommen vom eigenen Router (Pfade aus /api/config). Eingabe: ImageBitmap (wird hier geschlossen),
// Ausgabe: Wert je Klasse. Bilder verlassen das Geraet nicht.
//
// Arten (server/nudity-model.js):
//   nsfwjs   NSFWJS (TF.js), 5 Klassen, Wahrscheinlichkeiten
//   bumble   TF.js-Graph-Modell, Eingabe 480x480 grau aufgefuellt, (x - 128) / 128, Ausgabe [lewd, nicht]
//   nudenet  ONNX (onnxruntime-web, WASM), YOLOv8 320x320 schwarz aufgefuellt (rechts/unten), RGB / 255,
//            Ausgabe [1, 4 + 18, Anker]; je Klasse die hoechste Fundstelle
const models = new Map();
const loadedLibraries = new Set();

function loadLibrary(url) {
    if (loadedLibraries.has(url)) return;
    self.importScripts(url);
    loadedLibraries.add(url);
}

function loadModel(config) {
    if (!models.has(config.modelUrl)) {
        models.set(config.modelUrl, (async () => {
            loadLibrary(config.library);
            if (config.kind === 'bumble') return self.tf.loadGraphModel(`${config.modelUrl}model.json`);
            if (config.kind === 'nudenet') {
                self.ort.env.wasm.wasmPaths = config.runtimeUrl;
                // Mehrere Threads braeuchten SharedArrayBuffer (Cross-Origin-Isolation); einer reicht.
                self.ort.env.wasm.numThreads = 1;
                return self.ort.InferenceSession.create(config.modelUrl, { executionProviders: ['wasm'] });
            }
            return self.nsfwjs.load(config.modelUrl, config.type === 'graph' ? { size: config.size, type: 'graph' } : { size: config.size });
        })());
    }
    return models.get(config.modelUrl).catch(error => {
        models.delete(config.modelUrl);
        throw error;
    });
}

function pixels(bitmap, size, { fill, centre, keepAspect }) {
    const canvas = new OffscreenCanvas(size, size);
    const context = canvas.getContext('2d');
    if (!keepAspect) {
        context.drawImage(bitmap, 0, 0, size, size);
        return context.getImageData(0, 0, size, size);
    }
    context.fillStyle = fill;
    context.fillRect(0, 0, size, size);
    const scale = size / Math.max(bitmap.width, bitmap.height);
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);
    const x = centre ? Math.floor((size - width) / 2) : 0;
    const y = centre ? Math.floor((size - height) / 2) : 0;
    context.drawImage(bitmap, x, y, width, height);
    return context.getImageData(0, 0, size, size);
}

async function classifyNsfwjs(model, bitmap, config) {
    const predictions = await model.classify(pixels(bitmap, config.size, { keepAspect: false }), 5);
    return predictions.map(({ className, probability }) => ({ className, probability }));
}

async function classifyBumble(model, bitmap, config) {
    const { data } = pixels(bitmap, config.size, { fill: 'rgb(128,128,128)', centre: true, keepAspect: true });
    const input = new Float32Array(config.size * config.size * 3);
    for (let source = 0, target = 0; source < data.length; source += 4) {
        input[target++] = (data[source] - 128) / 128;
        input[target++] = (data[source + 1] - 128) / 128;
        input[target++] = (data[source + 2] - 128) / 128;
    }
    const tensor = self.tf.tensor2d(input, [1, input.length]);
    const output = model.predict(tensor);
    const [lewd] = await output.data();
    tensor.dispose();
    output.dispose();
    return [{ className: 'Lewd', probability: lewd }];
}

async function classifyNudenet(session, bitmap, config) {
    const size = config.size;
    const { data } = pixels(bitmap, size, { fill: 'rgb(0,0,0)', centre: false, keepAspect: true });
    const plane = size * size;
    const input = new Float32Array(3 * plane);
    for (let index = 0; index < plane; index += 1) {
        input[index] = data[index * 4] / 255;
        input[plane + index] = data[index * 4 + 1] / 255;
        input[2 * plane + index] = data[index * 4 + 2] / 255;
    }
    const feeds = { [session.inputNames[0]]: new self.ort.Tensor('float32', input, [1, 3, size, size]) };
    const output = (await session.run(feeds))[session.outputNames[0]];
    const [, rows, anchors] = output.dims;
    const values = output.data;
    return config.classes.slice(0, rows - 4).map((className, classIndex) => {
        let best = 0;
        const offset = (4 + classIndex) * anchors;
        for (let anchor = 0; anchor < anchors; anchor += 1) best = Math.max(best, values[offset + anchor]);
        return { className, probability: best };
    });
}

self.onmessage = async event => {
    const { type, id } = event.data || {};
    if (type !== 'classify') return;
    const { bitmap, config } = event.data;
    try {
        const model = await loadModel(config);
        const classify = { bumble: classifyBumble, nudenet: classifyNudenet }[config.kind] || classifyNsfwjs;
        const predictions = await classify(model, bitmap, config);
        self.postMessage({ id, predictions });
    } catch (error) {
        self.postMessage({ id, error: String(error?.message || error) });
    } finally {
        bitmap?.close?.();
    }
};
