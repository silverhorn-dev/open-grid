import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { I18N_STUBS } from './i18n-stubs.js';
import { applyAudienceMinimum, audienceSchemaFingerprint, encodeAudience, parseAudienceMinimum } from '../server/audience.js';

// "Nur zeigen fuer ...": Client (client/app/audience.js) und Router (server/audience.js) muessen
// denselben Code erzeugen; der Router mischt Mindestwerte hinein.
const SCHEMA = [
    { key: 'displayName', type: 'string' },
    { key: 'age', type: 'number', min: 18, max: 99 },
    { key: 'role', type: 'select', options: ['Top', 'Bottom', 'Versatile', 'Side'] },
    { key: 'tribes', type: 'multiselect', options: ['Bear', 'Twink', 'Femme', 'Otter'] }
];

function loadClient() {
    const context = { state: { myProfile: { fields: {} } }, PROFILE_SCHEMA: SCHEMA, btoa, atob, Math, Number, Array, String, Object, Set };
    vm.runInNewContext(readFileSync(new URL('../client/app/audience.js', import.meta.url), 'utf8'), Object.assign(context, I18N_STUBS));
    return context;
}

test('client and router produce the same code and fingerprint', () => {
    const client = loadClient();
    assert.equal(client.audienceSchemaFingerprint(SCHEMA), audienceSchemaFingerprint(SCHEMA));
    const rules = [
        { ranges: { age: { min: 21, max: 35 } }, options: { tribes: ['Twink', 'Femme'] } },
        { options: { role: ['Top'] } },
        { ranges: { age: { min: 18 } } },
        { ranges: {}, options: {} }
    ];
    for (const rule of rules) assert.equal(client.encodeAudience(rule, SCHEMA), encodeAudience(rule, SCHEMA), JSON.stringify(rule));
});

test('relative rules resolve against the own profile; a missing own value drops that part', () => {
    const client = loadClient();
    const rule = { ranges: { age: { relative: 'same' } }, options: { role: 'same' } };
    const resolved = client.resolveAudienceRule(rule, { age: 30, role: 'Top' });
    assert.deepEqual(JSON.parse(JSON.stringify(resolved)), { ranges: { age: { min: 27, max: 33 } }, options: { role: ['Top'] } });
    assert.deepEqual(JSON.parse(JSON.stringify(client.resolveAudienceRule({ ranges: { age: { relative: 'older' } } }, { age: 30 }).ranges.age)), { min: 30, max: null });
    assert.deepEqual(JSON.parse(JSON.stringify(client.resolveAudienceRule({ ranges: { age: { relative: 'younger' } } }, { age: 30 }).ranges.age)), { min: null, max: 30 });
    assert.deepEqual(JSON.parse(JSON.stringify(client.resolveAudienceRule(rule, {}))), { ranges: {}, options: {} });
    // Aufgeloest wie ein fester Bereich: Viewer 29 passt, 40 nicht.
    const code = client.encodeAudience(resolved, SCHEMA);
    assert.equal(client.audienceAllows(code, { age: 29, role: 'Top' }, SCHEMA), true);
    assert.equal(client.audienceAllows(code, { age: 40, role: 'Top' }, SCHEMA), false);
});

test('the router merges the operator minimum into every card', () => {
    const client = loadClient();
    const minimum = parseAudienceMinimum('{"ranges":{"age":{"min":18}}}', SCHEMA);
    // Ohne eigene Regel: nur der Mindestwert.
    const onlyMinimum = applyAudienceMinimum(null, minimum, SCHEMA);
    assert.equal(client.audienceAllows(onlyMinimum, { age: 17 }, SCHEMA), false);
    assert.equal(client.audienceAllows(onlyMinimum, { age: 18 }, SCHEMA), true);
    assert.equal(client.audienceAllows(onlyMinimum, {}, SCHEMA), false, 'no age given: fail closed');
    // Eigene Regel 16-30 wird enger: 18-30; andere Felder bleiben.
    const own = encodeAudience({ ranges: { age: { min: 16, max: 30 } }, options: { role: ['Top'] } }, SCHEMA);
    const merged = applyAudienceMinimum(own, minimum, SCHEMA);
    assert.equal(client.audienceAllows(merged, { age: 17, role: 'Top' }, SCHEMA), false);
    assert.equal(client.audienceAllows(merged, { age: 25, role: 'Top' }, SCHEMA), true);
    assert.equal(client.audienceAllows(merged, { age: 25, role: 'Bottom' }, SCHEMA), false);
    // Ohne Mindestwert bleibt der Code unveraendert.
    assert.equal(applyAudienceMinimum(own, null, SCHEMA), own);
});
