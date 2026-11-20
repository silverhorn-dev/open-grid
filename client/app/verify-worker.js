// ================= GESICHTSERKENNUNG IM WORKER (Profilbild-Verifizierung, Board T37) =================
// Live-Anleitung beim Verifizieren (verify.js): YuNet (OpenCV Zoo, MIT) ueber onnxruntime-web (WASM), beides vom
// eigenen Router (/api/config verify.detector). Eingabe: ImageBitmap (wird hier geschlossen), Ausgabe: Gesichter mit
// Box und 5 Punkten in Bildkoordinaten. Bilder verlassen das Geraet hier nicht; entschieden wird beim Router.
// decodeYuNet entspricht server/face-verify.js (test/verify-client.test.js vergleicht beide).
const YUNET_SIZE = 640;
const YUNET_STRIDES = [8, 16, 32];
let sessionPromise = null;

function loadSession(config) {
    if (!sessionPromise) {
        sessionPromise = (async () => {
            self.importScripts(config.library);
            self.ort.env.wasm.wasmPaths = config.runtimeUrl;
            // Mehrere Threads braeuchten SharedArrayBuffer (Cross-Origin-Isolation); einer reicht.
            self.ort.env.wasm.numThreads = 1;
            return self.ort.InferenceSession.create(config.modelUrl, { executionProviders: ['wasm'] });
        })().catch(error => {
            sessionPromise = null;
            throw error;
        });
    }
    return sessionPromise;
}

// Seitenverhaeltnis behalten, rechts/unten schwarz; CHW, BGR, 0-255 (wie letterboxBgr im Router).
function letterbox(bitmap) {
    const scale = Math.min(YUNET_SIZE / bitmap.width, YUNET_SIZE / bitmap.height);
    const canvas = new OffscreenCanvas(YUNET_SIZE, YUNET_SIZE);
    const context = canvas.getContext('2d');
    context.fillStyle = '#000';
    context.fillRect(0, 0, YUNET_SIZE, YUNET_SIZE);
    context.drawImage(bitmap, 0, 0, Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
    const { data } = context.getImageData(0, 0, YUNET_SIZE, YUNET_SIZE);
    const plane = YUNET_SIZE * YUNET_SIZE;
    const tensor = new Float32Array(3 * plane);
    for (let index = 0; index < plane; index++) {
        tensor[index] = data[index * 4 + 2];
        tensor[plane + index] = data[index * 4 + 1];
        tensor[2 * plane + index] = data[index * 4];
    }
    return { tensor, scale };
}

function clamp01(value) {
    return Math.max(0, Math.min(1, value));
}

function boxIou(a, b) {
    const x1 = Math.max(a[0], b[0]);
    const y1 = Math.max(a[1], b[1]);
    const x2 = Math.min(a[0] + a[2], b[0] + b[2]);
    const y2 = Math.min(a[1] + a[3], b[1] + b[3]);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    return inter / (a[2] * a[3] + b[2] * b[3] - inter || 1);
}

function decodeYuNet(outputs, { size = YUNET_SIZE, scale = 1, minScore = 0.6, nmsIou = 0.3 } = {}) {
    const faces = [];
    for (const stride of YUNET_STRIDES) {
        const cols = size / stride;
        const cls = outputs[`cls_${stride}`];
        const obj = outputs[`obj_${stride}`];
        const bbox = outputs[`bbox_${stride}`];
        const kps = outputs[`kps_${stride}`];
        for (let index = 0; index < cls.length; index++) {
            const score = Math.sqrt(clamp01(cls[index]) * clamp01(obj[index]));
            if (score < minScore) continue;
            const row = Math.floor(index / cols);
            const col = index % cols;
            const cx = (col + bbox[index * 4]) * stride;
            const cy = (row + bbox[index * 4 + 1]) * stride;
            const w = Math.exp(bbox[index * 4 + 2]) * stride;
            const h = Math.exp(bbox[index * 4 + 3]) * stride;
            const landmarks = [];
            for (let point = 0; point < 5; point++) {
                landmarks.push([(kps[index * 10 + point * 2] + col) * stride / scale, (kps[index * 10 + point * 2 + 1] + row) * stride / scale]);
            }
            faces.push({ score, box: [(cx - w / 2) / scale, (cy - h / 2) / scale, w / scale, h / scale], landmarks });
        }
    }
    faces.sort((a, b) => b.score - a.score);
    const kept = [];
    for (const face of faces) if (kept.every(other => boxIou(face.box, other.box) < nmsIou)) kept.push(face);
    return kept;
}

if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
    self.addEventListener('message', async event => {
        const { id, config, bitmap } = event.data || {};
        try {
            const session = await loadSession(config);
            const { tensor, scale } = letterbox(bitmap);
            const result = await session.run({ input: new self.ort.Tensor('float32', tensor, [1, 3, YUNET_SIZE, YUNET_SIZE]) });
            const outputs = Object.fromEntries(Object.entries(result).map(([name, value]) => [name, value.data]));
            self.postMessage({ id, faces: decodeYuNet(outputs, { scale }) });
        } catch (error) {
            self.postMessage({ id, error: error.message });
        } finally {
            bitmap?.close?.();
        }
    });
}
