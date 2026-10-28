import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { I18N_STUBS } from './i18n-stubs.js';

// Grid-Filter (grid-filter.js): nur auf dem Geraet, Zahlen von-bis, Auswahl ODER, Felder UND.
function loadGridFilter() {
    const context = {
        state: { cachedProfiles: {}, gridFilter: null },
        PROFILE_SCHEMA: [
            { key: 'displayName', type: 'string' },
            { key: 'age', type: 'number', min: 18, max: 99 },
            { key: 'role', type: 'select', options: ['Top', 'Bottom', 'Versatile'] },
            { key: 'tribes', type: 'multiselect', options: ['Bear', 'Twink', 'Femme'] }
        ],
        DISTANCE_BUCKET_LABELS: {},
        document: { getElementById: () => null, querySelector: () => null, addEventListener: () => {} },
        Number, Array, Object, Set, Math
    };
    vm.runInNewContext(readFileSync(new URL('../client/app/grid-filter.js', import.meta.url), 'utf8'), Object.assign(context, I18N_STUBS));
    context.state.gridFilter = context.emptyGridFilter();
    return context;
}

test('numbers from-to, selections OR within a field, AND between fields', () => {
    const context = loadGridFilter();
    const { state } = context;
    state.cachedProfiles = {
        mia: { fields: { age: 24, role: 'Bottom', tribes: ['Twink'] } },
        ben: { fields: { age: 41, role: 'Top', tribes: ['Bear'] } },
        sam: { fields: { age: 30, role: 'Versatile', tribes: ['Femme', 'Twink'] } }
    };
    assert.equal(context.gridFilterVerdict('mia'), 'match', 'no filter');
    state.gridFilter.ranges = { age: { min: 20, max: 35 } };
    state.gridFilter.options = { tribes: ['Twink', 'Femme'] };
    assert.equal(context.gridFilterVerdict('mia'), 'match');
    assert.equal(context.gridFilterVerdict('ben'), 'no', 'age and tribe out');
    assert.equal(context.gridFilterVerdict('sam'), 'match', 'one of several tribes is enough');
    state.gridFilter.options.role = ['Top'];
    assert.equal(context.gridFilterVerdict('sam'), 'no', 'AND between fields');
});

test('missing profiles are unknown; matching first, unknown after, unknown can be hidden', () => {
    const context = loadGridFilter();
    const { state } = context;
    state.cachedProfiles = { mia: { fields: { age: 24 } }, ben: { fields: { age: 50 } } };
    state.gridFilter.ranges = { age: { min: 20, max: 35 } };
    const cards = [{ id: 'nobody' }, { id: 'ben' }, { id: 'mia' }];
    assert.deepEqual([...context.applyGridFilter(cards)].map(card => card.id), ['mia', 'nobody']);
    state.gridFilter.unknown = false;
    assert.deepEqual([...context.applyGridFilter(cards)].map(card => card.id), ['mia']);
});

test('distance and photo come from the grid card', () => {
    const context = loadGridFilter();
    const { state } = context;
    state.gridFilter.maxDistance = '1-5';
    assert.equal(context.gridFilterVerdict('a', { distanceBucket: 'lt1' }), 'match');
    assert.equal(context.gridFilterVerdict('a', { distanceBucket: '5-20' }), 'no');
    state.gridFilter.maxDistance = null;
    state.gridFilter.photo = true;
    assert.equal(context.gridFilterVerdict('a', { avatar: null }), 'no');
    assert.equal(context.gridFilterVerdict('a', { avatar: 'data:image/jpeg;base64,AA' }), 'match');
});
