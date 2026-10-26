// i18n-Funktionen (client/i18n.js) fuer Tests, die einzelne Client-Dateien in einer VM laden:
// deutsch, also Quelltext mit eingesetzten Platzhaltern.
export const I18N_STUBS = {
    t: (source, params) => (params ? source.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name]))) : source),
    localizedText: value => (value && typeof value === 'object' && !Array.isArray(value) ? value.de ?? value.en : value),
    formatClockTime: timestamp => new Date(timestamp).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
    i18nLocale: () => 'de-DE'
};
