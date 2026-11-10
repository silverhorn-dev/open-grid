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

test('provider results keep their order, skip ads and are never proxied or cached', () => {
    const item = size => ({ url: `https://static.klipy.com/ii/${size}`, width: 220, height: 180 });
    const hello = { type: 'gif', title: 'Hello', file: { sm: { webp: item('sm-webp'), gif: item('sm-gif') }, md: { webp: item('md') } } };
    assert.deepEqual({ ...context.providerGifInfo(hello) }, { url: 'https://static.klipy.com/ii/sm-webp', source: 'provider', w: 220, h: 180, title: 'Hello' });
    assert.equal(context.providerGifInfo({ type: 'ad', file: hello.file }), null, 'ads are not shown');
    assert.equal(context.providerGifInfo({ type: 'gif', file: { sm: { webp: { url: 'https://evil.example.net/x.gif' } } } }), null, 'only provider media hosts');
    assert.equal(context.isProviderMediaUrl('https://static2.klipy.com/a'), true);
    assert.equal(context.isProviderMediaUrl('https://klipy.com.evil.net/a'), false);
    const proxy = { proxy: true, token: 'tok' };
    assert.equal(context.gifProxySrc('https://media.example.org/a.gif', proxy), '/api/gif-proxy?url=https%3A%2F%2Fmedia.example.org%2Fa.gif&t=tok');
    assert.equal(context.gifProxySrc('https://static.klipy.com/ii/x', proxy), 'https://static.klipy.com/ii/x', 'provider media never via proxy');
    assert.equal(context.gifProxySrc('https://media.example.org/a.gif', { proxy: false, token: 'tok' }), 'https://media.example.org/a.gif');
    const provider = { url: 'https://static.klipy.com/ii/x', source: 'provider' };
    assert.equal(context.gifDisplayState(provider, { sources: ['library'], enabled: true }), 'off', 'provider turned off on the router');
    assert.equal(context.gifDisplayState(provider, { sources: ['provider'], enabled: true }), 'show', 'no extra consent like external links');
});

test('pasted links that look like gifs become gifs (e.g. discord attachments)', () => {
    const discord = 'https://media.discordapp.net/attachments/1439809540488167444/1551803714204078090/work.gif?ex=6af29554&is=6af143d4&hm=6fe94c06fb477243355e7bad1283e98f8b7a8fe0702606dd2e0128f3a08959aa&=';
    assert.equal(context.looksLikeGifUrl(discord), true);
    assert.equal(context.gifUrlAllowed(discord), discord, 'signed query stays intact');
    assert.equal(context.looksLikeGifUrl('https://giphy.com/gifs/cat-abc'), true);
    assert.equal(context.looksLikeGifUrl('https://media.example.org/clip.mp4'), true);
    assert.equal(context.looksLikeGifUrl('https://news.example.org/article'), false);
    assert.equal(context.looksLikeGifUrl('http://media.example.org/a.gif'), false);
});

test('image links count too, expired discord links are recognised', () => {
    assert.equal(context.looksLikeGifUrl('https://cdn.discordapp.com/attachments/1/2/26421158.png?ex=6af30c1c&is=6af1ba9c&hm=abc&'), true);
    assert.equal(context.looksLikeGifUrl('https://media.example.org/photo.JPG'), true);
    const link = 'https://cdn.discordapp.com/attachments/1/2/a.png?ex=6af30c1c&is=6af1ba9c&hm=abc&';
    const expiry = parseInt('6af30c1c', 16) * 1000;
    assert.equal(context.discordLinkExpired(link, expiry - 1000), false);
    assert.equal(context.discordLinkExpired(link, expiry + 1000), true);
    assert.equal(context.discordLinkExpired('https://media.example.org/a.png?ex=1', Date.now()), false, 'only discord');
});
