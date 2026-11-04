import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { parseProcStatus } from '../server/metrics.js';
import { I18N_STUBS } from './i18n-stubs.js';

test('splits the resident memory into own and file-backed parts from /proc', () => {
    const status = 'Name:\tnode\nVmRSS:\t  104432 kB\nRssAnon:\t   47224 kB\nRssFile:\t   57208 kB\nRssShmem:\t       0 kB\n';
    assert.deepEqual(parseProcStatus(status), { anon: 47224 * 1024, file: 57208 * 1024 });
    assert.deepEqual(parseProcStatus(''), { anon: null, file: null }, 'no /proc (macOS, Windows)');
});

function loadAdminTrend() {
    const noop = () => {};
    const context = {
        document: { addEventListener: noop, getElementById: () => null, querySelectorAll: () => [] },
        window: { addEventListener: noop, location: { pathname: '/admin' } },
        navigator: {},
        localStorage: { getItem: () => null, setItem: noop },
        fetch: async () => ({ ok: false, json: async () => ({}) }),
        console
    };
    vm.runInNewContext(readFileSync(new URL('../client/admin.js', import.meta.url), 'utf8'), Object.assign(context, I18N_STUBS));
    return context;
}

test('flags steadily growing own memory over at least six hours', () => {
    const { memoryTrend } = loadAdminTrend();
    const MB = 1024 * 1024;
    const start = Date.UTC(2026, 10, 4);
    const points = (hours, mbPerHour, noise = 0) => Array.from({ length: hours * 60 }, (_, minute) => ({
        at: start + minute * 60_000,
        memoryAnon: (40 + (minute / 60) * mbPerHour + (minute % 2 ? noise : -noise)) * MB
    }));
    const leak = memoryTrend(points(8, 5, 3));
    assert.ok(Math.abs(leak.mbPerHour - 5) < 0.2, `about 5 MB/h, got ${leak.mbPerHour}`);
    assert.ok(Math.abs(memoryTrend(points(8, 0, 4)).mbPerHour) < 0.2, 'flat but noisy stays flat');
    assert.equal(memoryTrend(points(3, 10)), null, 'too short to judge');
    assert.equal(memoryTrend([{ at: start, memory: 1 }]), null, 'old points without the split');
});
