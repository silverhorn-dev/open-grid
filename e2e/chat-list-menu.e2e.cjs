// End-to-End: Match im Entdecken-Modus -> Anfrage verschiebt den Chat nicht -> erst die Freundschaft
// verschiebt ihn nach "Chat & Freunde"; in "Grid & Event" bleibt ein Verweis, der dorthin fuehrt und sich
// ueber das Menue der Chatzeile (Knopf und langes Druecken) entfernen laesst. Dazu: Flammen nach dem
// Match, gestapelt (Doppelflamme).
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
        const page = await (await browser.newContext({ locale: 'de-DE', hasTouch: true })).newPage();
        page.on('pageerror', error => pageErrors.push(`[${name}] ${error.message}`));
        page.on('dialog', dialog => dialog.accept());
        await page.goto(`${BASE_URL}/`);
        await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        const input = page.locator('#onboarding-profile-form input').first();
        await input.fill(name);
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1 && state.myProfile.id));
        await page.evaluate(() => setAppMode('discovery'));
        return page;
    }

    try {
        const alice = await user('Alice');
        const bob = await user('Bob');
        const [aliceId, bobId] = await Promise.all([alice, bob].map(page => page.evaluate(() => state.myProfile.id)));

        // Match und erste Nachricht im Entdecken-Modus.
        await alice.evaluate(id => sendFlame(id), bobId);
        await waitFor(bob, id => hasReceivedFlame(id), aliceId);
        await bob.evaluate(id => sendFlame(id), aliceId);
        await waitFor(alice, id => isMatched(id), bobId);
        await alice.evaluate(id => openChatWithPeer(id), bobId);
        await alice.fill('#chat-input', 'hallo match');
        await alice.click('#send-chat-btn');
        await waitFor(bob, id => (state.chats[id] || []).some(message => message.text === 'hallo match'), aliceId);
        await waitFor(bob, id => chatScopeOf(id) === 'discovery', aliceId, 10000);

        // Anfrage: der Chat bleibt in "Grid & Event".
        await alice.evaluate(id => addFriend(id), bobId);
        await waitFor(bob, id => hasFriendRequest(id), aliceId);
        assert.equal(await bob.evaluate(id => chatScopeOf(id), aliceId), 'discovery', 'request alone does not move the chat');
        assert.equal(await alice.evaluate(id => chatScopeOf(id), bobId), 'discovery');

        // Annehmen: Freunde, Chat wandert; in der Grid-Liste bleibt ein Verweis.
        await bob.evaluate(id => addFriend(id), aliceId);
        await waitFor(bob, id => isFriend(id), aliceId);
        await waitFor(alice, id => isFriend(id), bobId);
        await bob.evaluate(() => { state.activeChatPeerId = null; switchTab('chat'); renderActivePeerList(); });
        await waitFor(bob, id => isMovedChatHint(id), aliceId);
        const row = bob.locator(`#active-peers-list .chat-list-row[data-peer-id="${aliceId}"]`);
        assert.match(await row.textContent(), /Jetzt in „Chat & Freunde“/);

        // Menue ueber den Knopf: "In Chat & Freunde oeffnen" fuehrt zum Chat in der anderen Liste.
        await row.locator('.chat-list-menu-btn').click();
        await bob.waitForSelector('#chat-list-menu', { state: 'visible' });
        await bob.click('#chat-list-menu button:has-text("In „Chat & Freunde“ öffnen")');
        await waitFor(bob, id => state.activeChatPeerId === id && currentChatScope() === 'social', aliceId);
        assert.equal(await bob.locator('#chat-list-menu').count(), 0, 'menu closed');

        // Zurueck in der Grid-Liste: langes Druecken oeffnet das Menue, "Aus dieser Liste entfernen".
        await bob.evaluate(async () => { await setAppMode('discovery'); state.chatListScopeOverride = null; state.activeChatPeerId = null; switchTab('chat'); renderActivePeerList(); });
        await waitFor(bob, id => isMovedChatHint(id), aliceId);
        const box = await row.locator('.chat-list-open').boundingBox();
        await bob.mouse.move(box.x + 20, box.y + box.height / 2);
        await bob.mouse.down();
        await bob.waitForTimeout(700);
        await bob.mouse.up();
        await bob.waitForSelector('#chat-list-menu', { state: 'visible' });
        assert.equal(await bob.evaluate(() => state.activeChatPeerId), null, 'long press does not open the chat');
        await bob.click('#chat-list-menu button:has-text("Aus dieser Liste entfernen")');
        await waitFor(bob, id => !isMovedChatHint(id), aliceId);
        assert.equal(await bob.locator(`#active-peers-list .chat-list-row[data-peer-id="${aliceId}"]`).count(), 0, 'pointer removed');
        assert.equal(await bob.evaluate(id => chatScopeOf(id), aliceId), 'social', 'the chat itself stays');

        // Normale Zeile: Menue mit Oeffnen/Profil/Loeschen/Blockieren.
        await alice.evaluate(() => { state.chatListScopeOverride = 'social'; state.activeChatPeerId = null; renderActivePeerList(); });
        await alice.locator(`#active-peers-list .chat-list-row[data-peer-id="${bobId}"] .chat-list-menu-btn`).click();
        const items = await alice.locator('#chat-list-menu button').allTextContents();
        assert.deepEqual(items.map(text => text.trim()), ['Öffnen', 'Profil', 'Chat löschen', 'Blockieren']);
        await alice.keyboard.press('Escape').catch(() => {});
        await alice.evaluate(() => closeChatListMenu());

        // Flammen nach dem Match: weitere Flamme (Abklingzeit fuer den Test zurueckgesetzt) -> Doppelflamme.
        await alice.evaluate(id => { state.matchState[id].sentAt = Date.now() - 2 * 24 * 60 * 60 * 1000; return sendFlame(id); }, bobId);
        await waitFor(bob, id => visibleFlameCount(id) === 2, aliceId);
        assert.equal(await bob.evaluate(id => isMatched(id), aliceId), true, 'still matched');
        const indicator = await bob.evaluate(id => {
            const element = flameIndicator(id);
            return { flames: element.dataset.flames, icons: element.querySelectorAll('i').length, count: element.querySelector('.flame-count')?.textContent || null };
        }, aliceId);
        assert.deepEqual(indicator, { flames: '2', icons: 2, count: null }, 'two flames = double flame icon');

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (chat list menu, moved chats, stacked flames)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
