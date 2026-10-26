// ================= INFO-SEITE =================
// Seiten aus info-site/pages/<sprache>/<seite>.md, Begriffe aus info-site/i18n/<sprache>.properties
// (vom Server als INFO_TERMS geliefert). Im Text:
//   ${begriff}        Begriff oder Textbaustein, darf selbst ${...} enthalten (rekursiv)
//   ${ui:schluessel}  Beschriftung aus der App (i18n/<sprache>.properties), damit Knopfnamen stimmen
// Im Modus "Einfach erklaert" gilt `begriff.plain`, falls vorhanden, sonst `begriff`. Grammatik: wo ein
// Wort je nach Satz anders gebeugt wird, gibt es eigene Formen (eigene Schluessel) oder der ganze Satz
// ist ein Baustein mit beiden Varianten. Fehlt etwas, erscheint [[schluessel]] (Tests verhindern das).
const INFO_TERMS = {};
const INFO_MODE_STORAGE_KEY = 'opengrid-info-mode';
const INFO_MODES = ['plain', 'tech'];
const MAX_TERM_DEPTH = 8;

let infoMode = readInfoMode();

function readInfoMode() {
    try {
        const stored = window.localStorage.getItem(INFO_MODE_STORAGE_KEY);
        return INFO_MODES.includes(stored) ? stored : 'plain';
    } catch {
        return 'plain';
    }
}

// Begriffe der aktiven Sprache synchron laden (wie das App-Woerterbuch in i18n.js).
(function loadInfoTerms() {
    const version = (document.currentScript?.src.match(/[?&]v=([^&]+)/) || [])[1] || '';
    document.write(`<script src="/info-site/i18n/${currentLanguage}.js${version ? `?v=${version}` : ''}"><\/script>`);
})();

function infoTerm(key, mode = infoMode) {
    const terms = INFO_TERMS[currentLanguage] || {};
    if (mode === 'plain' && terms[`${key}.plain`] !== undefined) return terms[`${key}.plain`];
    return terms[key];
}

// ${...} aufloesen; Schleifen und zu tiefe Verschachtelung brechen ab.
function resolveInfoText(text, mode = infoMode, trail = []) {
    return String(text).replace(/\$\{([a-zA-Z0-9_.:-]+)\}/g, (match, reference) => {
        if (reference.startsWith('ui:')) return t(reference.slice(3));
        if (trail.includes(reference) || trail.length >= MAX_TERM_DEPTH) return `[[${reference}]]`;
        const value = infoTerm(reference, mode);
        return value === undefined ? `[[${reference}]]` : resolveInfoText(value, mode, [...trail, reference]);
    });
}

const infoSite = {
    base: '',
    appUrl: '/',
    pages: [],
    loaded: null
};

function infoPageFromPath(pathname) {
    const rest = pathname.startsWith(infoSite.base) ? pathname.slice(infoSite.base.length) : pathname;
    const slug = rest.replace(/^\/+|\/+$/g, '') || 'index';
    return slug === 'news' || infoSite.pages.includes(slug) ? slug : null;
}

function infoPath(slug) {
    return `${infoSite.base}/${slug === 'index' ? '' : slug}`;
}

// Links im Text: page:seite, app:, relative Seitennamen, sonst http(s).
function resolveInfoLink(href) {
    if (href === 'app:' || href === 'app') return infoSite.appUrl || '/';
    if (href.startsWith('page:')) return infoPath(href.slice(5));
    if (/^[a-z0-9-]+$/.test(href)) return infoPath(href);
    return href;
}

function renderInfoControls() {
    const controls = document.getElementById('info-controls');
    const group = (label, options, active, onChoose) => {
        const wrapper = document.createElement('div');
        wrapper.className = 'info-toggle';
        wrapper.setAttribute('role', 'group');
        wrapper.setAttribute('aria-label', label);
        options.forEach(([value, text]) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = text;
            button.setAttribute('aria-pressed', String(value === active));
            if (value === active) button.classList.add('is-active');
            button.onclick = () => onChoose(value);
            wrapper.appendChild(button);
        });
        return wrapper;
    };
    controls.replaceChildren(
        group(resolveInfoText('${site.language}'), [['de', 'DE'], ['en', 'EN']], currentLanguage, value => setLanguage(value)),
        group(resolveInfoText('${site.mode}'), [['plain', resolveInfoText('${site.mode.plain}')], ['tech', resolveInfoText('${site.mode.tech}')]], infoMode, setInfoMode)
    );
}

function setInfoMode(mode) {
    if (!INFO_MODES.includes(mode) || mode === infoMode) return;
    infoMode = mode;
    try {
        window.localStorage.setItem(INFO_MODE_STORAGE_KEY, mode);
    } catch {
        // Nur fuer diese Sitzung.
    }
    renderInfoControls();
    renderInfoNav();
    renderInfoPage().catch(error => console.warn('[OpenGrid Info]', error));
}

function renderInfoNav() {
    const nav = document.getElementById('info-nav');
    const current = infoPageFromPath(window.location.pathname);
    nav.replaceChildren(...[...infoSite.pages, 'news'].map(slug => {
        const link = document.createElement('a');
        link.href = infoPath(slug);
        link.className = `info-nav-link${slug === current ? ' is-active' : ''}`;
        if (slug === current) link.setAttribute('aria-current', 'page');
        link.textContent = resolveInfoText(`\${site.page.${slug}}`);
        return link;
    }));
    const footer = document.getElementById('info-footer');
    const toApp = document.createElement('a');
    toApp.href = infoSite.appUrl || '/';
    toApp.className = 'btn-primary';
    toApp.textContent = resolveInfoText('${site.toApp}');
    const note = document.createElement('span');
    note.textContent = resolveInfoText('${site.footer}');
    footer.replaceChildren(note, toApp);
}

async function loadInfoSource(slug) {
    const url = slug === 'news' ? '/changelog.md' : `/info-site/pages/${currentLanguage}/${slug}.md`;
    if (infoSite.loaded?.url === url) return infoSite.loaded.text;
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    infoSite.loaded = { url, text };
    return text;
}

async function renderInfoPage() {
    const content = document.getElementById('info-content');
    const slug = infoPageFromPath(window.location.pathname);
    if (!slug) {
        content.replaceChildren(renderMarkdown(resolveInfoText('${site.notFound}'), { resolveLink: resolveInfoLink }));
        return;
    }
    const source = await loadInfoSource(slug);
    // Der Changelog ist nur deutsch und kennt keine Begriffe.
    const text = slug === 'news'
        ? (currentLanguage === 'de' ? source : `> ${resolveInfoText('${site.newsGermanOnly}')}\n\n${source}`)
        : resolveInfoText(source);
    content.replaceChildren(renderMarkdown(text, { resolveLink: resolveInfoLink }));
    const heading = content.querySelector('h1');
    document.title = heading ? `${heading.textContent} · OpenGrid` : 'OpenGrid';
}

function navigateInfo(href) {
    window.history.pushState({}, '', href);
    renderInfoNav();
    renderInfoPage().then(() => window.scrollTo(0, 0)).catch(error => console.warn('[OpenGrid Info]', error));
}

function initInfoSite() {
    const body = document.body;
    infoSite.base = body.dataset.base || '';
    infoSite.appUrl = body.dataset.appUrl || '/';
    infoSite.pages = (body.dataset.pages || '').split(',').filter(Boolean);
    document.getElementById('info-home').href = infoPath('index');
    document.addEventListener('click', event => {
        const link = event.target.closest('a[href]');
        if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
        const url = new URL(link.href, window.location.href);
        if (url.origin !== window.location.origin || !infoPageFromPath(url.pathname)) return;
        if (infoSite.base === '' && !url.pathname.match(/^\/[a-z0-9-]*$/)) return;
        if (infoSite.base && !url.pathname.startsWith(infoSite.base)) return;
        event.preventDefault();
        navigateInfo(url.pathname);
    });
    window.addEventListener('popstate', () => {
        renderInfoNav();
        renderInfoPage().catch(error => console.warn('[OpenGrid Info]', error));
    });
    renderInfoControls();
    renderInfoNav();
    renderInfoPage().catch(error => {
        document.getElementById('info-content').textContent = error.message;
    });
}

document.addEventListener('DOMContentLoaded', initInfoSite);
