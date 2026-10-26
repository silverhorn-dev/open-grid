// Info-Seite (info-site/): erklaert OpenGrid fuer alle, nicht nur Technikinteressierte.
// - Seiten: info-site/pages/<sprache>/<seite>.md, Begriffe und Textbausteine: info-site/i18n/<sprache>.properties
//   (`${begriff}` wird im Browser aufgeloest, `begriff.plain` ersetzt ihn im Modus "Einfach erklaert",
//   `${ui:schluessel}` holt eine Beschriftung aus der App, siehe client/info/site.js).
// - Mit INFO_HOST (z. B. info.og.example.org) zeigt dieser Host die Info-Seite unter "/", sonst liegt sie
//   unter "/info" (lokal, Tests). APP_URL ist das Ziel von "Zur App" auf der Info-Domain.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadTranslations, translationScript } from './i18n.js';

export const INFO_PAGES = ['index', 'getting-started', 'features', 'privacy', 'faq', 'self-hosting'];
const PAGE_PATH = /^\/(?:info(?:\/([a-z0-9-]*))?)?$/;
const HOST_PAGE_PATH = /^\/([a-z0-9-]*)$/;

export function infoSiteUrl(infoHost) {
    return infoHost ? `https://${infoHost}` : '/info';
}

export async function registerInfoSite(app, { projectDirectory, assetVersion, infoHost = null, appUrl = '' }) {
    const siteDirectory = join(projectDirectory, 'info-site');
    const template = await readFile(join(siteDirectory, 'index.html'), 'utf8');
    const terms = await loadTranslations(join(siteDirectory, 'i18n'));
    const languages = Object.keys(terms);
    const pageFiles = new Set();
    for (const language of languages) {
        const available = await readdir(join(siteDirectory, 'pages', language)).catch(() => []);
        for (const slug of INFO_PAGES) if (available.includes(`${slug}.md`)) pageFiles.add(`${language}/${slug}`);
    }
    const termScripts = new Map(languages.map(language => [language, translationScript(language, terms[language], 'INFO_TERMS')]));

    const shell = basePath => template
        .replaceAll('{{assetVersion}}', assetVersion)
        .replaceAll('{{basePath}}', basePath)
        .replaceAll('{{appUrl}}', appUrl || (infoHost ? '' : '/'))
        .replaceAll('{{pages}}', INFO_PAGES.join(','));
    const sendShell = (reply, basePath) => reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-cache').send(shell(basePath));
    const isPage = slug => !slug || INFO_PAGES.includes(slug) || slug === 'news';

    // Info-Domain: jede Seitenadresse liefert die Info-Seite (die App-Routen gelten hier nicht).
    if (infoHost) {
        app.addHook('onRequest', async (request, reply) => {
            if (request.method !== 'GET' || (request.hostname || '').toLowerCase() !== infoHost) return;
            const match = request.url.split('?')[0].match(HOST_PAGE_PATH);
            if (!match) return;
            if (!isPage(match[1])) return reply.code(404).type('text/plain; charset=utf-8').send('Not found');
            return sendShell(reply, '');
        });
    }

    for (const path of ['/info', '/info/:slug']) {
        app.get(path, async (request, reply) => {
            const match = request.url.split('?')[0].match(PAGE_PATH);
            if (!match || !isPage(match[1])) return reply.code(404).send({ error: 'Not found' });
            return sendShell(reply, '/info');
        });
    }

    app.get('/info-site/pages/:language/:file', async (request, reply) => {
        const { language, file } = request.params;
        const slug = String(file).replace(/\.md$/, '');
        if (!pageFiles.has(`${language}/${slug}`)) return reply.code(404).send({ error: 'Not found' });
        const text = await readFile(join(siteDirectory, 'pages', language, `${slug}.md`), 'utf8');
        return reply.type('text/markdown; charset=utf-8').header('Cache-Control', 'no-cache').send(text);
    });

    app.get('/info-site/i18n/:file', async (request, reply) => {
        const language = String(request.params.file).replace(/\.js$/, '');
        const script = termScripts.get(language);
        if (!script) return reply.code(404).send({ error: 'Not found' });
        return reply.type('text/javascript; charset=utf-8').header('Cache-Control', 'no-cache').send(script);
    });

    return { languages, pageFiles };
}
