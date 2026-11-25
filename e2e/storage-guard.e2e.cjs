// End-to-End: Schutz vor Datenverlust beim Start (storage.js, T38). (1) localStorage verliert die Node-ID, IndexedDB hat
// sie noch: wiederhergestellt, gleiche Identitaet, Chats da. (2) Der Speicherschluessel fehlt, das verschluesselte
// Profil ist aber da: keine Einrichtung (wuerde ueberschreiben), sondern "Daten nicht geladen"; das Profil bleibt.
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
    try {
        const page = await (await browser.newContext({ locale: 'de-DE' })).newPage();
        page.on('pageerror', error => pageErrors.push(error.message));
        await page.goto(`${BASE_URL}/`);
        await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        const input = page.locator('#onboarding-profile-form input').first();
        await input.fill('Alice');
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1 && state.myProfile.id));
        const nodeId = await page.evaluate(() => state.nodeId);
        const displayName = await page.evaluate(() => state.myProfile.fields.displayName);
        assert.equal(await page.evaluate(() => databaseRequest('keys', 'readonly', store => store.get('node-id')).then(record => record?.value)), nodeId, 'node id mirrored into IndexedDB');

        // (1) Node-ID nur in localStorage weg.
        await page.evaluate(() => { localStorage.removeItem('opengrid-node-id'); sessionStorage.removeItem('opengrid-node-id'); });
        // Erst laedt die Seite, merkt die fehlende ID und laedt mit der wiederhergestellten noch einmal.
        const secondLoad = page.waitForEvent('framenavigated', { timeout: 20000 });
        await page.reload();
        await secondLoad;
        await page.waitForLoadState('load');
        await waitFor(page, () => Boolean(state.myProfile?.fields?.displayName), undefined, 30000);
        assert.equal(await page.evaluate(() => state.nodeId), nodeId, 'same identity after the reload');
        assert.equal(await page.evaluate(() => state.myProfile.fields.displayName), displayName, 'profile still there');
        assert.equal(await page.evaluate(() => document.getElementById('profile-onboarding-modal').classList.contains('hidden')), true, 'no onboarding');

        // (2) Speicherschluessel weg, Profil verschluesselt noch da.
        const before = await page.evaluate(() => databaseRequest('localProfile', 'readonly', store => store.get('current')).then(record => record.ciphertext));
        await page.evaluate(() => deleteDatabaseRecord('keys', 'profile-cache'));
        await page.reload();
        await page.waitForSelector('#storage-problem', { timeout: 20000 });
        assert.equal(await page.evaluate(() => document.getElementById('profile-onboarding-modal').classList.contains('hidden')), true, 'no onboarding over existing data');
        assert.equal(await page.evaluate(() => state.storageProblem), 'key-missing');
        assert.equal(await page.evaluate(() => databaseRequest('keys', 'readonly', store => store.get('profile-cache')).then(record => Boolean(record))), false, 'no new key generated');
        assert.equal(await page.evaluate(() => databaseRequest('localProfile', 'readonly', store => store.get('current')).then(record => record.ciphertext)), before, 'profile untouched');

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (storage guard)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
