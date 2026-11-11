// End-to-End: "tippt ..." (chat-tools.js CHAT_TYPING). Nur ueber den offenen P2P-Kanal: tippen, Medien-Auswahl,
// leeren Eingabe = fertig, eingehende Nachricht beendet die Anzeige; abgeschaltet sendet und zeigt man nichts.
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
    const contexts = {};
    async function user(name, onboard = true) {
        contexts[name] = contexts[name] || await browser.newContext({ locale: 'de-DE' });
        const page = await contexts[name].newPage();
        page.on('pageerror', error => pageErrors.push(`[${name}] ${error.message}`));
        await page.goto(`${BASE_URL}/`);
        if (onboard) {
            await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
            const input = page.locator('#onboarding-profile-form input').first();
            await input.fill(name);
            await input.dispatchEvent('change');
            await page.click('#complete-onboarding-btn');
        }
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1 && state.myProfile.id));
        await page.evaluate(() => setAppMode('chat'));
        return page;
    }
    async function befriend(a, b) {
        const [aId, bId] = await Promise.all([a, b].map(page => page.evaluate(() => state.myProfile.id)));
        await a.evaluate(async id => { await openChatWithPeer(id); document.getElementById('chat-input').value = 'hi'; await sendChatMessage(); }, bId);
        await waitFor(b, id => (state.chats[id] || []).length > 0, aId);
        await a.evaluate(id => addFriend(id), bId);
        await waitFor(b, id => hasFriendRequest(id), aId);
        await b.evaluate(id => addFriend(id), aId);
        await waitFor(a, id => isFriend(id), bId);
    }
    try {
        const alice = await user('Alice');
        const bob = await user('Bob');
        const [aliceId, bobId] = await Promise.all([alice, bob].map(page => page.evaluate(() => state.myProfile.id)));
        await befriend(alice, bob);
        await alice.evaluate(id => openChatWithPeer(id), bobId);
        await bob.evaluate(id => openChatWithPeer(id), aliceId);
        await waitFor(alice, id => isSecureChannelOpen(id), bobId);
        const status = () => bob.evaluate(() => document.getElementById('chat-peer-status').textContent);

        await alice.fill('#chat-input', 'hallo bo');
        await waitFor(bob, () => document.getElementById('chat-peer-status').textContent.includes('tippt'), null, 10000);
        await alice.fill('#chat-input', '');
        await waitFor(bob, () => !document.getElementById('chat-peer-status').textContent.includes('tippt'), null, 10000);

        await alice.evaluate(() => toggleComposeMediaMenu(true));
        await waitFor(bob, () => document.getElementById('chat-peer-status').textContent.includes('Medien'), null, 10000);
        await alice.evaluate(() => toggleComposeMediaMenu(false));

        // Nachricht kommt an: Anzeige endet sofort (nicht erst nach 6 s).
        await alice.fill('#chat-input', 'gleich da');
        await waitFor(bob, () => document.getElementById('chat-peer-status').textContent.includes('tippt'), null, 10000);
        await alice.evaluate(() => sendChatMessage());
        await waitFor(bob, id => (state.chats[id] || []).some(message => message.text === 'gleich da'), aliceId);
        await waitFor(bob, () => !document.getElementById('chat-peer-status').textContent.includes('tippt'), null, 3000);

        // Bob schaltet es ab: sieht nichts mehr und meldet selbst nichts.
        await bob.evaluate(() => updateTypingSetting(false));
        await alice.fill('#chat-input', 'siehst du das');
        await bob.waitForTimeout(2500);
        assert.ok(!(await status()).includes('tippt'), 'off: nothing shown');
        await bob.fill('#chat-input', 'ich tippe');
        await alice.waitForTimeout(2500);
        assert.ok(!(await alice.evaluate(() => document.getElementById('chat-peer-status').textContent)).includes('tippt'), 'off: nothing sent');
        assert.deepEqual(pageErrors, []);
        console.log('E2E OK (typing indicator)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
