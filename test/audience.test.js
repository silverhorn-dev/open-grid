import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { I18N_STUBS } from './i18n-stubs.js';

// "Nur zeigen fuer ..." (audience.js): kompakter Binaer-Code, Pruefung beim Betrachter.
const SCHEMA = [
    { key: 'displayName', type: 'string' },
    { key: 'age', type: 'number', min: 18, max: 99 },
    { key: 'role', type: 'select', options: ['Top', 'Bottom', 'Versatile', 'Side'] },
    { key: 'tribes', type: 'multiselect', options: ['Bear', 'Twink', 'Femme', 'Otter'] }
];

function loadAudience() {
    const context = { state: { myProfile: { fields: {} } }, PROFILE_SCHEMA: SCHEMA, btoa, atob, Math, Number, Array, String, Object, Set };
    vm.runInNewContext(readFileSync(new URL('../client/app/audience.js', import.meta.url), 'utf8'), Object.assign(context, I18N_STUBS));
    return context;
}

test('the rule is a short binary code, empty rule = no code', () => {
    const context = loadAudience();
    assert.equal(context.encodeAudience({ ranges: {}, options: {} }), null);
    const code = context.encodeAudience({ ranges: { age: { min: 21, max: 35 } }, options: { tribes: ['Twink', 'Femme'] } });
    assert.match(code, /^[A-Za-z0-9_-]+$/);
    assert.ok(code.length <= 12, `compact: ${code} (${code.length})`);
    const entries = [...context.decodeAudience(code)].map(entry => ({ ...entry }));
    assert.deepEqual(entries, [
        { index: 1, kind: 'range', min: 21, max: 35 },
        { index: 3, kind: 'mask', mask: 0b0110 }
    ]);
});

test('viewers: OR within a field, AND between fields, a missing own value does not match', () => {
    const context = loadAudience();
    const code = context.encodeAudience({ ranges: { age: { min: 21, max: 35 } }, options: { tribes: ['Twink', 'Femme'] } });
    assert.equal(context.audienceAllows(code, { age: 24, tribes: ['Femme', 'Otter'] }), true);
    assert.equal(context.audienceAllows(code, { age: 24, tribes: ['Bear'] }), false, 'wrong tribe');
    assert.equal(context.audienceAllows(code, { age: 40, tribes: ['Twink'] }), false, 'too old');
    assert.equal(context.audienceAllows(code, { tribes: ['Twink'] }), false, 'no age given');
    assert.equal(context.audienceAllows(context.encodeAudience({ options: { role: ['Top'] } }), { role: 'Top' }), true);
});

test('a changed schema or a broken code is ignored instead of applied wrongly', () => {
    const context = loadAudience();
    const code = context.encodeAudience({ options: { role: ['Top'] } });
    const changed = [...SCHEMA.slice(0, 2), { key: 'role', type: 'select', options: ['Top', 'Bottom'] }, SCHEMA[3]];
    assert.equal(context.decodeAudience(code, changed), null, 'fingerprint differs');
    assert.equal(context.audienceAllows(code, { role: 'Bottom' }, changed), true, 'ignored -> visible');
    assert.equal(context.decodeAudience('!!'), null);
    assert.equal(context.decodeAudience(code.slice(0, -2)), null, 'truncated');
    assert.equal(context.audienceAllows(undefined, {}), true, 'no rule');
});
