import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildApp } from '../server/app.js';
import { createStore } from '../server/database.js';
import { findSttDirectory, parseSttModel } from '../server/stt-model.js';

// Ordner wie aus der Docker-Stufe "whisper" (Inhalt hier nur Platzhalter).
function fakeSttDirectory() {
    const directory = mkdtempSync(join(tmpdir(), 'stt-'));
    mkdirSync(join(directory, 'whisper-base', 'onnx'), { recursive: true });
    for (const file of ['transformers.min.js', 'ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']) writeFileSync(join(directory, file), `/* ${file} */`);
    for (const file of ['config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json']) writeFileSync(join(directory, 'whisper-base', file), '{}');
    for (const file of ['encoder_model_quantized.onnx', 'decoder_model_merged_quantized.onnx']) writeFileSync(join(directory, 'whisper-base', 'onnx', file), 'onnx');
    writeFileSync(join(directory, 'VERSION.json'), '{"transformers":"4.3.2"}');
    return directory;
}

test('STT model setting: whisper-base or off, anything else is invalid', () => {
    assert.equal(parseSttModel(undefined), 'whisper-base');
    assert.equal(parseSttModel('OFF'), 'off');
    assert.equal(parseSttModel('whisper-large'), null);
    assert.equal(findSttDirectory([mkdtempSync(join(tmpdir(), 'empty-'))], 'whisper-base'), null, 'incomplete folder is not used');
});

test('router serves the transcription runtime and model only from its own paths, advertised in /api/config', async () => {
    const directory = fakeSttDirectory();
    const app = await buildApp({ store: createStore(':memory:'), metrics: false, sttModelDir: directory, sttBuiltInModels: false });
    try {
        const stt = (await app.inject({ method: 'GET', url: '/api/config' })).json().stt;
        assert.deepEqual(stt, { model: 'whisper-base', sizeMb: 77, library: '/vendor/whisper/4.3.2/transformers.min.js', wasmPaths: '/vendor/whisper/4.3.2/', modelBase: '/vendor/whisper/4.3.2/models/' });
        const wasm = await app.inject({ method: 'GET', url: '/vendor/whisper/4.3.2/ort-wasm-simd-threaded.asyncify.wasm' });
        assert.equal(wasm.statusCode, 200);
        assert.equal(wasm.headers['content-type'], 'application/wasm');
        assert.match(wasm.headers['cache-control'], /immutable/);
        assert.equal((await app.inject({ method: 'GET', url: '/vendor/whisper/4.3.2/models/whisper-base/onnx/encoder_model_quantized.onnx' })).statusCode, 200);
        assert.equal((await app.inject({ method: 'GET', url: '/vendor/whisper/4.3.2/models/whisper-base/../../VERSION.json' })).statusCode, 404, 'only listed files');
        // Worker darf WebAssembly kompilieren, die Seite nicht.
        const worker = await app.inject({ method: 'GET', url: '/client/app/stt-worker.js' });
        assert.match(worker.headers['content-security-policy'], /wasm-unsafe-eval/);
        assert.doesNotMatch((await app.inject({ method: 'GET', url: '/' })).headers['content-security-policy'], /wasm-unsafe-eval/);
    } finally {
        await app.close();
    }
    const off = await buildApp({ store: createStore(':memory:'), metrics: false, sttModel: 'off', sttModelDir: directory, sttBuiltInModels: false });
    try {
        assert.deepEqual((await off.inject({ method: 'GET', url: '/api/config' })).json().stt, { model: 'off' });
        assert.equal((await off.inject({ method: 'GET', url: '/vendor/whisper/4.3.2/transformers.min.js' })).statusCode, 404);
    } finally {
        await off.close();
    }
});
