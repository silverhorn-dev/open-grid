// End-to-End: Privat-Modus fuer "nur Chat & Freunde". Einstellung an -> Auge ueber Senden (mit Hinweis
// "Lange druecken zum Ausblenden") in jedem Freundes-Chat; private Nachrichten nur in der privaten Ansicht.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

async function waitFor(page, predicate, arg, timeout = 30000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
        if (await page.evaluate(predicate, arg).catch(() => false)) return;
        await page.waitForTimeout(250);
    }
    throw new Error(`Timed out waiting for ${predicate}`);
}

async function main() {
    if (process.env.MOBILE || process.env.OFFLINE) return;
    const browser = await chromium.launch();
    const pageErrors = [];
    async function user(name) {
        const page = await (await browser.newContext({ locale: 'de-DE' })).newPage();
        page.on('pageerror', error => pageErrors.push(`[${name}] ${error.message}`));
        await page.goto(`${BASE_URL}/`);
        await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        const input = page.locator('#onboarding-profile-form input').first();
        await input.fill(name);
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1 && state.myProfile.id));
        await page.evaluate(async () => { await setModeScope('social'); await setAppMode('chat'); });
        return page;
    }
    const chatText = page => page.evaluate(() => document.querySelector('#chat-messages').textContent);
    try {
        const alice = await user('Alice');
        const bob = await user('Bob');
        const [aliceId, bobId] = await Promise.all([alice, bob].map(page => page.evaluate(() => state.myProfile.id)));
        await alice.evaluate(id => openChatWithPeer(id), bobId);
        await alice.fill('#chat-input', 'hallo');
        await alice.click('#send-chat-btn');
        await waitFor(bob, id => (state.chats[id] || []).length > 0, aliceId);
        assert.equal(await alice.isVisible('#chat-flirt-tab'), false, 'off by default');

        // Einstellung (nur ohne Entdecken sichtbar) einschalten.
        await alice.evaluate(() => { switchTab('keys'); switchSettingsTab('chat'); });
        await alice.check('#private-mode-toggle');
        await alice.evaluate(id => openChatWithPeer(id), bobId);
        await alice.waitForSelector('#chat-flirt-tab', { state: 'visible' });
        assert.equal(await alice.getAttribute('#chat-flirt-tab i', 'class'), 'fa-solid fa-eye');
        assert.equal(await alice.isVisible('#chat-flirt-tab-hint'), true, 'hint: long press to hide');
        assert.equal(await alice.getAttribute('#chat-flirt-tab', 'aria-label'), 'Privat-Modus');

        // Privat schreiben.
        await alice.click('#chat-flirt-tab');
        assert.equal(await alice.getAttribute('#chat-input', 'placeholder'), 'Private Nachricht…');
        await alice.fill('#chat-input', 'nur privat');
        await alice.click('#send-chat-btn');
        await waitFor(bob, id => state.chats[id].some(message => message.text === 'nur privat'), aliceId);
        // Bob hat den Privat-Modus nicht: er sieht die Nachricht ganz normal.
        await bob.evaluate(id => openChatWithPeer(id), aliceId);
        await waitFor(bob, () => document.querySelector('#chat-messages').textContent.includes('nur privat'));
        // Alice zurueck in die normale Ansicht: die private Nachricht ist weg, "hallo" bleibt.
        await alice.click('#chat-flirt-tab');
        await waitFor(alice, () => !document.querySelector('#chat-messages').textContent.includes('nur privat'));
        assert.match(await chatText(alice), /hallo/);

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (private mode)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
