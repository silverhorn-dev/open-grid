import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { I18N_STUBS } from './i18n-stubs.js';

const context = { document: { getElementById: () => null }, window: {}, Math, Number };
vm.runInNewContext(readFileSync(new URL('../client/app/snap-editor.js', import.meta.url), 'utf8'), Object.assign(context, I18N_STUBS));

const pixel = (red, green, blue) => new Uint8ClampedArray([red, green, blue, 255]);

test('photo filters: black and white, vivid, red', () => {
    const bw = context.applySnapFilterPixels(pixel(200, 100, 50), 'bw');
    assert.equal(bw[0], bw[1]);
    assert.equal(bw[1], bw[2]);
    const vivid = context.applySnapFilterPixels(pixel(150, 120, 100), 'vivid');
    assert.ok(vivid[0] - vivid[2] > 50, `more saturated: ${[...vivid]}`);
    const red = context.applySnapFilterPixels(pixel(100, 100, 100), 'red');
    assert.ok(red[0] > 100 && red[1] < 100 && red[2] < 100, `red tint: ${[...red]}`);
    assert.equal(red[3], 255, 'alpha untouched');
    const original = context.applySnapFilterPixels(pixel(10, 20, 30), 'original');
    assert.deepEqual([...original], [10, 20, 30, 255]);
});

test('every filter keeps pixels in range and has its own look', () => {
    const sample = () => new Uint8ClampedArray([200, 100, 50, 255, 0, 0, 0, 255, 255, 255, 255, 255, 30, 90, 160, 128]);
    const looks = new Map();
    const filters = ['original', 'vivid', 'warm', 'cool', 'vintage', 'fade', 'dream', 'bw', 'noir', 'red'];
    for (const filter of filters) {
        const out = context.applySnapFilterPixels(sample(), filter);
        assert.deepEqual([out[3], out[7], out[11], out[15]], [255, 255, 255, 128], `${filter}: alpha untouched`);
        looks.set(filter, [...out].join(','));
    }
    assert.equal(new Set(looks.values()).size, filters.length, 'no two filters look the same');
    const warm = context.applySnapFilterPixels(pixel(120, 120, 120), 'warm');
    assert.ok(warm[0] > warm[2], `warm: ${[...warm]}`);
    const cool = context.applySnapFilterPixels(pixel(120, 120, 120), 'cool');
    assert.ok(cool[2] > cool[0], `cool: ${[...cool]}`);
    const fade = context.applySnapFilterPixels(pixel(0, 0, 0), 'fade');
    assert.ok(fade[0] > 20, `fade lifts black: ${[...fade]}`);
    const noir = context.applySnapFilterPixels(pixel(200, 100, 50), 'noir');
    assert.ok(noir[0] === noir[1] && noir[1] === noir[2], 'noir is grey');
    const unknown = context.applySnapFilterPixels(pixel(10, 20, 30), 'nope');
    assert.deepEqual([...unknown], [10, 20, 30, 255], 'unknown filter changes nothing');
});

test('rotation snaps near multiples of 90 degrees, text on full backgrounds stays readable', () => {
    assert.equal(context.snapEditorRotation(Math.PI / 2 + 0.05), Math.PI / 2);
    assert.equal(context.snapEditorRotation(0.3), 0.3, 'free in between');
    assert.equal(context.snapEditorRotation(-0.04), -0);
    assert.equal(context.contrastTextColor('#ffffff'), '#111111');
    assert.equal(context.contrastTextColor('#111111'), '#ffffff');
    assert.deepEqual({ ...context.snapItemColors({ kind: 'text', color: '#f59e0b', background: 'solid' }) }, { text: '#111111', box: '#f59e0b' });
    assert.deepEqual({ ...context.snapItemColors({ kind: 'text', color: '#ffffff', background: 'none' }) }, { text: '#ffffff', box: null });
    assert.deepEqual({ ...context.snapItemColors({ kind: 'emoji', color: '#ffffff' }) }, { text: '#ffffff', box: null });
});
