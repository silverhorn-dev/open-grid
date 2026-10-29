// ================= SPRACHEN (i18n) =================
// Texte stehen unter Schluesseln (`bereich.name`) in i18n/<sprache>.properties. Der Server macht daraus
// /client/i18n/<sprache>.js; hier wird nur die aktive Sprache geladen. t('chat.send') liefert den Text,
// Platzhalter: t('video.tooLargeAtMost', { value: 25 }). Fehlt ein Schluessel, erscheint er selbst (Tests
// verhindern das). Statisches Markup traegt `data-i18n="schluessel"` bzw.
// `data-i18n-attr="placeholder:schluessel;title:schluessel"` und wird einmal beim Start gefuellt,
// bevor Nutzerinhalte im DOM stehen. Ein Sprachwechsel laedt die Seite neu.
// Sprache: Einstellung "Automatisch" (Sprache des Geraets), "de" oder "en"; Standard vom Router
// (CLIENT_DEFAULTS.language), lokal in localStorage `opengrid-language`.
const I18N_LANGUAGES = ['de', 'en'];
const I18N_STORAGE_KEY = 'opengrid-language';
const I18N_MESSAGES = {};

function storedLanguagePreference() {
    try {
        const stored = window.localStorage.getItem(I18N_STORAGE_KEY);
        return stored === 'auto' || I18N_LANGUAGES.includes(stored) ? stored : null;
    } catch {
        return null;
    }
}

function resolveLanguage(preference, routerDefault, deviceLanguages) {
    const choice = preference || routerDefault || 'auto';
    if (I18N_LANGUAGES.includes(choice)) return choice;
    const device = (deviceLanguages || []).map(language => String(language).slice(0, 2).toLowerCase());
    return device.find(language => I18N_LANGUAGES.includes(language)) || 'de';
}

// Sprache beim Start: eigene Wahl, sonst der zuletzt bekannte Router-Standard, sonst das Geraet.
function initialLanguage() {
    let routerDefault = null;
    try {
        routerDefault = window.localStorage.getItem(`${I18N_STORAGE_KEY}-router-default`);
    } catch {
        routerDefault = null;
    }
    return resolveLanguage(storedLanguagePreference(), routerDefault, navigator.languages || [navigator.language]);
}

let currentLanguage = initialLanguage();
// Sofort beim Laden des Kopfs: der Browser erkennt die Seitensprache frueh. Stand hier fest "de", bot Chrome
// auch fuer die englische Oberflaeche eine Uebersetzung an (und umgekehrt).
document.documentElement.lang = currentLanguage;

// Woerterbuch der aktiven Sprache: synchron per document.write, damit es vor den App-Skripten da ist
// (die nutzen t() teils schon beim Laden). Gleiche Herkunft, also mit der CSP `script-src 'self'` erlaubt.
function loadLanguageBundle() {
    const version = (document.currentScript?.src.match(/[?&]v=([^&]+)/) || [])[1] || '';
    document.write(`<script src="/client/i18n/${currentLanguage}.js${version ? `?v=${version}` : ''}"><\/script>`);
}

function t(key, params) {
    const text = I18N_MESSAGES[currentLanguage]?.[key] ?? key;
    if (!params) return text;
    return text.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name])));
}

// Uhrzeiten ueberall gleich: 24 Stunden, ohne Sekunden.
function i18nLocale() {
    return currentLanguage === 'en' ? 'en-GB' : 'de-DE';
}

function formatClockTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString(i18nLocale(), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

// Texte aus dem Profil-Schema (vom Betreiber): Zeichenkette (bleibt wie sie ist) oder { de, en, ... }.
function localizedText(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value[currentLanguage] ?? value.de ?? value.en ?? Object.values(value)[0] ?? '';
    }
    return value;
}

// Einmal beim Start: alle markierten Elemente und Attribute des statischen Markups.
function translateStaticMarkup(root = document) {
    document.documentElement.lang = currentLanguage;
    root.querySelectorAll('[data-i18n]').forEach(element => {
        element.textContent = t(element.dataset.i18n);
    });
    root.querySelectorAll('[data-i18n-attr]').forEach(element => {
        element.dataset.i18nAttr.split(';').forEach(pair => {
            const [attribute, key] = pair.split(':');
            if (attribute && key) element.setAttribute(attribute.trim(), t(key.trim()));
        });
    });
}

function languagePreference() {
    return storedLanguagePreference() || 'auto';
}

// Router-Standard merken (wirkt ab dem naechsten Start, wenn der Nutzer nichts gewaehlt hat).
function rememberRouterLanguageDefault(value) {
    try {
        if (value === 'auto' || I18N_LANGUAGES.includes(value)) {
            window.localStorage.setItem(`${I18N_STORAGE_KEY}-router-default`, value);
        } else {
            window.localStorage.removeItem(`${I18N_STORAGE_KEY}-router-default`);
        }
    } catch {
        // Ohne localStorage gilt die Sprache des Geraets.
    }
    const routerDefault = I18N_LANGUAGES.includes(value) || value === 'auto' ? value : null;
    const next = resolveLanguage(storedLanguagePreference(), routerDefault, navigator.languages || [navigator.language]);
    if (next !== currentLanguage && !storedLanguagePreference()) reloadForLanguage();
}

function setLanguage(value) {
    const preference = value === 'auto' || I18N_LANGUAGES.includes(value) ? value : 'auto';
    try {
        window.localStorage.setItem(I18N_STORAGE_KEY, preference);
    } catch {
        // Ohne localStorage bleibt es bei dieser Sitzung.
    }
    const next = resolveLanguage(preference, null, navigator.languages || [navigator.language]);
    if (next !== currentLanguage) reloadForLanguage();
}

function reloadForLanguage() {
    window.location.reload();
}

function renderLanguageSetting() {
    const select = document.getElementById('language-select');
    if (select) select.value = languagePreference();
}

loadLanguageBundle();

// Alle Skripte stehen am Ende von <body>: hier ist das Markup komplett, das Woerterbuch ist geladen
// und es gibt noch keine Nutzerinhalte im DOM.
document.addEventListener('DOMContentLoaded', () => {
    translateStaticMarkup();
    renderLanguageSetting();
});
