import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

function loadWatermark() {
    const context = { window: { crypto: globalThis.crypto }, TextEncoder, Math };
    vm.runInNewContext(readFileSync(new URL('../client/app/watermark.js', import.meta.url), 'utf8'), context);
    return context;
}

// Pseudo-Foto: weiche Verlaeufe plus etwas Struktur, deterministisch.
function syntheticImage(width, height) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const offset = (y * width + x) * 4;
            data[offset] = 80 + 60 * Math.sin(x / 37) + 20 * Math.cos(y / 11);
            data[offset + 1] = 120 + 50 * Math.cos((x + y) / 53);
            data[offset + 2] = 100 + 40 * Math.sin(y / 29);
            data[offset + 3] = 255;
        }
    }
    return { data, width, height };
}

test('embeds a receiver tag that survives mild pixel noise', async () => {
    const watermark = loadWatermark();
    const image = syntheticImage(640, 480);
    const original = Uint8ClampedArray.from(image.data);
    const bits = await watermark.watermarkTag('peer-receiver');
    watermark.embedWatermarkInPixels(image, bits);

    // Unsichtbar: Helligkeit aendert sich pro Pixel hoechstens um die halbe Quantisierungsstufe.
    let maxChange = 0;
    for (let index = 0; index < original.length; index++) maxChange = Math.max(maxChange, Math.abs(original[index] - image.data[index]));
    assert.ok(maxChange <= 5, `max change ${maxChange}`);

    // Rauschen wie bei leichter Kompression.
    let seed = 1;
    for (let index = 0; index < image.data.length; index += 4) {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        const noise = (seed % 5) - 2;
        image.data[index] += noise;
        image.data[index + 1] += noise;
        image.data[index + 2] += noise;
    }
    const result = watermark.readWatermarkFromPixels(image);
    assert.deepEqual([...result.bits], [...bits]);
});

test('different receivers get different tags and unmarked images do not match', async () => {
    const watermark = loadWatermark();
    const first = await watermark.watermarkTag('peer-a');
    const second = await watermark.watermarkTag('peer-b');
    assert.notDeepEqual([...first], [...second]);

    const plain = watermark.readWatermarkFromPixels(syntheticImage(640, 480));
    const matches = first.filter((bit, index) => bit === plain.bits[index]).length;
    assert.ok(matches < 28, `unmarked image matched ${matches} bits`);
});
