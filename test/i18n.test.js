import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { allKeys, loadMessages } from '../scripts/i18n-keys.mjs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();

function loadI18n({ stored = null, routerDefault = null, languages = ['de-DE'], messages = {} } = {}) {
    const storage = new Map();
    if (stored) storage.set('opengrid-language', stored);
    if (routerDefault) storage.set('opengrid-language-router-default', routerDefault);
    const context = {
        window: {
            localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
            location: { reload: () => { context.reloaded = true; } }
        },
        navigator: { languages, language: languages[0] },
        document: { addEventListener: () => {}, documentElement: {} },
        Date,
        reloaded: false
    };
    vm.createContext(context);
    vm.runInContext(read('client/i18n.js'), context);
    vm.runInContext(`Object.assign(I18N_MESSAGES, ${JSON.stringify(messages)})`, context);
    // const/let liegen nicht auf dem globalen Objekt: ueber die VM lesen.
    Object.defineProperty(context, 'currentLanguage', { get: () => vm.runInContext('currentLanguage', context) });
    return context;
}

test('every German source text has an English translation', () => {
    const english = loadMessages('en');
    const missing = [...allKeys()].filter(key => !(key in english));
    assert.deepEqual(missing, [], `missing in client/i18n/en.js: ${missing.join(' | ')}`);
});

test('the English dictionary has no stale entries', () => {
    const keys = allKeys();
    const stale = Object.keys(loadMessages('en')).filter(key => !keys.has(key));
    assert.deepEqual(stale, [], `no longer used: ${stale.join(' | ')}`);
});

test('translations keep the same placeholders', () => {
    const english = loadMessages('en');
    for (const [source, translation] of Object.entries(english)) {
        assert.deepEqual(placeholders(translation), placeholders(source), `placeholders differ: ${source}`);
    }
});

test('t() fills placeholders and falls back to the German source', () => {
    const i18n = loadI18n({ stored: 'en', messages: { en: { 'Hallo {name}': 'Hello {name}' } } });
    assert.equal(i18n.t('Hallo {name}', { name: 'Alex' }), 'Hello Alex');
    assert.equal(i18n.t('Nicht uebersetzt'), 'Nicht uebersetzt');
    assert.equal(i18n.localizedText({ de: 'Alter', en: 'Age' }), 'Age');
    assert.equal(i18n.localizedText(26), 26);
});

test('language: own choice before router default before device', () => {
    assert.equal(loadI18n({ languages: ['en-US'] }).currentLanguage, 'en');
    assert.equal(loadI18n({ languages: ['fr-FR'] }).currentLanguage, 'de');
    assert.equal(loadI18n({ languages: ['en-US'], routerDefault: 'de' }).currentLanguage, 'de');
    assert.equal(loadI18n({ languages: ['de-DE'], routerDefault: 'de', stored: 'en' }).currentLanguage, 'en');
    assert.equal(loadI18n({ languages: ['en-GB'], stored: 'auto', routerDefault: 'de' }).currentLanguage, 'en');
});

test('switching the language reloads only when it changes', () => {
    const i18n = loadI18n({ languages: ['de-DE'] });
    i18n.setLanguage('de');
    assert.equal(i18n.reloaded, false);
    i18n.setLanguage('en');
    assert.equal(i18n.reloaded, true);
});

test('clock times are always 24 h', () => {
    const i18n = loadI18n({ stored: 'en' });
    assert.match(i18n.formatClockTime(new Date(2026, 9, 26, 21, 5).getTime()), /^21:05$/);
});
