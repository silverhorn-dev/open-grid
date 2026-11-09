// End-to-End: Nutzer manuell melden (report.js, server/reports.js). Grund ist Pflicht, "Sonstiges" braucht eine
// Notiz; nach drei verschiedenen Meldern ist der Peer im Entdecken-Grid nicht mehr sichtbar. Blockieren wird
// danach angeboten (hier abgelehnt).
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
    const dialogs = [];
    async function user(name) {
        const page = await (await browser.newContext({ locale: 'de-DE' })).newPage();
        page.on('pageerror', error => pageErrors.push(`[${name}] ${error.message}`));
        // "Auch blockieren?" ablehnen.
        page.on('dialog', dialog => {
            dialogs.push(`${name}: ${dialog.message().slice(0, 40)}`);
            dialog.dismiss();
        });
        await page.goto(`${BASE_URL}/`);
        await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        const input = page.locator('#onboarding-profile-form input').first();
        await input.fill(name);
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1 && state.myProfile.id));
        await page.evaluate(async () => { await setAppMode('discovery'); switchTab('grid'); await refreshGrid(); });
        return page;
    }
    const report = async (page, badId, reason, note = '') => {
        await page.evaluate(id => openChatWithPeer(id), badId);
        await page.click('#chat-header-menu-btn');
        await page.click('#report-peer-btn');
        await page.waitForSelector('#report-form', { timeout: 5000 });
        if (reason) await page.check(`#report-form input[value="${reason}"]`);
        if (note) await page.fill('#report-note', note);
        await page.click('#report-submit');
    };
    try {
        const bad = await user('Mallory');
        const reporters = [await user('Rita'), await user('Rolf'), await user('Rosa')];
        const badId = await bad.evaluate(() => state.myProfile.id);
        await waitFor(reporters[2], id => state.peers.some(peer => peer.id === id), badId);

        // Ohne Grund und mit "Sonstiges" ohne Notiz geht es nicht.
        await report(reporters[0], badId, null);
        assert.match(await reporters[0].textContent('#report-error'), /Grund/);
        await reporters[0].check('#report-form input[value="other"]');
        await reporters[0].click('#report-submit');
        assert.match(await reporters[0].textContent('#report-error'), /beschreibe/);
        await reporters[0].fill('#report-note', 'schickt mir dauernd Werbung');
        await reporters[0].click('#report-submit');
        await reporters[0].waitForSelector('#report-form', { state: 'detached', timeout: 5000 });

        await report(reporters[1], badId, 'harassment');
        await reporters[1].waitForSelector('#report-form', { state: 'detached', timeout: 5000 });
        // Zwei Melder: noch sichtbar.
        await reporters[2].evaluate(() => refreshGrid());
        assert.equal(await reporters[2].evaluate(id => state.peers.some(peer => peer.id === id), badId), true);

        await report(reporters[2], badId, 'scam');
        await reporters[2].waitForSelector('#report-form', { state: 'detached', timeout: 5000 });
        // Drei verschiedene Melder: im Grid ausgeblendet.
        await waitFor(reporters[2], async id => {
            await refreshGrid();
            return !state.peers.some(peer => peer.id === id);
        }, badId, 30000);
        assert.ok(dialogs.filter(entry => /blockieren/i.test(entry)).length >= 3, 'blocking is offered after reporting');
        assert.equal(await reporters[0].evaluate(id => isPeerBlocked(id), badId), false, 'declined, not blocked');
        assert.deepEqual(pageErrors, []);
        console.log('E2E OK (report user)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
