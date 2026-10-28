// End-to-End: Chat loeschen, waehrend der Partner offline ist. Der Wipe muss ueber Path C ankommen.
// Vorher loeschte die Chat-Steuerung am Server (DELETE_CHAT) auch den eben eingereihten Wipe, und der
// Partner behielt den Chat.
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

async function ready(page) {
    await waitFor(page, () => Boolean(typeof state !== 'undefined' && state.ws && state.ws.readyState === 1 && state.myProfile?.id));
}

async function main() {
    if (process.env.MOBILE || process.env.OFFLINE) return;
    const browser = await chromium.launch();
    const pageErrors = [];
    async function user(name) {
        const context = await browser.newContext({ locale: 'de-DE' });
        const page = await context.newPage();
        page.on('pageerror', error => pageErrors.push(`[${name}] ${error.message}`));
        page.on('dialog', dialog => dialog.accept());
        await page.goto(`${BASE_URL}/`);
        await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        const input = page.locator('#onboarding-profile-form input').first();
        await input.fill(name);
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await ready(page);
        await page.evaluate(() => setAppMode('chat'));
        return { context, page };
    }

    try {
        const alice = await user('Alice');
        const bob = await user('Bob');
        const [aliceId, bobId] = await Promise.all([alice.page, bob.page].map(page => page.evaluate(() => state.myProfile.id)));

        await alice.page.evaluate(id => openChatWithPeer(id), bobId);
        await alice.page.fill('#chat-input', 'gleich weg');
        await alice.page.click('#send-chat-btn');
        await waitFor(bob.page, id => (state.chats[id] || []).some(message => message.text === 'gleich weg'), aliceId);

        // Bob schliesst die App (Daten bleiben im Browser-Kontext), Alice loescht den Chat.
        await bob.page.close();
        await waitFor(alice.page, id => !state.dataChannels[id] || state.dataChannels[id].readyState !== 'open', bobId);
        await alice.page.evaluate(() => deleteActiveChat());
        await waitFor(alice.page, id => Boolean(state.chatControls[id]?.deletedBefore), bobId);

        // Bob kommt zurueck: der Wipe liegt im Router-Cache und loescht seinen Chat.
        const page = await bob.context.newPage();
        page.on('pageerror', error => pageErrors.push(`[Bob] ${error.message}`));
        await page.goto(`${BASE_URL}/`);
        await ready(page);
        await page.evaluate(() => fetchQueuedCacheMessages());
        await waitFor(page, id => Boolean(state.chatControls[id]?.deletedBefore), aliceId);
        await page.evaluate(id => openChatWithPeer(id), aliceId);
        assert.equal(await page.evaluate(() => document.querySelector('#chat-messages')?.textContent.includes('gleich weg')), false, 'chat wiped at the partner');

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (chat wipe, offline partner)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
