// End-to-End: Benachrichtigungen je Art. Profilbesuche nur, wenn der Besucher sie erlaubt und der
// Besuchte sie eingeschaltet hat; eine abgeschaltete Art (Flamme) zeigt keinen Hinweis.
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
        await page.evaluate(async () => {
            await setAppMode('discovery');
            window.__toasts = [];
            const original = showToast;
            showToast = (message, type) => { window.__toasts.push(message); original(message, type); };
        });
        return page;
    }
    const toasts = page => page.evaluate(() => window.__toasts.join(' | '));

    try {
        const alice = await user('Alice');
        const bob = await user('Bob');
        const [aliceId, bobId] = await Promise.all([alice, bob].map(page => page.evaluate(() => state.myProfile.id)));
        await alice.evaluate(id => openChatWithPeer(id), bobId);
        await alice.fill('#chat-input', 'hi bob');
        await alice.click('#send-chat-btn');
        await waitFor(bob, id => (state.chats[id] || []).some(message => message.text === 'hi bob'), aliceId);

        // Profilbesuch: Standard aus auf beiden Seiten -> nichts.
        assert.equal(await bob.evaluate(() => notificationEnabled('profileView')), false, 'profile visits off by default');
        await alice.evaluate(id => { openProfileModal(id); closeProfileModal(); }, bobId);
        await bob.waitForTimeout(1500);
        assert.doesNotMatch(await toasts(bob), /Profil angesehen/);

        // Bob schaltet Profilbesuche ein, Alice erlaubt das Senden: jetzt kommt der Hinweis.
        await bob.evaluate(() => updateNotificationSetting('profileView', true));
        await alice.evaluate(() => { updateProfileViewSharing(true); localStorage.removeItem('opengrid-profile-views-sent'); });
        await alice.evaluate(id => { openProfileModal(id); closeProfileModal(); }, bobId);
        await waitFor(bob, () => window.__toasts.some(text => text.includes('hat dein Profil angesehen')));
        // Innerhalb von 6 Stunden kein zweites Mal.
        const before = await bob.evaluate(() => window.__toasts.length);
        await alice.evaluate(id => { openProfileModal(id); closeProfileModal(); }, bobId);
        await bob.waitForTimeout(1500);
        assert.equal(await bob.evaluate(() => window.__toasts.length), before, 'at most once per 6 h');

        // Flamme abgeschaltet: kein Hinweis, die Flamme kommt trotzdem an.
        await bob.evaluate(() => updateNotificationSetting('flame', false));
        await alice.evaluate(id => sendFlame(id), bobId);
        await waitFor(bob, id => hasReceivedFlame(id), aliceId);
        await bob.waitForTimeout(500);
        assert.doesNotMatch(await toasts(bob), /Flamme/);
        // Bleibt gespeichert.
        await bob.reload();
        await waitFor(bob, () => Boolean(state.myProfile?.id && state.notificationSettings));
        assert.equal(await bob.evaluate(() => notificationEnabled('flame')), false, 'setting survives a reload');
        assert.equal(await bob.evaluate(() => notificationEnabled('profileView')), true);

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (notifications)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
