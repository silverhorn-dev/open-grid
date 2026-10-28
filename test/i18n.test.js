import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { parseProperties } from '../server/i18n.js';
import { languages, report } from '../scripts/i18n-keys.mjs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function loadI18n({ stored = null, routerDefault = null, languages: deviceLanguages = ['de-DE'], messages = {} } = {}) {
    const storage = new Map();
    if (stored) storage.set('opengrid-language', stored);
    if (routerDefault) storage.set('opengrid-language-router-default', routerDefault);
    const written = [];
    const context = {
        window: {
            localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
            location: { reload: () => { context.reloaded = true; } }
        },
        navigator: { languages: deviceLanguages, language: deviceLanguages[0] },
        document: { addEventListener: () => {}, documentElement: {}, currentScript: { src: '/client/i18n.js?v=42' }, write: html => written.push(html) },
        Date,
        reloaded: false,
        written
    };
    vm.createContext(context);
    vm.runInContext(read('client/i18n.js'), context);
    vm.runInContext(`Object.assign(I18N_MESSAGES, ${JSON.stringify(messages)})`, context);
    // const/let liegen nicht auf dem globalen Objekt: ueber die VM lesen.
    Object.defineProperty(context, 'currentLanguage', { get: () => vm.runInContext('currentLanguage', context) });
    return context;
}

test('every used key exists in every language, nothing unused, placeholders match', () => {
    const result = report();
    assert.deepEqual(languages(), ['de', 'en']);
    for (const [language, problems] of Object.entries(result)) {
        assert.deepEqual(problems, { missing: [], unused: [], placeholderMismatch: [] }, `${language}: ${JSON.stringify(problems)}`);
    }
});

// Doppelte Schluessel ueberschreiben sich still (der letzte gewinnt).
test('no key is defined twice in a language file', () => {
    for (const language of ['de', 'en']) {
        const keys = read(`i18n/${language}.properties`).split('\n')
            .map(line => line.trim())
            .filter(line => line && !line.startsWith('#') && !line.startsWith('!') && line.includes('='))
            .map(line => line.slice(0, line.indexOf('=')).trim());
        const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index);
        assert.deepEqual(duplicates, [], `${language}: ${duplicates.join(', ')}`);
    }
});

test('properties parser: separators, escapes, leading spaces, continuation', () => {
    const parsed = parseProperties('# comment\na.b=Hallo {name}\nc.d : Wert\ne.f=\\ · mit Leerzeichen\ng.h=Zeile\\\n    weiter\ni.j=Gr\\u00fc\\u00dfe\nk.l=echtes ü\n');
    assert.deepEqual(parsed, { 'a.b': 'Hallo {name}', 'c.d': 'Wert', 'e.f': ' · mit Leerzeichen', 'g.h': 'Zeileweiter', 'i.j': 'Grüße', 'k.l': 'echtes ü' });
});

test('only the active language bundle is loaded, with the asset version', () => {
    const i18n = loadI18n({ stored: 'en' });
    assert.deepEqual(i18n.written, ['<script src="/client/i18n/en.js?v=42"></script>']);
});

test('t() fills placeholders and shows the key when missing', () => {
    const i18n = loadI18n({ stored: 'en', messages: { en: { 'demo.hello': 'Hello {name}' } } });
    assert.equal(i18n.t('demo.hello', { name: 'Alex' }), 'Hello Alex');
    assert.equal(i18n.t('demo.missing'), 'demo.missing');
    assert.equal(i18n.localizedText({ de: 'Alter', en: 'Age' }), 'Age');
    assert.equal(i18n.localizedText('Status'), 'Status', 'operator texts stay as they are');
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
