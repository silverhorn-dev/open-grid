import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { buildApp } from '../server/app.js';
import { createStore } from '../server/database.js';
import { parseProperties } from '../server/i18n.js';
import { INFO_PAGES } from '../server/info-site.js';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const LANGUAGES = ['de', 'en'];
const terms = Object.fromEntries(LANGUAGES.map(language => [language, parseProperties(read(`info-site/i18n/${language}.properties`))]));
const ui = Object.fromEntries(LANGUAGES.map(language => [language, parseProperties(read(`i18n/${language}.properties`))]));
const pages = language => Object.fromEntries(INFO_PAGES.map(slug => [slug, read(`info-site/pages/${language}/${slug}.md`)]));
const references = text => [...String(text).matchAll(/\$\{([a-zA-Z0-9_.:-]+)\}/g)].map(match => match[1]);

// Echter Aufloeser aus client/info/site.js (ohne DOM).
function resolver(language, mode) {
    const context = {
        window: { localStorage: { getItem: () => mode, setItem() {} }, location: { pathname: '/info' } },
        document: { currentScript: { src: '' }, write() {}, addEventListener() {} },
        currentLanguage: language,
        t: key => ui[language][key] ?? `[[ui:${key}]]`
    };
    vm.createContext(context);
    vm.runInContext(read('client/info/site.js'), context);
    vm.runInContext(`Object.assign(INFO_TERMS, ${JSON.stringify({ [language]: terms[language] })})`, context);
    return text => context.resolveInfoText(text, mode);
}

test('every page exists in every language', () => {
    for (const language of LANGUAGES) {
        assert.deepEqual(readdirSync(new URL(`../info-site/pages/${language}/`, import.meta.url)).sort(), INFO_PAGES.map(slug => `${slug}.md`).sort(), language);
    }
});

test('terms: same keys in both languages, .plain only for existing terms, no unused entries', () => {
    assert.deepEqual(Object.keys(terms.de).sort(), Object.keys(terms.en).sort());
    for (const key of Object.keys(terms.de)) {
        if (key.endsWith('.plain')) assert.ok(key.slice(0, -6) in terms.de, `${key} without base term`);
    }
    const used = new Set(['site.page.news', ...INFO_PAGES.map(slug => `site.page.${slug}`)]);
    const sources = [read('client/info/site.js'), ...LANGUAGES.flatMap(language => [...Object.values(pages(language)), ...Object.values(terms[language])])];
    sources.forEach(source => references(source).forEach(reference => used.add(reference)));
    const unused = Object.keys(terms.de).filter(key => !key.endsWith('.plain') && !used.has(key));
    assert.deepEqual(unused, []);
});

test('all pages resolve completely in both languages and both modes', () => {
    for (const language of LANGUAGES) {
        for (const mode of ['plain', 'tech']) {
            const resolve = resolver(language, mode);
            for (const [slug, text] of [...Object.entries(pages(language)), ...Object.keys(terms[language]).filter(key => key.startsWith('site.')).map(key => [key, `\${${key}}`])]) {
                const resolved = resolve(text);
                assert.doesNotMatch(resolved, /\[\[|\$\{/, `${language}/${mode}/${slug}: ${resolved.match(/\[\[[^\]]*\]\]|\$\{[^}]*\}/)?.[0]}`);
            }
        }
    }
});

test('plain mode really changes the wording, technical mode keeps the term', () => {
    assert.match(resolver('de', 'tech')('${text.appDescription}'), /OpenGrid ist eine Privacy-First-Dating- und Chat-App\./);
    assert.match(resolver('de', 'plain')('${text.appDescription}'), /OpenGrid ist eine auf Privatsphäre ausgelegte Dating- und Chat-App\./);
    assert.match(resolver('en', 'plain')('${text.appDescription}'), /^OpenGrid is a dating and chat app built around your privacy\.$/);
});

test('loops and missing terms are marked instead of hanging', () => {
    const resolve = resolver('de', 'tech');
    assert.equal(resolve('${does.not.exist}'), '[[does.not.exist]]');
    const context = vm.createContext({
        window: { localStorage: { getItem: () => null, setItem() {} } },
        document: { currentScript: { src: '' }, write() {}, addEventListener() {} },
        currentLanguage: 'de',
        t: key => key
    });
    vm.runInContext(read('client/info/site.js'), context);
    vm.runInContext('INFO_TERMS.de = { "a": "${b}", "b": "${a}" }', context);
    assert.match(context.resolveInfoText('${a}'), /\[\[a\]\]/);
});

test('markdown: blocks and inline parts', () => {
    const context = vm.createContext({});
    vm.runInContext(read('client/app/markdown.js'), context);
    const blocks = context.parseMarkdown('# Titel\n\nText *mit* **fett**.\n\n- eins\n- zwei\n\n> Hinweis\n\n| A | B |\n|---|---|\n| 1 | 2 |');
    assert.deepEqual(JSON.parse(JSON.stringify(blocks.map(block => block.type))), ['heading', 'paragraph', 'list', 'quote', 'table']);
    assert.deepEqual(JSON.parse(JSON.stringify(blocks[4].rows)), [['1', '2']]);
    const inline = JSON.parse(JSON.stringify(context.parseInline('a [Link](page:faq) `x`')));
    assert.deepEqual(inline.map(part => part.type), ['text', 'link', 'text', 'code']);
    assert.equal(context.isSafeHref('javascript:alert(1)'), false);
    assert.equal(context.isSafeHref('/info/faq'), true);
});

async function infoApp(options = {}) {
    return buildApp({ store: createStore(':memory:'), buildVersion: 'x', buildTimestamp: 'y', ...options });
}

test('server: info pages under /info, markdown and terms from a whitelist', async () => {
    const app = await infoApp();
    try {
        const shell = await app.inject({ method: 'GET', url: '/info/faq' });
        assert.equal(shell.statusCode, 200);
        assert.match(shell.body, /data-base="\/info"/);
        assert.equal((await app.inject({ method: 'GET', url: '/info/unknown' })).statusCode, 404);
        const page = await app.inject({ method: 'GET', url: '/info-site/pages/de/faq.md' });
        assert.equal(page.statusCode, 200);
        assert.match(page.body, /^# Häufige Fragen/);
        assert.equal((await app.inject({ method: 'GET', url: '/info-site/pages/de/..%2F..%2Fpackage.json' })).statusCode, 404);
        assert.equal((await app.inject({ method: 'GET', url: '/info-site/pages/xx/faq.md' })).statusCode, 404);
        assert.match((await app.inject({ method: 'GET', url: '/info-site/i18n/en.js' })).body, /^INFO_TERMS\["en"\] = \{/);
        assert.equal((await app.inject({ method: 'GET', url: '/api/config' })).json().infoUrl, '/info');
    } finally {
        await app.close();
    }
});

test('server: INFO_HOST serves the info site at / on its own domain only', async () => {
    const app = await infoApp({ infoHost: 'info.example.org', appUrl: 'https://og.example.org' });
    try {
        const info = await app.inject({ method: 'GET', url: '/', headers: { host: 'info.example.org' } });
        assert.match(info.body, /data-base=""/);
        assert.match(info.body, /data-app-url="https:\/\/og\.example\.org"/);
        assert.match((await app.inject({ method: 'GET', url: '/privacy', headers: { host: 'info.example.org' } })).body, /class="info-site/);
        assert.equal((await app.inject({ method: 'GET', url: '/grid', headers: { host: 'info.example.org' } })).statusCode, 404);
        const appShell = await app.inject({ method: 'GET', url: '/', headers: { host: 'og.example.org' } });
        assert.doesNotMatch(appShell.body, /class="info-site/);
        assert.equal((await app.inject({ method: 'GET', url: '/api/config' })).json().infoUrl, 'https://info.example.org');
    } finally {
        await app.close();
    }
});
