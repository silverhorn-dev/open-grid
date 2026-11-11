import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const FINGERPRINT = 'ab'.repeat(16);

function load() {
    const context = {
        window: { location: { origin: 'https://grid.example.org' } },
        state: {},
        URL,
        // Wie modes.js: <peerId>.<32 hex>~<modus>
        parseInvite: fragment => {
            const [value] = decodeURIComponent(String(fragment || '')).split('~');
            const separator = value.lastIndexOf('.');
            return separator > 0 && /^[0-9a-f]{32}$/.test(value.slice(separator + 1)) ? { peerId: value.slice(0, separator) } : null;
        }
    };
    vm.runInNewContext(read('client/app/qr-scan.js'), context);
    return context;
}

test('opengrid codes: invites (link or bare code), move codes, router links; everything else is ignored', () => {
    const { classifyOpenGridCode: classify } = load();
    const plain = value => JSON.parse(JSON.stringify(value));
    assert.deepEqual(plain(classify(`https://grid.example.org/invite#node_abc.${FINGERPRINT}~chat`)), { kind: 'invite', fragment: `node_abc.${FINGERPRINT}~chat` });
    assert.deepEqual(plain(classify(`  node_abc.${FINGERPRINT}  `)), { kind: 'invite', fragment: `node_abc.${FINGERPRINT}` }, 'pasted code');
    assert.deepEqual(plain(classify(`#node_abc.${FINGERPRINT}`)), { kind: 'invite', fragment: `node_abc.${FINGERPRINT}` });
    assert.deepEqual(plain(classify(`https://other.example.net/invite#node_abc.${FINGERPRINT}`)), { kind: 'foreign-invite', host: 'other.example.net' });
    assert.deepEqual(plain(classify('https://grid.example.org/transfer#abc.def')), { kind: 'transfer', code: 'abc.def' });
    assert.deepEqual(plain(classify('opengrid://connect?url=https%3A%2F%2Fgrid.example.org')), { kind: 'router', url: 'https://grid.example.org', link: 'opengrid://connect?url=https%3A%2F%2Fgrid.example.org' });
    for (const other of ['', 'hello', 'https://example.com/', 'https://grid.example.org/invite#broken', 'WIFI:S:home;T:WPA;P:secret;;', 'x'.repeat(3000)]) {
        assert.equal(classify(other), null, other.slice(0, 40));
    }
});

test('jsQR (served to browsers without BarcodeDetector) reads the invite QR codes the app draws', () => {
    const qrcode = require('qrcode-generator');
    const jsQR = require('jsqr');
    const link = `https://grid.example.org/invite#node_abc.${FINGERPRINT}~chat`;
    const code = qrcode(0, 'M');
    code.addData(link);
    code.make();
    const cell = 4;
    const margin = 4 * cell;
    const size = code.getModuleCount() * cell + 2 * margin;
    const pixels = new Uint8ClampedArray(size * size * 4).fill(255);
    for (let row = 0; row < code.getModuleCount(); row++) {
        for (let col = 0; col < code.getModuleCount(); col++) {
            if (!code.isDark(row, col)) continue;
            for (let y = 0; y < cell; y++) {
                for (let x = 0; x < cell; x++) {
                    const offset = ((margin + row * cell + y) * size + margin + col * cell + x) * 4;
                    pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 0;
                }
            }
        }
    }
    assert.equal(jsQR(pixels, size, size)?.data, link);
    assert.equal(load().classifyOpenGridCode(jsQR(pixels, size, size).data).kind, 'invite');
});
