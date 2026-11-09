import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

// sw.js im vm laden; Response/Blob/URL aus Node 22.
function loadWorker(extra = {}) {
    const context = {
        self: { addEventListener: () => {}, registration: {}, clients: {}, location: { origin: 'https://router.example.org' } },
        Response, Blob, URL, Headers, Request, TextEncoder, TextDecoder, console, __PRECACHE_URLS__: [], __SW_TEXTS__: {}, setTimeout, queueMicrotask, structuredClone,
        caches: { open: async () => null },
        ...extra
    };
    vm.runInNewContext(readFileSync(new URL('../client/sw.js', import.meta.url), 'utf8'), context);
    return context;
}

const bytes = n => new Uint8Array(Array.from({ length: n }, (_, index) => index % 256));

test('video gifs: range requests are answered from the full cached file', async () => {
    const worker = loadWorker();
    const full = new Response(bytes(100), { headers: { 'content-type': 'video/mp4' } });
    const part = await worker.rangeResponse(full.clone(), 'bytes=10-19');
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), 'bytes 10-19/100');
    assert.deepEqual([...new Uint8Array(await part.arrayBuffer())], Array.from({ length: 10 }, (_, index) => 10 + index));
    const open = await worker.rangeResponse(full.clone(), 'bytes=90-');
    assert.equal(open.headers.get('content-range'), 'bytes 90-99/100');
    const suffix = await worker.rangeResponse(full.clone(), 'bytes=-5');
    assert.equal(suffix.headers.get('content-range'), 'bytes 95-99/100');
    const whole = await worker.rangeResponse(full.clone(), null);
    assert.equal(whole.status, 200);
    assert.equal((await whole.arrayBuffer()).byteLength, 100);
    assert.equal((await worker.rangeResponse(full.clone(), 'bytes=200-300')).status, 416);
});

test('video gifs: cached with cors, replayed from the cache, never cached when opaque', async () => {
    const store = new Map();
    const cache = { match: async key => store.get(key)?.clone() || null, put: async (key, response) => store.set(key, response) };
    let network = 0;
    const worker = loadWorker({
        caches: { open: async () => cache },
        fetch: async (target, options = {}) => {
            network += 1;
            if (String(target).includes('opaque')) return Object.assign(new Response(null), { type: 'opaque' });
            assert.equal(options.mode, 'cors');
            return new Response(bytes(50), { headers: { 'content-type': 'video/mp4', 'content-length': '50' } });
        }
    });
    const request = url => ({ url, headers: new Headers({ range: 'bytes=0-9' }) });
    const first = await worker.handleGifVideo(request('https://cdn.example.org/a.mp4'), 'https://cdn.example.org/a.mp4');
    assert.equal(first.status, 206);
    assert.ok(store.has('https://cdn.example.org/a.mp4'));
    const again = await worker.handleGifVideo(request('https://cdn.example.org/a.mp4'), 'https://cdn.example.org/a.mp4');
    assert.equal(again.status, 206);
    assert.equal(network, 1, 'second time from the cache');
    await worker.handleGifVideo(request('https://cdn.example.org/opaque.mp4'), 'https://cdn.example.org/opaque.mp4').catch(() => null);
    assert.equal(store.has('https://cdn.example.org/opaque.mp4'), false, 'opaque responses are not cached');
});
