// ================= STICKER AUSSCHNEIDEN IM WORKER (Board T39 S2) =================
// U^2-Net-p (Apache-2.0) ueber onnxruntime-web (WASM, ein Thread), beides vom eigenen Router (/api/config
// `stickers.cutout`). Eingabe: ImageBitmap (wird geschlossen), Ausgabe: Maske 320 x 320 (0..1, Hauptmotiv = 1).
// Das Bild verlaesst das Geraet nicht.
const CUTOUT_SIZE = 320;
const CUTOUT_MEAN = [0.485, 0.456, 0.406];
const CUTOUT_STD = [0.229, 0.224, 0.225];
let sessionPromise = null;

function loadSession(config) {
    if (!sessionPromise) {
        sessionPromise = (async () => {
            self.importScripts(config.library);
            self.ort.env.wasm.wasmPaths = config.runtimeUrl;
            self.ort.env.wasm.numThreads = 1;
            return self.ort.InferenceSession.create(config.modelUrl, { executionProviders: ['wasm'] });
        })().catch(error => {
            sessionPromise = null;
            throw error;
        });
    }
    return sessionPromise;
}

// Auf 320 x 320 gestreckt (wie beim Training), RGB normiert, CHW.
function cutoutInput(bitmap) {
    const canvas = new OffscreenCanvas(CUTOUT_SIZE, CUTOUT_SIZE);
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0, CUTOUT_SIZE, CUTOUT_SIZE);
    const { data } = context.getImageData(0, 0, CUTOUT_SIZE, CUTOUT_SIZE);
    const plane = CUTOUT_SIZE * CUTOUT_SIZE;
    const tensor = new Float32Array(3 * plane);
    for (let index = 0; index < plane; index++) {
        for (let channel = 0; channel < 3; channel++) {
            tensor[channel * plane + index] = (data[index * 4 + channel] / 255 - CUTOUT_MEAN[channel]) / CUTOUT_STD[channel];
        }
    }
    return tensor;
}

// Ausgabe auf 0..1 strecken (wie rembg).
function normalizeMask(values) {
    let min = Infinity;
    let max = -Infinity;
    for (const value of values) {
        if (value < min) min = value;
        if (value > max) max = value;
    }
    const range = max - min || 1;
    return Float32Array.from(values, value => (value - min) / range);
}

if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
    self.addEventListener('message', async event => {
        const { id, config, bitmap } = event.data || {};
        try {
            const session = await loadSession(config);
            const input = new self.ort.Tensor('float32', cutoutInput(bitmap), [1, 3, CUTOUT_SIZE, CUTOUT_SIZE]);
            const result = await session.run({ [session.inputNames[0]]: input });
            const mask = normalizeMask(result[session.outputNames[0]].data);
            self.postMessage({ id, mask, size: CUTOUT_SIZE }, [mask.buffer]);
        } catch (error) {
            self.postMessage({ id, error: error?.message || String(error) });
        } finally {
            bitmap?.close?.();
        }
    });
}
