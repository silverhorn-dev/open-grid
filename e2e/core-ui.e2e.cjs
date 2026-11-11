// End-to-End: Oberflaeche <-> Kern (core-link.js, documentation/ANDROID-APP.md K2). Die App wird mit zwei Seiten im
// selben Browser-Kontext nachgestellt: /core.html (Kern) und / (Oberflaeche). Die Oberflaeche baut selbst keine
// Verbindung auf, sendet ueber den Kern, sieht Eingehendes ueber die gemeinsame DB, Praesenz und "tippt" ueber den
// Spiegel; Gruppen gehen auch. Wird der Kern beendet, arbeitet die Oberflaeche wieder allein ("full").
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
        // Alice richtet die App ein, dann: Kern + Oberflaeche.
        const aliceContext = await browser.newContext({ locale: 'de-DE' });
        const setup = await aliceContext.newPage();
        await onboard(setup, 'Alice');
        const aliceId = await setup.evaluate(() => state.myProfile.id);
        await setup.close();
        const core = await aliceContext.newPage();
        watch(core, 'core');
        await core.goto(`${BASE_URL}/core.html`);
        await waitFor(core, () => state.ws?.readyState === 1);
        const ui = await aliceContext.newPage();
        watch(ui, 'ui');
        await ui.goto(`${BASE_URL}/`);
        await waitFor(ui, () => APP_ROLE === 'ui' && Boolean(state.myProfile.updatedAt));
        await ui.waitForTimeout(1500);
        assert.equal(await ui.evaluate(() => state.ws), null, 'the UI opens no router connection');

        const bob = await (await browser.newContext({ locale: 'de-DE' })).newPage();
        watch(bob, 'bob');
        await onboard(bob, 'Bob');
        const bobId = await bob.evaluate(() => state.myProfile.id);

        // Eingehend: Bob schreibt, der Kern nimmt an, die Oberflaeche zeigt es (gemeinsame DB).
        await bob.evaluate(async id => { await openChatWithPeer(id); document.getElementById('chat-input').value = 'hallo app'; await sendChatMessage(); }, aliceId);
        await waitFor(ui, id => (state.chats[id] || []).some(message => message.text === 'hallo app') || state.chatPeerIds.includes(id), bobId, 45000);
        await ui.evaluate(id => openChatWithPeer(id), bobId);
        await waitFor(ui, id => (state.chats[id] || []).some(message => message.text === 'hallo app'), bobId, 20000);

        // Spiegel: Bob online, direkter Kanal offen (im Kern), Profil da.
        await waitFor(ui, id => isPeerOnline(id) && isSecureChannelOpen(id), bobId, 30000);
        await waitFor(ui, id => state.cachedProfiles[id]?.fields?.displayName === 'Bob', bobId, 30000);

        // Ausgehend: die Oberflaeche sendet ueber den Kern.
        await ui.evaluate(async () => { document.getElementById('chat-input').value = 'aus der oberflaeche'; await sendChatMessage(); });
        await waitFor(bob, id => (state.chats[id] || []).some(message => message.text === 'aus der oberflaeche'), aliceId, 30000);
        // Rueckmeldung "zugestellt" kommt ueber den Kern zurueck.
        await waitFor(ui, id => (state.chats[id] || []).find(message => message.text === 'aus der oberflaeche')?.deliveredVia !== 'Establishing secure channel...', bobId, 20000);

        // "tippt" von Bob erscheint in der Oberflaeche.
        await bob.fill('#chat-input', 'ich schreibe');
        await waitFor(ui, () => document.getElementById('chat-peer-status').textContent.includes('tippt'), null, 15000);
        await bob.fill('#chat-input', '');

        // K3: Secure Snap von Bob in der Oberflaeche ansehen. Der Live-Stream kommt im Kern an und erscheint als
        // Einzelbilder im Betrachter der Oberflaeche; Bob sieht die verbrauchte Ansicht.
        await bob.evaluate(async id => {
            const canvas = document.createElement('canvas');
            canvas.width = 320;
            canvas.height = 240;
            const context = canvas.getContext('2d');
            context.fillStyle = '#c026d3';
            context.fillRect(0, 0, 320, 240);
            await sendChatMessage(null, '', null, await createSecureSnap(canvas.toDataURL('image/jpeg', 0.9), id, 2, 4));
        }, aliceId);
        await waitFor(ui, id => (state.chats[id] || []).some(message => message.secureSnap?.encrypted), bobId, 30000);
        const snapMessageId = await ui.evaluate(id => state.chats[id].find(message => message.secureSnap?.encrypted).id, bobId);
        await ui.evaluate(id => requestSecureSnapView(id), snapMessageId);
        await waitFor(ui, () => {
            const image = document.getElementById('secure-snap-image');
            return !image.classList.contains('hidden') && image.width > 0 && state.secureSnapViewing?.started === true;
        }, null, 30000);
        assert.equal(await ui.evaluate(() => state.secureSnapViewing.phase), 'streaming', 'shown as a live stream, no key handed out');
        await waitFor(bob, id => (state.chats[id].find(message => message.secureSnap)?.secureSnap.viewsUsed || 0) >= 1, aliceId, 15000);
        await ui.evaluate(() => closeSecureSnapViewer());

        // Gruppe aus der Oberflaeche: der Kern kennt sie (DB), Bob bekommt Zustand und Nachricht.
        const groupId = await ui.evaluate(async id => (await createGroup('App-Gruppe', [id])).id, bobId);
        await waitFor(bob, id => Boolean(getGroup(id)), groupId, 30000);
        await waitFor(core, id => Boolean(getGroup(id)), groupId, 10000);
        await ui.evaluate(async id => { await openChatWithPeer(id); document.getElementById('chat-input').value = 'gruppe aus der app'; await sendChatMessage(); }, groupId);
        await waitFor(bob, id => (state.chats[id] || []).some(message => message.text === 'gruppe aus der app'), groupId, 30000);
        await bob.evaluate(async id => { await openChatWithPeer(id); document.getElementById('chat-input').value = 'gruppe zurueck'; await sendChatMessage(); }, groupId);
        await waitFor(ui, id => (state.chats[id] || []).some(message => message.text === 'gruppe zurueck'), groupId, 30000);

        // Sperren in der Oberflaeche: der Kern zieht nach und trennt den direkten Kanal.
        await ui.evaluate(id => storeChatControl(id, 'BLOCK'), bobId);
        await waitFor(core, id => isPeerBlocked(id) && !isSecureChannelOpen(id), bobId, 20000);

        // Kern beendet: die Oberflaeche laedt neu und arbeitet allein.
        await core.close();
        await waitFor(ui, () => APP_ROLE === 'full' && state.ws?.readyState === 1, null, 40000);
        assert.deepEqual(pageErrors, []);
        console.log('E2E OK (ui with core)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
