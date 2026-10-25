// End-to-End: geht ein Angebot verloren (Gegenseite startet gerade), baut der Wachhund die Verbindung
// neu auf, statt fuer immer bei "connecting" haengen zu bleiben.
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
        const page = await (await browser.newContext()).newPage();
        page.on('pageerror', error => pageErrors.push(`[${name}] ${error.message}`));
        await page.goto(`${BASE_URL}/`);
        await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        const input = page.locator('#onboarding-profile-form input').first();
        await input.fill(name);
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1 && state.myProfile.id));
        return page;
    }
    try {
        const alice = await user('Alice');
        const bob = await user('Bob');
        const bobId = await bob.evaluate(() => state.myProfile.id);
        // Bob verliert das erste Angebot.
        await bob.evaluate(() => {
            const original = handleSignalingMessage;
            let dropped = false;
            window.handleSignalingMessage = async message => {
                if (!dropped && message.type === 'SDP_OFFER') {
                    dropped = true;
                    return;
                }
                return original(message);
            };
        });
        const startedAt = Date.now();
        await alice.evaluate(id => openChatWithPeer(id), bobId);
        await waitFor(alice, id => isSecureChannelOpen(id), bobId, 30000);
        const seconds = (Date.now() - startedAt) / 1000;
        assert.ok(seconds >= 7, `recovered through the watchdog (${seconds}s)`);
        await alice.fill('#chat-input', 'nach dem verlorenen angebot');
        await alice.click('#send-chat-btn');
        await waitFor(bob, () => Object.values(state.chats).flat().some(message => message.text === 'nach dem verlorenen angebot'), null, 15000);
        assert.equal(await bob.evaluate(() => Object.values(state.chats).flat().find(message => message.text === 'nach dem verlorenen angebot').deliveredVia), 'E2EE P2P');

        assert.deepEqual(pageErrors, [], 'no uncaught page errors');
        console.log(`E2E OK (p2p recovery after ${seconds.toFixed(1)} s)`);
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
