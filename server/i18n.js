// Uebersetzungen: i18n/<sprache>.properties (UTF-8, `schluessel=wert`, `#` Kommentar). Der Server liest
// sie beim Start und liefert pro Sprache ein kleines Skript `/client/i18n/<sprache>.js` aus, damit der
// Browser nichts parsen muss und nur die aktive Sprache laedt.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const LANGUAGE_FILE = /^([a-z]{2})\.properties$/;

// Teilmenge des Java-Formats: `=` oder `:` trennt, `\` am Zeilenende setzt fort, Escapes \n \t \\ \uXXXX,
// fuehrendes `\ ` erhaelt ein Leerzeichen.
export function parseProperties(text) {
    const messages = {};
    const lines = text.replace(/^﻿/, '').split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
        let line = lines[index].replace(/^\s+/, '');
        if (!line || line.startsWith('#') || line.startsWith('!')) continue;
        while (/(^|[^\\])(\\\\)*\\$/.test(line) && index + 1 < lines.length) {
            line = line.slice(0, -1) + lines[++index].replace(/^\s+/, '');
        }
        const separator = line.search(/(?<!\\)[=:]/);
        if (separator < 0) continue;
        const key = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).replace(/^\s*/, match => (match.endsWith('\\') ? '' : ''));
        messages[key] = unescapeValue(value.replace(/^[ \t\f]+/, ''));
    }
    return messages;
}

function unescapeValue(value) {
    return value.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (match, code) => {
        if (code.startsWith('u') && code.length === 5) return String.fromCharCode(parseInt(code.slice(1), 16));
        return { n: '\n', t: '\t', r: '\r', f: '\f' }[code] ?? code;
    });
}

export async function loadTranslations(directory) {
    const translations = {};
    for (const file of (await readdir(directory)).sort()) {
        const match = file.match(LANGUAGE_FILE);
        if (match) translations[match[1]] = parseProperties(await readFile(join(directory, file), 'utf8'));
    }
    return translations;
}

export function translationScript(language, messages, globalName = 'I18N_MESSAGES') {
    return `${globalName}[${JSON.stringify(language)}] = ${JSON.stringify(messages)};\n`;
}
