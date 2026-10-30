// End-to-End: Nachrichten kopieren, bearbeiten und mehrere auswaehlen. Kopieren landet wirklich in der
// Zwischenablage (auch nach dem Schliessen des Menues), die Bearbeitung kommt beim anderen an ("bearbeitet").
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
        const context = await browser.newContext({ locale: 'de-DE' });
        await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE_URL });
        const page = await context.newPage();
        page.on('pageerror', error => pageErrors.push(`[${name}] ${error.message}`));
        page.on('dialog', dialog => dialog.accept());
        await page.goto(`${BASE_URL}/`);
        await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        const input = page.locator('#onboarding-profile-form input').first();
        await input.fill(name);
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1 && state.myProfile.id));
        await page.evaluate(() => setAppMode('chat'));
        return page;
    }
    const clipboard = page => page.evaluate(() => navigator.clipboard.readText());
    const send = async (page, text) => {
        await page.fill('#chat-input', text);
        await page.click('#send-chat-btn');
    };
    try {
        const alice = await user('Alice');
        const bob = await user('Bob');
        const [aliceId, bobId] = await Promise.all([alice, bob].map(page => page.evaluate(() => state.myProfile.id)));
        await alice.evaluate(id => openChatWithPeer(id), bobId);
        await send(alice, 'Hallo Bob, wie gehts?');
        await waitFor(bob, id => (state.chats[id] || []).some(message => message.text === 'Hallo Bob, wie gehts?'), aliceId);
        await bob.evaluate(id => openChatWithPeer(id), aliceId);
        await send(bob, 'Gut, und dir?');
        await waitFor(alice, id => (state.chats[id] || []).some(message => message.text === 'Gut, und dir?'), bobId);
        const firstId = await alice.evaluate(id => state.chats[id].find(message => message.text === 'Hallo Bob, wie gehts?').id, bobId);

        // Kopieren ueber das Menue.
        await alice.evaluate(id => openMessageMenu(id), firstId);
        await alice.click('#message-menu button:has-text("Kopieren")');
        assert.equal(await clipboard(alice), 'Hallo Bob, wie gehts?');

        // Bearbeiten: Text ins Eingabefeld, Senden speichert, Bob sieht den neuen Text mit "bearbeitet".
        await alice.evaluate(id => openMessageMenu(id), firstId);
        await alice.click('#message-menu button:has-text("Bearbeiten")');
        assert.equal(await alice.inputValue('#chat-input'), 'Hallo Bob, wie gehts?');
        assert.match(await alice.textContent('#chat-reply-bar'), /Nachricht bearbeiten/);
        await send(alice, 'Hallo Bob, wie geht es dir?');
        await waitFor(bob, id => state.chats[id].some(message => message.text === 'Hallo Bob, wie geht es dir?' && message.editedAt), aliceId);
        assert.equal(await alice.evaluate(id => state.chats[id].filter(message => !message.deleted).length, bobId), 2, 'no new message');
        await waitFor(bob, () => document.querySelector('#chat-messages')?.textContent.includes('bearbeitet'));
        assert.equal(await bob.evaluate(id => state.chats[id].find(message => message.editedAt).text, aliceId), 'Hallo Bob, wie geht es dir?');
        // Bob kann fremde Nachrichten nicht bearbeiten.
        await bob.evaluate(id => openMessageMenu(state.chats[id].find(message => message.senderId === id).id), aliceId);
        assert.equal(await bob.locator('#message-menu button:has-text("Bearbeiten")').count(), 0);
        await bob.evaluate(() => closeMessageMenu());

        // Mehrfachauswahl: beide Nachrichten, kopieren mit Namen.
        await alice.evaluate(id => openMessageMenu(id), firstId);
        await alice.click('#message-menu button:has-text("Auswählen")');
        await alice.waitForSelector('#message-selection-bar');
        const secondId = await alice.evaluate(id => state.chats[id].find(message => message.text === 'Gut, und dir?').id, bobId);
        await alice.click(`#chat-message-${secondId}`);
        assert.match(await alice.textContent('#message-selection-bar'), /2 ausgewählt/);
        assert.equal(await alice.locator('#message-selection-bar [aria-label="Löschen"]').count(), 0, 'no delete with foreign messages');
        await alice.click('#message-selection-bar [aria-label="Kopieren"]');
        assert.equal(await clipboard(alice), 'Du: Hallo Bob, wie geht es dir?\nBob: Gut, und dir?');
        assert.equal(await alice.locator('#message-selection-bar').count(), 0, 'selection ends after copying');

        // Nur eigene ausgewaehlt: loeschen fuer beide.
        await send(alice, 'Ups, falsch');
        await waitFor(bob, id => state.chats[id].some(message => message.text === 'Ups, falsch'), aliceId);
        const oopsId = await alice.evaluate(id => state.chats[id].find(message => message.text === 'Ups, falsch').id, bobId);
        await alice.evaluate(id => openMessageMenu(id), oopsId);
        await alice.click('#message-menu button:has-text("Auswählen")');
        await alice.click('#message-selection-bar [aria-label="Löschen"]');
        await waitFor(bob, id => state.chats[id].find(message => message.id === id) === undefined || state.chats[id].some(message => message.deleted), aliceId);

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (copy, edit, multi-select)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
