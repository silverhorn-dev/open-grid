// ================= GESICHTSPRUEFUNG (documentation/VERIFIZIERUNG.md, Board T37 V1) =================
// Nur im Arbeitsspeicher, nichts wird gespeichert:
//   YuNet (OpenCV Zoo, MIT)  findet Gesichter und 5 Punkte (rechtes Auge, linkes Auge, Nase, Mundwinkel rechts/links,
//                            aus Sicht der Person); Eingang BGR 0-255, quadratisch (Seitenlaenge Vielfaches von 32)
//   SFace  (OpenCV Zoo, Apache-2.0)  Merkmalsvektor (128) eines auf 112x112 ausgerichteten Gesichts; Eingang RGB 0-255
// Laufzeit: onnxruntime-web (WASM, optionalDependencies), JPEG lesen: jpeg-js. Fehlt etwas, ist die Pruefung aus.
import { createRequire } from 'node:module';
import jpeg from 'jpeg-js';

export const DETECT_SIZE = 640;
export const ALIGN_SIZE = 112;
// Zielpunkte fuer 112x112 (wie OpenCV FaceRecognizerSF / ArcFace).
export const ALIGN_TEMPLATE = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]];
const STRIDES = [8, 16, 32];

// ----- Bilder -----
export function decodeJpeg(buffer) {
    const image = jpeg.decode(buffer, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 30, maxMemoryUsageInMB: 256 });
    return { width: image.width, height: image.height, data: image.data };
}

function sample(image, x, y, channel) {
    const x0 = Math.max(0, Math.min(image.width - 1, Math.floor(x)));
    const y0 = Math.max(0, Math.min(image.height - 1, Math.floor(y)));
    const x1 = Math.min(image.width - 1, x0 + 1);
    const y1 = Math.min(image.height - 1, y0 + 1);
    const fx = Math.max(0, Math.min(1, x - x0));
    const fy = Math.max(0, Math.min(1, y - y0));
    const at = (px, py) => image.data[(py * image.width + px) * 4 + channel];
    return (at(x0, y0) * (1 - fx) + at(x1, y0) * fx) * (1 - fy) + (at(x0, y1) * (1 - fx) + at(x1, y1) * fx) * fy;
}

// Seitenverhaeltnis behalten, rechts/unten mit Schwarz auffuellen; CHW, BGR, 0-255.
export function letterboxBgr(image, size = DETECT_SIZE) {
    const scale = Math.min(size / image.width, size / image.height);
    const width = Math.round(image.width * scale);
    const height = Math.round(image.height * scale);
    const out = new Float32Array(3 * size * size);
    const plane = size * size;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const sx = (x + 0.5) / scale - 0.5;
            const sy = (y + 0.5) / scale - 0.5;
            const index = y * size + x;
            out[index] = sample(image, sx, sy, 2);
            out[plane + index] = sample(image, sx, sy, 1);
            out[2 * plane + index] = sample(image, sx, sy, 0);
        }
    }
    return { tensor: out, scale };
}

// ----- YuNet-Ausgabe -----
const clamp01 = value => Math.max(0, Math.min(1, value));

// outputs: { cls_8, obj_8, bbox_8, kps_8, ... } als flache Arrays. Liefert Gesichter in Bildkoordinaten.
export function decodeYuNet(outputs, { size = DETECT_SIZE, scale = 1, minScore = 0.6, nmsIou = 0.3 } = {}) {
    const faces = [];
    for (const stride of STRIDES) {
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
    for (const face of faces) if (kept.every(other => iou(face.box, other.box) < nmsIou)) kept.push(face);
    return kept;
}

function iou(a, b) {
    const x1 = Math.max(a[0], b[0]);
    const y1 = Math.max(a[1], b[1]);
    const x2 = Math.min(a[0] + a[2], b[0] + b[2]);
    const y2 = Math.min(a[1] + a[3], b[1] + b[3]);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    return inter / (a[2] * a[3] + b[2] * b[3] - inter || 1);
}

// ----- Kopfhaltung aus den 5 Punkten -----
// Nase relativ zur Augenmitte, geteilt durch den Augenabstand: ~0 geradeaus, > 0 Kopf zur eigenen linken Seite
// gedreht (Nase im unveraenderten Kamerabild nach rechts), < 0 zur rechten.
export function headYaw(landmarks) {
    const [rightEye, leftEye, nose] = landmarks;
    const midX = (rightEye[0] + leftEye[0]) / 2;
    const eyeDistance = Math.hypot(leftEye[0] - rightEye[0], leftEye[1] - rightEye[1]) || 1;
    return (nose[0] - midX) / eyeDistance;
}

export const POSE_LIMITS = { straight: 0.12, turned: 0.22 };

export function poseMatches(step, yaw) {
    if (step === 'straight') return Math.abs(yaw) <= POSE_LIMITS.straight;
    if (step === 'left') return yaw >= POSE_LIMITS.turned;
    if (step === 'right') return yaw <= -POSE_LIMITS.turned;
    return false;
}

// ----- Ausrichtung (Aehnlichkeitstransformation, Umeyama ohne Spiegelung) -----
export function similarityTransform(src, dst) {
    const n = src.length;
    const mean = points => points.reduce((sum, [x, y]) => [sum[0] + x / n, sum[1] + y / n], [0, 0]);
    const [msx, msy] = mean(src);
    const [mdx, mdy] = mean(dst);
    let a = 0;
    let b = 0;
    let variance = 0;
    for (let index = 0; index < n; index++) {
        const sx = src[index][0] - msx;
        const sy = src[index][1] - msy;
        const dx = dst[index][0] - mdx;
        const dy = dst[index][1] - mdy;
        a += sx * dx + sy * dy;
        b += sx * dy - sy * dx;
        variance += sx * sx + sy * sy;
    }
    const norm = Math.hypot(a, b) || 1;
    const scale = norm / (variance || 1);
    const cos = a / norm;
    const sin = b / norm;
    // dst = s * R * src + t
    const tx = mdx - scale * (cos * msx - sin * msy);
    const ty = mdy - scale * (sin * msx + cos * msy);
    return { scale, cos, sin, tx, ty };
}

// Ausgerichtetes Gesicht als SFace-Eingang: CHW, RGB, 0-255.
export function alignFace(image, landmarks, size = ALIGN_SIZE) {
    const { scale, cos, sin, tx, ty } = similarityTransform(landmarks, ALIGN_TEMPLATE);
    const out = new Float32Array(3 * size * size);
    const plane = size * size;
    for (let v = 0; v < size; v++) {
        for (let u = 0; u < size; u++) {
            // Umkehrung: src = R^-1 * (dst - t) / s
            const dx = u - tx;
            const dy = v - ty;
            const sx = (cos * dx + sin * dy) / scale;
            const sy = (-sin * dx + cos * dy) / scale;
            const index = v * size + u;
            out[index] = sample(image, sx, sy, 0);
            out[plane + index] = sample(image, sx, sy, 1);
            out[2 * plane + index] = sample(image, sx, sy, 2);
        }
    }
    return out;
}

export function cosine(a, b) {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let index = 0; index < a.length; index++) {
        dot += a[index] * b[index];
        na += a[index] * a[index];
        nb += b[index] * b[index];
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// ----- Modelle -----
// models: { detector, recognizer } (onnxruntime-Sitzungen) oder Ersatz fuer Tests: { detect(image), embed(image, face) }.
export async function loadFaceModels({ yunetPath, sfacePath }) {
    // require statt import: das Image behaelt nur dist/ort.node.min.js (scripts/slim-modules.sh).
    const ort = createRequire(import.meta.url)('onnxruntime-web');
    const [detector, recognizer] = await Promise.all([ort.InferenceSession.create(yunetPath), ort.InferenceSession.create(sfacePath)]);
    return {
        async detect(image) {
            const { tensor, scale } = letterboxBgr(image);
            const result = await detector.run({ input: new ort.Tensor('float32', tensor, [1, 3, DETECT_SIZE, DETECT_SIZE]) });
            const outputs = Object.fromEntries(Object.entries(result).map(([name, value]) => [name, value.data]));
            return decodeYuNet(outputs, { scale });
        },
        async embed(image, face) {
            const input = new ort.Tensor('float32', alignFace(image, face.landmarks), [1, 3, ALIGN_SIZE, ALIGN_SIZE]);
            const result = await recognizer.run({ data: input });
            return Array.from(result.fc1.data);
        }
    };
}
