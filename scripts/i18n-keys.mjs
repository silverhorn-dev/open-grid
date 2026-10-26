#!/usr/bin/env node
/**
 * Prueft die Uebersetzungen (i18n/<sprache>.properties) gegen die Nutzung:
 *   - t('bereich.name')-Aufrufe in client/*.js und client/app/*.js
 *   - swText('sw.name')-Aufrufe in client/sw.js (Benachrichtigungstexte)
 *   - data-i18n="..." und data-i18n-attr="attr:schluessel;..." in index.html
 * Aufruf: node scripts/i18n-keys.mjs           -> Bericht (fehlend, ungenutzt, Platzhalter)
 * Wird auch von test/i18n.test.js genutzt.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseProperties } from '../server/i18n.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function clientFiles() {
    const files = [];
    for (const dir of ['client', 'client/app']) {
        for (const name of readdirSync(join(root, dir))) {
            if (name.endsWith('.js') && name !== 'sw.js') files.push(join(root, dir, name));
        }
    }
    return files;
}

export function usedKeys() {
    const keys = new Set();
    for (const file of clientFiles()) {
        for (const match of readFileSync(file, 'utf8').matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)) keys.add(match[1]);
    }
    for (const match of readFileSync(join(root, 'client', 'sw.js'), 'utf8').matchAll(/\bswText\('([a-zA-Z0-9_.]+)'/g)) keys.add(match[1]);
    const html = readFileSync(join(root, 'index.html'), 'utf8');
    for (const match of html.matchAll(/\sdata-i18n="([^"]+)"/g)) keys.add(match[1]);
    for (const match of html.matchAll(/\sdata-i18n-attr="([^"]+)"/g)) {
        for (const pair of match[1].split(';')) keys.add(pair.split(':')[1]);
    }
    return keys;
}

export function languages() {
    return readdirSync(join(root, 'i18n')).filter(file => /^[a-z]{2}\.properties$/.test(file)).map(file => file.slice(0, 2)).sort();
}

export function loadMessages(language) {
    return parseProperties(readFileSync(join(root, 'i18n', `${language}.properties`), 'utf8'));
}

export const placeholders = text => [...String(text).matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();

export function report() {
    const used = usedKeys();
    const result = {};
    const base = loadMessages('de');
    for (const language of languages()) {
        const messages = loadMessages(language);
        result[language] = {
            missing: [...used].filter(key => !(key in messages)).sort(),
            unused: Object.keys(messages).filter(key => !used.has(key)).sort(),
            placeholderMismatch: Object.keys(messages)
                .filter(key => key in base && placeholders(messages[key]).join() !== placeholders(base[key]).join())
                .sort()
        };
    }
    return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    console.log(JSON.stringify(report(), null, 2));
}
