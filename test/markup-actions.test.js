import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = new URL('../', import.meta.url).pathname;
const markup = readFileSync(join(root, 'index.html'), 'utf8');

function clientSources() {
    const files = [];
    const walk = directory => readdirSync(directory, { withFileTypes: true }).forEach(entry => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith('.js')) files.push(readFileSync(path, 'utf8'));
    });
    walk(join(root, 'client'));
    return files.join('\n');
}

test('markup has no inline event handlers (strict CSP)', () => {
    assert.deepEqual(markup.match(/\son[a-z]+="/g) || [], []);
    assert.doesNotMatch(markup, /javascript:/);
});

test('every declarative action points to an existing function with valid arguments', () => {
    const sources = clientSources();
    const actions = [...markup.matchAll(/data-(?:click|change|input|enter)="(\w+)"/g)].map(match => match[1]);
    assert.ok(actions.length > 80);
    const missing = [...new Set(actions)].filter(name => !new RegExp(`function ${name}\\(`).test(sources));
    assert.deepEqual(missing, []);
    for (const [, args] of markup.matchAll(/data-args='([^']*)'/g)) {
        assert.ok(Array.isArray(JSON.parse(args)), args);
    }
});

test('chat input is a multiline field and offline state is an icon, not a banner', () => {
    assert.match(markup, /<textarea[^>]* id="chat-input" rows="1"/);
    assert.doesNotMatch(markup, /id="offline-banner"/);
    // Nur im Chat-Kopf; in der Kopfzeile zeigt der Punkt den Verbindungsstatus.
    assert.equal((markup.match(/offline-indicator hidden/g) || []).length, 1, 'only in the chat header');
});

test('viewers draw images into canvases and only chat images and videos can be saved', () => {
    for (const id of ['image-viewer-image', 'image-viewer-prev-image', 'image-viewer-next-image', 'secure-snap-image']) {
        assert.match(markup, new RegExp(`<canvas[^>]* id="${id}"`), id);
    }
    assert.match(markup, /id="image-viewer-save"[^>]*class="hidden/);
    assert.match(markup, /id="trace-watermark-toggle"/);
    const chatTools = readFileSync(join(root, 'client/app/chat-tools.js'), 'utf8');
    assert.match(chatTools, /allowSave: snaps\.map\(canDownloadMedia\)/, 'per image, as the sender allows');
    assert.match(markup, /id="video-viewer-save"[^>]*class="hidden/);
    assert.match(markup, /id="video-viewer-share"[^>]*class="hidden/);
    const albums = readFileSync(join(root, 'client/app/albums.js'), 'utf8');
    assert.doesNotMatch(albums, /allowSave/);
});

test('the page is declared German and opts out of browser translation', () => {
    assert.match(markup, /<html lang="de" translate="no"/);
    assert.match(markup, /<meta name="google" content="notranslate">/);
});

