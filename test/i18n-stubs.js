// i18n-Funktionen (client/i18n.js) fuer Tests, die einzelne Client-Dateien in einer VM laden:
// deutsch aus i18n/de.properties, Platzhalter eingesetzt.
import { readFileSync } from 'node:fs';
import { parseProperties } from '../server/i18n.js';

const GERMAN = parseProperties(readFileSync(new URL('../i18n/de.properties', import.meta.url), 'utf8'));

export const I18N_STUBS = {
    t: (key, params) => {
        const text = GERMAN[key] ?? key;
        return params ? text.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name]))) : text;
    },
    localizedText: value => (value && typeof value === 'object' && !Array.isArray(value) ? value.de ?? value.en : value),
    formatClockTime: timestamp => new Date(timestamp).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
    i18nLocale: () => 'de-DE',
    // ui.js: leere Zustaende (im Test ohne echtes DOM nur Platzhalter)
    createEmptyState: options => ({ emptyState: options }),
    showEmptyState: () => null
};
