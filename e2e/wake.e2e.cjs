// End-to-End: erreichbar + wecken (R1, documentation/ANDROID-APP.md). Alices App schlaeft: nur ihr Posteingang
// (hier ein WebSocket mit REGISTER_INBOX) ist beim Router. Bob sieht "erreichbar"; schreibt er, haelt der Router
// das Angebot fest und weckt den Posteingang; der Test startet daraufhin Alices Kern (/core.html), der Router
// liefert das Angebot nach, und die Nachricht kommt direkt (P2P) an - ohne Router-Zwischenspeicher. Tippen weckt
// schon vorab.
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
    const watch = (page, name) => page.on('pageerror', error => pageErrors.push(`[${name}] ${error.message}`));
    async function onboard(page, name) {
        await page.goto(`${BASE_URL}/`);
        await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        const input = page.locator('#onboarding-profile-form input').first();
        await input.fill(name);
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1 && state.myProfile.id));
        await page.evaluate(() => setAppMode('chat'));
    }
    try {
        const aliceContext = await browser.newContext({ locale: 'de-DE' });
        const alice = await aliceContext.newPage();
        watch(alice, 'alice');
        await onboard(alice, 'Alice');
        const bob = await (await browser.newContext({ locale: 'de-DE' })).newPage();
        watch(bob, 'bob');
        await onboard(bob, 'Bob');
        const [aliceId, bobId] = await Promise.all([alice, bob].map(page => page.evaluate(() => state.myProfile.id)));
        // Chat in beide Richtungen, damit sie sich gegenseitig beobachten (Praesenz).
        await bob.evaluate(async id => { await openChatWithPeer(id); document.getElementById('chat-input').value = 'hi'; await sendChatMessage(); }, aliceId);
        await waitFor(alice, id => (state.chats[id] || []).length > 0, bobId);
        await alice.evaluate(async id => { await openChatWithPeer(id); document.getElementById('chat-input').value = 'hallo'; await sendChatMessage(); }, bobId);
        await waitFor(bob, id => (state.chats[id] || []).some(message => message.text === 'hallo'), aliceId);
        const token = await alice.evaluate(() => state.routerAuthToken || localStorage.getItem('opengrid-router-auth-token'));

        // Posteingang der App (nativ in K4): eigene Router-Verbindung, nur weckbar.
        const inbox = await (await browser.newContext()).newPage();
        await inbox.goto(`${BASE_URL}/manifest.webmanifest`);
        await inbox.evaluate(([id, auth]) => new Promise(resolve => {
            window.wakes = [];
            const socket = new WebSocket(`${location.origin.replace('http', 'ws')}/ws`);
            socket.onopen = () => socket.send(JSON.stringify({ type: 'REGISTER_INBOX', peerId: id, authToken: auth }));
            socket.onmessage = event => {
                const message = JSON.parse(event.data);
                if (message.type === 'INBOX_REGISTERED') resolve();
                if (message.type === 'WAKE') window.wakes.push(message.reason);
            };
            window.inboxSocket = socket;
        }), [aliceId, token]);

        // App schliessen: Bob sieht "erreichbar".
        await alice.close();
        await waitFor(bob, id => !isPeerOnline(id) && isPeerReachable(id), aliceId, 30000);
        assert.match(await bob.evaluate(() => document.getElementById('chat-peer-status').textContent), /erreichbar/);

        // Bob schreibt: Router weckt, Kern startet, Nachricht geht direkt (kein Upload in den Zwischenspeicher).
        const uploads = [];
        bob.on('request', request => {
            if (request.url().endsWith('/api/cache') && request.method() === 'POST') uploads.push(request.url());
        });
        await bob.evaluate(async () => { document.getElementById('chat-input').value = 'wach auf'; await sendChatMessage(); });
        await waitFor(inbox, () => window.wakes.length > 0, null, 15000);
        assert.equal(await inbox.evaluate(() => window.wakes[0]), 'signal');
        const core = await aliceContext.newPage();
        watch(core, 'alice-core');
        await core.goto(`${BASE_URL}/core.html`);
        await waitFor(core, async id => (await getDatabaseRecordsByIndex('messages', 'peerId', id)).some(message => message.text === 'wach auf'), bobId, 40000);
        await waitFor(bob, id => isSecureChannelOpen(id), aliceId, 20000);
        assert.deepEqual(uploads, [], 'delivered directly, not through the router cache');

        // Kern schlaeft wieder; nach der Weck-Pause weckt schon das Tippen.
        await core.close();
        await waitFor(bob, id => !isPeerOnline(id) && isPeerReachable(id), aliceId, 30000);
        const wakesBefore = await inbox.evaluate(() => window.wakes.length);
        await bob.waitForTimeout(31000);
        await bob.evaluate(() => { state.wakeIntents = {}; });
        await bob.fill('#chat-input', 'gleich');
        await waitFor(inbox, count => window.wakes.length > count, wakesBefore, 15000);
        assert.deepEqual(pageErrors, []);
        console.log('E2E OK (reachable and wake)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
