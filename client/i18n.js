// ================= SPRACHEN (i18n) =================
// Quelltexte sind deutsch und dienen als Schluessel: t('Neue Nachricht') liefert in Deutsch den Text
// selbst, in anderen Sprachen den Eintrag aus I18N_MESSAGES[lang] (client/i18n/<lang>.js), sonst den
// deutschen Text. Platzhalter: t('Video zu gross (hoechstens {max} MB).', { max: 25 }).
// Das statische Markup (index.html) wird einmal beim Start uebersetzt, bevor Nutzerinhalte im DOM
// stehen; Texte aus JavaScript gehen ueber t(). Ein Sprachwechsel laedt die Seite neu.
// Sprache: Einstellung "Automatisch" (Sprache des Geraets), "de" oder "en"; Standard vom Router
// (CLIENT_DEFAULTS.language), lokal in localStorage `opengrid-language`.
const I18N_LANGUAGES = ['de', 'en'];
const I18N_STORAGE_KEY = 'opengrid-language';
const I18N_MESSAGES = {};
const I18N_ATTRIBUTES = ['placeholder', 'title', 'aria-label', 'alt'];
// Bereiche, deren Inhalt nie uebersetzt wird (Protokolle, technische Ausgaben).
const I18N_SKIP_SELECTOR = 'script, style, textarea, code, pre, [data-no-i18n], #debug-log-output';

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

function t(source, params) {
    const text = currentLanguage === 'de' ? source : (I18N_MESSAGES[currentLanguage]?.[source] ?? source);
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

// Texte aus dem Profil-Schema: Zeichenkette (wird wie ein Quelltext behandelt) oder { de, en, ... }.
function localizedText(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value[currentLanguage] ?? value.de ?? value.en ?? Object.values(value)[0] ?? '';
    }
    return typeof value === 'string' ? t(value) : value;
}

// Markup-Texte: Zeilenumbrueche und Einrueckung zaehlen nicht (Schluessel mit einfachen Leerzeichen).
function normalizeI18nKey(value) {
    return value.replace(/\s+/g, ' ').trim();
}

function translateTextValue(value) {
    const key = normalizeI18nKey(value);
    if (!key) return value;
    const translated = t(key);
    if (translated === key) return value;
    const leading = value.match(/^\s*/)[0];
    const trailing = value.match(/\s*$/)[0];
    return `${leading}${translated}${trailing}`;
}

// Einmal beim Start: Textknoten und Attribute des statischen Markups.
function translateStaticMarkup(root = document.body) {
    document.documentElement.lang = currentLanguage;
    if (currentLanguage === 'de' || !root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: node => (node.parentElement?.closest(I18N_SKIP_SELECTOR) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(node => {
        node.nodeValue = translateTextValue(node.nodeValue);
    });
    root.querySelectorAll(I18N_ATTRIBUTES.map(name => `[${name}]`).join(',')).forEach(element => {
        if (element.closest(I18N_SKIP_SELECTOR)) return;
        I18N_ATTRIBUTES.forEach(name => {
            const value = element.getAttribute(name);
            if (value) element.setAttribute(name, translateTextValue(value));
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

// Alle Skripte stehen am Ende von <body>: hier ist das Markup komplett, die Woerterbuecher sind geladen
// und es gibt noch keine Nutzerinhalte im DOM.
document.addEventListener('DOMContentLoaded', () => {
    translateStaticMarkup();
    renderLanguageSetting();
});
