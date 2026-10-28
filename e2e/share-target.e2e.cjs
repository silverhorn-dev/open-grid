// End-to-End: Teilen nach OpenGrid. Ein POST an /share-target (wie aus dem Teilen-Menue einer anderen
// App) faengt der Service Worker ab, die App fragt "Senden an", das Bild geht in den Chat, der Text
// landet nur im Eingabefeld.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

async function waitFor(page, predicate, arg, timeout = 20000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
        if (await page.evaluate(predicate, arg).catch(() => false)) return;
        await page.waitForTimeout(200);
    }
    throw new Error(`Timed out waiting for ${predicate}`);
}

async function main() {
    if (process.env.MOBILE || process.env.OFFLINE) return;
    const browser = await chromium.launch();
    const pageErrors = [];
    try {
        const page = await (await browser.newContext({ locale: 'de-DE' })).newPage();
        page.on('pageerror', error => pageErrors.push(error.message));
        await page.goto(`${BASE_URL}/`);
        await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        const input = page.locator('#onboarding-profile-form input').first();
        await input.fill('Sharer');
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await waitFor(page, () => Boolean(navigator.serviceWorker.controller));
        // Ein bestehender Chat (eigene Nachricht an einen Peer, der gerade nicht online ist).
        await page.evaluate(async () => {
            await openChatWithPeer('peer-share-e2e');
            document.getElementById('chat-input').value = 'hi';
            await sendChatMessage();
            leaveActiveChat();
        });

        // Wie das Teilen-Menue: multipart-POST mit Bild und Text, der Worker leitet auf /chat?share=1.
        const redirected = await page.evaluate(async () => {
            const canvas = document.createElement('canvas');
            canvas.width = 120;
            canvas.height = 80;
            canvas.getContext('2d').fillRect(0, 0, 120, 80);
            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
            const form = new FormData();
            form.append('title', 'Schau mal');
            form.append('text', 'Schau mal https://example.org/x');
            form.append('url', 'https://example.org/x');
            form.append('files', new File([blob], 'photo.png', { type: 'image/png' }));
            form.append('files', new File(['not an image'], 'notes.txt', { type: 'text/plain' }));
            const response = await fetch('/share-target', { method: 'POST', body: form });
            return response.url;
        });
        assert.match(redirected, /\/chat\?share=1$/);

        await page.goto(`${BASE_URL}/chat?share=1`);
        if (process.env.E2E_DEBUG) {
            await page.waitForTimeout(5000);
            console.log(JSON.stringify(await page.evaluate(async () => ({ search: location.search, caches: await caches.keys(), peers: state.chatPeerIds, modal: document.getElementById('media-modal')?.className, text: document.getElementById('media-modal')?.textContent?.slice(0, 200), log: (state.debugLogs || []).slice(-15) }))));
        }
        await page.waitForSelector('#media-modal:not(.hidden) [data-peer-id="peer-share-e2e"]', { timeout: 20000 });
        assert.match(await page.textContent('#media-modal'), /1 Bild\(er\) bereit/);
        assert.equal(await page.evaluate(() => window.location.search), '', 'share parameter removed');
        await page.click('#media-modal [data-peer-id="peer-share-e2e"]');
        await waitFor(page, () => (state.chats['peer-share-e2e'] || []).some(message => message.snapData && !message.snapMode));
        assert.equal(await page.inputValue('#chat-input'), 'Schau mal https://example.org/x', 'text is prefilled, not sent, link not doubled');
        assert.equal(await page.evaluate(() => (state.chats['peer-share-e2e'] || []).some(message => message.text && message.text.includes('example.org'))), false);
        assert.equal(await page.evaluate(async () => (await caches.keys()).includes('opengrid-share-inbox')), false, 'inbox is cleared');

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (share target)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
