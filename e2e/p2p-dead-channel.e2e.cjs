// End-to-End: halb toter DataChannel. Bob verliert das Netz, sein Kanal bleibt fuer Alice aber "open"
// (ICE merkt es erst nach bis zu 30 s). Alices Nachricht geht in den Kanal und kommt nie an. Ohne
// Empfangsbestaetigung faellt sie nach wenigen Sekunden auf Pfad C zurueck (vorher: haengen bis zum
// naechsten Chat-Sync), die naechste Nachricht folgt ebenfalls zuegig.
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
    const send = async (page, text) => {
        await page.fill('#chat-input', text);
        await page.click('#send-chat-btn');
    };
    const received = (page, text) => waitFor(page, value => Object.values(state.chats).flat().some(message => message.text === value), text, 20000);

    try {
        const alice = await user('Alice');
        const bob = await user('Bob');
        const [aliceId, bobId] = await Promise.all([alice, bob].map(page => page.evaluate(() => state.myProfile.id)));
        await alice.evaluate(id => openChatWithPeer(id), bobId);
        await waitFor(alice, id => isSecureChannelOpen(id), bobId);
        await waitFor(bob, id => isSecureChannelOpen(id), aliceId);
        await send(alice, 'direkt');
        await received(bob, 'direkt');
        await waitFor(alice, () => Object.keys(state.pendingP2PAcks).length === 0);

        // Bobs P2P ist tot, der Kanal aber noch offen: alles verschwindet, keine neuen Angebote.
        await bob.evaluate(id => {
            const original = handleSignalingMessage;
            window.handleSignalingMessage = async message => (message.type === 'SDP_OFFER' ? undefined : original(message));
            state.dataChannels[id].onmessage = null;
            state.dataChannels[id].send = () => {};
        }, aliceId);

        const startedAt = Date.now();
        await send(alice, 'in den toten kanal');
        await received(bob, 'in den toten kanal');
        const seconds = (Date.now() - startedAt) / 1000;
        assert.ok(seconds < 15, `arrived via Path C quickly (${seconds}s)`);
        assert.equal(await bob.evaluate(() => Object.values(state.chats).flat().find(message => message.text === 'in den toten kanal').deliveredVia), 'Encrypted Path C');
        await waitFor(alice, () => Object.values(state.chats).flat().find(message => message.text === 'in den toten kanal')?.deliveredVia === 'Encrypted Path C');

        const nextStart = Date.now();
        await send(alice, 'danach');
        await received(bob, 'danach');
        assert.ok((Date.now() - nextStart) / 1000 < 15, 'the next message follows quickly');
        assert.equal(await bob.evaluate(() => Object.values(state.chats).flat().filter(message => message.text === 'in den toten kanal').length), 1, 'no duplicate');

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log(`E2E OK (dead channel, path c after ${seconds.toFixed(1)} s)`);
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
