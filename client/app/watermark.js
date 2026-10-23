// ================= WASSERZEICHEN =================
// Unsichtbares Wasserzeichen mit der Empfaenger-ID (Leaker-Identifikation bei Screenshots).
// Verfahren: Quantisierung (QIM) der mittleren Helligkeit von 16x16-Bloecken. Jeder Block traegt ein
// Bit eines 32-Bit-Tags (SHA-256 der Empfaenger-ID), viele Wiederholungen + Mehrheitsentscheid.
// Uebersteht die eigene JPEG-Kompression und 1:1-Screenshots, nicht aber Skalieren oder Zuschneiden.
const WATERMARK_BLOCK = 16;
const WATERMARK_STEP = 8;
const WATERMARK_BITS = 32;

async function watermarkTag(peerId) {
    const digest = new Uint8Array(await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(`og-watermark:${peerId}`)));
    const bits = [];
    for (let index = 0; index < WATERMARK_BITS; index++) bits.push((digest[index >> 3] >> (7 - (index & 7))) & 1);
    return bits;
}

function blockLuminance(data, width, startX, startY) {
    let sum = 0;
    for (let y = startY; y < startY + WATERMARK_BLOCK; y++) {
        for (let x = startX; x < startX + WATERMARK_BLOCK; x++) {
            const offset = (y * width + x) * 4;
            sum += 0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2];
        }
    }
    return sum / (WATERMARK_BLOCK * WATERMARK_BLOCK);
}

// Schreibt das Tag direkt in die Pixel eines Canvas.
function embedWatermarkInCanvas(canvas, bits) {
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    embedWatermarkInPixels(image, bits);
    context.putImageData(image, 0, 0);
}

// Arbeitet auf ImageData-artigen Objekten ({ data, width, height }).
function embedWatermarkInPixels({ data, width, height }, bits) {
    let blockIndex = 0;
    for (let startY = 0; startY + WATERMARK_BLOCK <= height; startY += WATERMARK_BLOCK) {
        for (let startX = 0; startX + WATERMARK_BLOCK <= width; startX += WATERMARK_BLOCK) {
            const bit = bits[blockIndex % WATERMARK_BITS];
            blockIndex += 1;
            const mean = blockLuminance(data, width, startX, startY);
            const offset = bit * WATERMARK_STEP / 2;
            const target = Math.min(255 - WATERMARK_STEP / 2, Math.max(WATERMARK_STEP / 2,
                WATERMARK_STEP * Math.round((mean - offset) / WATERMARK_STEP) + offset));
            const delta = target - mean;
            for (let y = startY; y < startY + WATERMARK_BLOCK; y++) {
                for (let x = startX; x < startX + WATERMARK_BLOCK; x++) {
                    const pixel = (y * width + x) * 4;
                    data[pixel] = Math.min(255, Math.max(0, data[pixel] + delta));
                    data[pixel + 1] = Math.min(255, Math.max(0, data[pixel + 1] + delta));
                    data[pixel + 2] = Math.min(255, Math.max(0, data[pixel + 2] + delta));
                }
            }
        }
    }
}

function loadImageElement(dataUrl) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('Image could not be decoded'));
        image.src = dataUrl;
    });
}

async function embedWatermark(dataUrl, peerId, quality = 0.8) {
    try {
        const image = await loadImageElement(dataUrl);
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        canvas.getContext('2d').drawImage(image, 0, 0);
        embedWatermarkInCanvas(canvas, await watermarkTag(peerId));
        return canvas.toDataURL('image/jpeg', quality);
    } catch (error) {
        logDebug(`Watermark failed: ${error.message}`);
        return dataUrl;
    }
}

// Liest das Tag per Mehrheitsentscheid; confidence = mittlerer Stimmenvorsprung (0..1).
function readWatermarkFromCanvas(canvas) {
    const context = canvas.getContext('2d', { willReadFrequently: true });
    return readWatermarkFromPixels(context.getImageData(0, 0, canvas.width, canvas.height));
}

function readWatermarkFromPixels({ data, width, height }) {
    const votes = new Array(WATERMARK_BITS).fill(0);
    const counts = new Array(WATERMARK_BITS).fill(0);
    let blockIndex = 0;
    for (let startY = 0; startY + WATERMARK_BLOCK <= height; startY += WATERMARK_BLOCK) {
        for (let startX = 0; startX + WATERMARK_BLOCK <= width; startX += WATERMARK_BLOCK) {
            const mean = blockLuminance(data, width, startX, startY);
            const distanceToZero = Math.abs(mean - WATERMARK_STEP * Math.round(mean / WATERMARK_STEP));
            const shifted = mean - WATERMARK_STEP / 2;
            const distanceToOne = Math.abs(shifted - WATERMARK_STEP * Math.round(shifted / WATERMARK_STEP));
            const slot = blockIndex % WATERMARK_BITS;
            votes[slot] += distanceToOne < distanceToZero ? 1 : -1;
            counts[slot] += 1;
            blockIndex += 1;
        }
    }
    if (!blockIndex) return null;
    const bits = votes.map(vote => (vote > 0 ? 1 : 0));
    const confidence = votes.reduce((sum, vote, index) => sum + Math.abs(vote) / Math.max(1, counts[index]), 0) / WATERMARK_BITS;
    return { bits, confidence };
}

// Vergleicht ein Bild mit allen bekannten Peers und liefert den besten Treffer.
async function identifyWatermark(dataUrl, candidatePeerIds) {
    const image = await loadImageElement(dataUrl);
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext('2d').drawImage(image, 0, 0);
    const result = readWatermarkFromCanvas(canvas);
    if (!result) return null;
    let best = null;
    for (const peerId of candidatePeerIds) {
        const tag = await watermarkTag(peerId);
        const matches = tag.filter((bit, index) => bit === result.bits[index]).length;
        if (!best || matches > best.matches) best = { peerId, matches };
    }
    // Zufall trifft im Mittel 16 von 32 Bits; ab 28 gilt es als Treffer.
    return best && best.matches >= 28 ? { ...best, confidence: result.confidence } : null;
}

async function checkWatermarkFile(input) {
    const file = input.files?.[0];
    input.value = '';
    const output = document.getElementById('watermark-check-result');
    if (!file || !output) return;
    output.textContent = 'Pruefe...';
    try {
        const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
        });
        const candidates = new Set([...state.chatPeerIds, ...state.peers.map(peer => peer.id)]);
        Object.values(state.albums).forEach(album => (album.acl || []).forEach(peerId => candidates.add(peerId)));
        const match = await identifyWatermark(dataUrl, [...candidates]);
        output.textContent = match
            ? `Treffer: ${getPeerPresentation(match.peerId).name || 'Peer'} (${match.peerId}), ${match.matches}/32 Bits`
            : 'Kein Wasserzeichen eines bekannten Peers gefunden.';
    } catch (error) {
        output.textContent = `Pruefung fehlgeschlagen: ${error.message}`;
    }
}
