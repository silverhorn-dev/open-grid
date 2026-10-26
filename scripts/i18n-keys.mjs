#!/usr/bin/env node
/**
 * Sammelt alle uebersetzbaren Quelltexte (deutsch):
 *   - statisches Markup in index.html (Textknoten und placeholder/title/aria-label/alt)
 *   - t('...')-Aufrufe in client/*.js und client/app/*.js
 * Aufruf: node scripts/i18n-keys.mjs [--missing en]  -> listet Schluessel (bzw. fehlende Uebersetzungen)
 * Wird auch von test/i18n.test.js genutzt.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_BLOCKS = /<(script|style|textarea|code|pre)\b[\s\S]*?<\/\1>/gi;

function decodeEntities(text) {
    return text
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
}

const normalize = value => value.replace(/\s+/g, ' ').trim();
const isText = value => /[A-Za-zÄÖÜäöüß]{2}/.test(value) && !/\{\{|\}\}/.test(value);

export function markupKeys() {
    let html = readFileSync(join(root, 'index.html'), 'utf8');
    html = html.slice(html.indexOf('<body'));
    // Bereiche, die nie uebersetzt werden (wie I18N_SKIP_SELECTOR in client/i18n.js).
    html = html.replace(SKIP_BLOCKS, '').replace(/<div id="debug-log-output"[\s\S]*?<\/div>\s*<\/div>/, '');
    const keys = new Set();
    for (const match of html.matchAll(/>([^<>]+)</g)) {
        const key = normalize(decodeEntities(match[1]));
        if (isText(key)) keys.add(key);
    }
    for (const match of html.matchAll(/\s(?:placeholder|title|aria-label|alt)="([^"]*)"/g)) {
        const key = normalize(decodeEntities(match[1]));
        if (isText(key)) keys.add(key);
    }
    return keys;
}

function clientFiles() {
    const files = [];
    for (const dir of ['client', 'client/app']) {
        for (const name of readdirSync(join(root, dir))) {
            if (name.endsWith('.js') && name !== 'sw.js') files.push(join(root, dir, name));
        }
    }
    return files;
}

export function codeKeys() {
    const keys = new Set();
    for (const file of clientFiles()) {
        const source = readFileSync(file, 'utf8');
        for (const match of source.matchAll(/\bt\('((?:[^'\\\n]|\\.)*)'/g)) {
            keys.add(match[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\'));
        }
    }
    return keys;
}

export function allKeys() {
    return new Set([...markupKeys(), ...codeKeys()]);
}

export function loadMessages(language) {
    const context = { I18N_MESSAGES: {} };
    vm.runInNewContext(readFileSync(join(root, 'client', 'i18n', `${language}.js`), 'utf8'), context);
    return context.I18N_MESSAGES[language] || {};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const index = process.argv.indexOf('--missing');
    const keys = [...allKeys()].sort();
    if (index > 0) {
        const messages = loadMessages(process.argv[index + 1]);
        keys.filter(key => !(key in messages)).forEach(key => console.log(JSON.stringify(key)));
    } else {
        keys.forEach(key => console.log(JSON.stringify(key)));
    }
}
