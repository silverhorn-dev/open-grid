// End-to-End: Pflicht-Scan "minor-chats". Bilder von unter 18 tragen in der verschluesselten Nachricht
// `nudityScan`; der Empfaenger prueft sie auch mit abgeschaltetem Filter. Bei unter 18 ist der Schalter
// gesperrt. (Altersgruppe und Router-Wahl hier im Browser gesetzt; Router-Seite: test/safety.test.js.)
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
        // Test-Modell: rote Bilder sind Treffer; Router-Wahl "minor-chats".
        await page.evaluate(() => {
            window.prefetchGridProfiles = () => {};
            nudityClassifiers.length = 0;
            registerNudityClassifier({
                id: 'test-red',
                classify: async bitmap => {
                    const probe = new OffscreenCanvas(1, 1).getContext('2d');
                    probe.drawImage(bitmap, 0, 0, 1, 1);
                    const [r, g] = probe.getImageData(0, 0, 1, 1).data;
                    return r > 200 && g < 50 ? 0.99 : 0.01;
                }
            });
            state.appConfig.nudity = { ...state.appConfig.nudity, required: 'minor-chats', threshold: 0.7 };
        });
        return page;
    }
    try {
        const alice = await user('Alice');
        const bob = await user('Bob');
        const [aliceId, bobId] = await Promise.all([alice, bob].map(page => page.evaluate(() => state.myProfile.id)));
        await alice.evaluate(() => {
            state.ageGroup = 'minor';
            state.nudityWarnBeforeSend = false;
            renderNuditySettings();
            switchTab('keys');
            switchSettingsTab('media');
        });
        assert.equal(await alice.isDisabled('#nudity-filter-toggle'), true, 'under 18: switch locked');
        assert.equal(await alice.isChecked('#nudity-filter-toggle'), true);
        assert.equal(await alice.isVisible('#nudity-filter-forced'), true, 'says why');

        await bob.evaluate(() => { state.ageGroup = 'adult'; state.nudityFilter = false; });
        await alice.evaluate(id => openChatWithPeer(id), bobId);
        await waitFor(alice, id => isSecureChannelOpen(id), bobId);
        await alice.evaluate(async () => {
            const canvas = document.createElement('canvas');
            canvas.width = 240;
            canvas.height = 180;
            const context = canvas.getContext('2d');
            context.fillStyle = '#ff0000';
            context.fillRect(0, 0, 240, 180);
            await sendChatMessage(canvas.toDataURL('image/jpeg', 0.9), '', null, null, { asImage: true });
        });
        await waitFor(bob, id => (state.chats[id] || []).some(message => message.snapData), aliceId);
        const received = await bob.evaluate(id => state.chats[id].find(message => message.snapData).nudityScan, aliceId);
        assert.equal(received, true, 'the flag travels inside the encrypted message');
        await bob.evaluate(id => openChatWithPeer(id), aliceId);
        await waitFor(bob, () => document.querySelector('#chat-messages canvas.secure-image')?.dataset.nudityBlurred === 'true');

        // Gegenrichtung: Bilder von Erwachsenen sind fuer Bob normal (sein Filter ist aus).
        await bob.evaluate(async () => {
            const canvas = document.createElement('canvas');
            canvas.width = 240;
            canvas.height = 180;
            canvas.getContext('2d').fillStyle = '#ff0000';
            canvas.getContext('2d').fillRect(0, 0, 240, 180);
            await sendChatMessage(canvas.toDataURL('image/jpeg', 0.85), '', null, null, { asImage: true });
        });
        assert.equal(await bob.evaluate(id => state.chats[id].filter(message => message.snapData).at(-1).nudityScan, aliceId), undefined, 'adults send without the flag');
        // Alice (unter 18) sieht es trotzdem geprueft: ihr Filter ist Pflicht.
        await waitFor(alice, id => (state.chats[id] || []).filter(message => message.snapData).length >= 2, bobId);
        await waitFor(alice, () => [...document.querySelectorAll('#chat-messages canvas.secure-image')].some(canvas => canvas.dataset.nudityBlurred === 'true' && !canvas.dataset.ownImage));

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (age scan)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
