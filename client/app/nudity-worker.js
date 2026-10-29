// ================= NACKTBILD-MODELL IM WORKER (Board T3) =================
// Laeuft getrennt von der Oberflaeche, damit das Rechnen nichts ruckeln laesst. Bibliothek und Modell
// kommen vom eigenen Router (Pfade aus /api/config). Eingabe: ImageBitmap (wird hier geschlossen),
// Ausgabe: Wahrscheinlichkeit je Klasse. Bilder verlassen das Geraet nicht.
let modelPromise = null;

function loadModel({ library, modelUrl, size }) {
    if (!modelPromise) {
        modelPromise = (async () => {
            self.importScripts(library);
            return self.nsfwjs.load(modelUrl, { size });
        })();
    }
    return modelPromise;
}

self.onmessage = async event => {
    const { type, id } = event.data || {};
    if (type !== 'classify') return;
    const { bitmap, config } = event.data;
    try {
        const model = await loadModel(config);
        // Gleich auf die Eingabegroesse des Modells verkleinern (schneller, weniger Speicher).
        const canvas = new OffscreenCanvas(config.size, config.size);
        const context = canvas.getContext('2d');
        context.drawImage(bitmap, 0, 0, config.size, config.size);
        const predictions = await model.classify(context.getImageData(0, 0, config.size, config.size), 5);
        self.postMessage({ id, predictions: predictions.map(({ className, probability }) => ({ className, probability })) });
    } catch (error) {
        self.postMessage({ id, error: String(error?.message || error) });
    } finally {
        bitmap?.close?.();
    }
};
