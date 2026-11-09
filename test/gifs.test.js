import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { checkGifUrl } from '../server/gifs.js';
import { I18N_STUBS } from './i18n-stubs.js';

const context = { document: { getElementById: () => null }, window: {}, URL, Date, Math, Number };
vm.runInNewContext(readFileSync(new URL('../client/app/gifs.js', import.meta.url), 'utf8'), Object.assign(context, I18N_STUBS));

const URLS = [
    'https://media.example.org/cat.gif', 'https://media.example.org/cat.gif#frag', 'https://cdn.gifs.net/a/b.webp?x=1',
    'http://media.example.org/a.gif', 'https://127.0.0.1/a.gif', 'https://[::1]/a.gif', 'https://localhost/a.gif', 'https://nas.local/a.gif',
    'https://user:pw@media.example.org/a.gif', 'https://media.example.org:8443/a.gif', 'https://media.example.org:443/a.gif',
    'javascript:alert(1)', 'data:image/gif;base64,AAAA', 'https://intranet/a.gif', 'https://box.lan/a.gif', '', 'nope'
];

test('client and router check gif urls the same way', () => {
    for (const url of URLS) assert.equal(context.gifUrlAllowed(url), checkGifUrl(url), url);
    assert.equal(context.gifUrlAllowed('https://media.example.org/cat.gif#frag'), 'https://media.example.org/cat.gif');
    assert.equal(context.isGifVideoUrl('https://media.example.org/loop.mp4?x=1'), true);
    assert.equal(context.isGifVideoUrl('https://media.example.org/loop.gif'), false);
});

test('gif messages stay blurred until the user enables them, external links need their own consent', () => {
    const library = { url: 'https://media.example.org/cat.gif', source: 'library', w: 320, h: 240 };
    const external = { url: 'https://other.example.net/dog.gif', source: 'url' };
    const both = ['library', 'url'];
    assert.equal(context.gifDisplayState(library, { sources: [] }), 'off', 'router turned gifs off');
    assert.equal(context.gifDisplayState(external, { sources: ['library'], enabled: true, external: true }), 'off', 'router allows no external links');
    assert.equal(context.gifDisplayState(library, { sources: both }), 'enable');
    assert.equal(context.gifDisplayState(library, { sources: both, enabled: true }), 'show');
    assert.equal(context.gifDisplayState(external, { sources: both, enabled: true }), 'external');
    assert.equal(context.gifDisplayState(external, { sources: both, enabled: true, external: true }), 'show');
    assert.equal(context.gifDisplayState(external, { sources: both, mine: true }), 'show', 'own gifs always show');
    assert.equal(context.gifDisplayState({ ...library, url: 'https://127.0.0.1/x.gif' }, { sources: both, enabled: true }), 'off', 'bad url never loads');
    assert.equal(context.isValidGifInfo({ ...library, w: 0 }), false);
    assert.equal(context.isValidGifInfo({ ...library, source: 'giphy' }), false);
});

test('cache keeps favourites forever and the rest by age', () => {
    const now = Date.UTC(2026, 10, 9);
    const day = 24 * 60 * 60 * 1000;
    const index = { 'https://a.example.org/1.gif': { at: now - 40 * day }, 'https://a.example.org/2.gif': { at: now - 2 * day } };
    const favorites = new Set(['https://a.example.org/fav.gif']);
    const keep = (url, keepDays) => context.gifKeepUrl(url, { index, favorites, keepDays, now });
    assert.equal(keep('https://a.example.org/1.gif', 0), true, 'as long as possible');
    assert.equal(keep('https://a.example.org/1.gif', 30), false);
    assert.equal(keep('https://a.example.org/2.gif', 7), true);
    assert.equal(keep('https://a.example.org/fav.gif', 7), true, 'favourites stay even without an index entry');
    assert.equal(keep('https://a.example.org/browsed.gif', 0), false, 'library previews never sent are cleaned up');
});
