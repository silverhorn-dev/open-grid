// End-to-End: Umzug, waehrend Kontakte und die alte Kopie offline sind (Board T31, move.js, server/move.js).
// - Carol ist beim Umzug zu: die Umzugs-Ansage wartet im Pfad-C-Cache, Carol zieht beim Oeffnen um.
// - Dave ist laenger zu, als Pfad C haelt (simuliert: sein Cache-Abruf liefert nichts): schreibt er an die
//   alte ID, antwortet der Router mit dem signierten Nachweis (410) und Dave zieht selbst um.
// - Die alte Kopie war beim Umzug zu: beim naechsten Oeffnen meldet der Router "umgezogen", sie sperrt sich.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';
const PASSWORD = 'umzug-offline-123';

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
    const openPage = async (name, { onboard = null } = {}) => {
        contexts[name] = contexts[name] || await browser.newContext({ locale: 'de-DE', acceptDownloads: true });
        if (process.env.E2E_DEBUG && !contexts[name].debugSet) {
            contexts[name].debugSet = true;
            await contexts[name].addInitScript(() => localStorage.setItem('opengrid-debug-mode', 'on'));
        }
        const page = await contexts[name].newPage();
        page.on('pageerror', error => pageErrors.push(`${name}: ${error.message}`));
        await page.goto(`${BASE_URL}/`);
        if (onboard) {
            await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
            const input = page.locator('#onboarding-profile-form input').first();
            await input.fill(onboard);
            await input.dispatchEvent('change');
            await page.click('#complete-onboarding-btn');
        }
        return page;
    };
    const online = page => waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1 && state.myProfile.id && state.myProfile.updatedAt), null, 30000);
    const chat = async (from, toId, text) => {
        await from.evaluate(async ([id, message]) => {
            await openChatWithPeer(id);
            document.getElementById('chat-input').value = message;
            await sendChatMessage();
        }, [toId, text]);
    };
    const received = (page, fromId, text, timeout = 60000) => waitFor(page, ([id, message]) => (state.chats[id] || []).some(entry => entry.text === message), [fromId, text], timeout);
    try {
        const alice = await openPage('alice', { onboard: 'Alice Alt' });
        await online(alice);
        const carol = await openPage('carol', { onboard: 'Carol' });
        await online(carol);
        const dave = await openPage('dave', { onboard: 'Dave' });
        await online(dave);
        const [aliceId, carolId, daveId] = await Promise.all([alice, carol, dave].map(page => page.evaluate(() => state.myProfile.id)));
        await chat(carol, aliceId, 'hi von carol');
        await chat(dave, aliceId, 'hi von dave');
        await received(alice, carolId, 'hi von carol');
        await received(alice, daveId, 'hi von dave');

        // Alle gehen offline, die alte Kopie exportiert vorher noch ihre Datei.
        await carol.close();
        await dave.close();
        await alice.evaluate(() => openTransferExport());
        await alice.fill('#transfer-export-password', PASSWORD);
        await alice.fill('#transfer-export-password-repeat', PASSWORD);
        const [download] = await Promise.all([alice.waitForEvent('download'), alice.click('#transfer-export-btn')]);
        const file = path.join(os.tmpdir(), `transfer-offline-${Date.now()}.opengrid`);
        await download.saveAs(file);
        await alice.close();

        // Neues Geraet uebernimmt die Daten (ohne Debug-Modus: der Umzug ist fuer alle da).
        const fresh = await openPage('fresh');
        await fresh.waitForSelector('#onboarding-transfer-btn', { state: 'visible', timeout: 20000 });
        await fresh.click('#onboarding-transfer-btn');
        await fresh.setInputFiles('#transfer-import-file', file);
        await fresh.fill('#transfer-import-password', PASSWORD);
        await Promise.all([fresh.waitForEvent('load', { timeout: 60000 }), fresh.click('#transfer-import-btn')]);
        await online(fresh);
        const freshId = await fresh.evaluate(() => state.myProfile.id);
        assert.notEqual(freshId, aliceId);
        // Niemand ist erreichbar: Ansage an Carol und Dave ueber Pfad C, danach wird die alte ID stillgelegt.
        await waitFor(fresh, () => databaseRequest('keys', 'readonly', store => store.get('transfer-imported'))
            .then(record => Boolean(record && record.retired && !record.routerToken && record.done)), null, 90000)
            .catch(async error => {
                const record = await fresh.evaluate(() => databaseRequest('keys', 'readonly', store => store.get('transfer-imported')));
                throw new Error(`${error.message}: ${JSON.stringify({ ...record, move: undefined, announcement: undefined })} ${JSON.stringify(pageErrors)} ${await fresh.evaluate(() => (state.debugLogBuffer || []).slice(-30).join('\n')).catch(() => '')}`);
            });

        // Carol oeffnet wieder: Ansage aus dem Cache, Chat zieht um, Nachricht an die neue ID kommt an.
        const carolBack = await openPage('carol');
        await online(carolBack);
        await waitFor(carolBack, ([oldId, newId]) => !(state.chatPeerIds || []).includes(oldId) && (state.chatPeerIds || []).includes(newId), [aliceId, freshId], 60000);
        // Nach dem Umziehen laedt die Seite neu (scheduleMoveReload).
        await carolBack.waitForTimeout(3000);
        await online(carolBack);
        await chat(carolBack, freshId, 'carol ist wieder da');
        await received(fresh, carolId, 'carol ist wieder da');

        // Dave war laenger weg, als Pfad C haelt: sein Cache-Abruf ist leer (Ansage verfallen).
        await contexts.dave.route('**/api/cache/*', route => (route.request().method() === 'GET'
            ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ recipientId: daveId, count: 0, messages: [] }) })
            : route.continue()));
        const daveBack = await openPage('dave');
        await online(daveBack);
        assert.ok(await daveBack.evaluate(id => (state.chatPeerIds || []).includes(id), aliceId), 'dave still knows only the old id');
        // Dave schreibt an die alte ID: P2P geht nicht, Pfad C antwortet 410 mit dem Nachweis.
        await chat(daveBack, aliceId, 'bist du noch da');
        await waitFor(daveBack, ([oldId, newId]) => !(state.chatPeerIds || []).includes(oldId) && (state.chatPeerIds || []).includes(newId), [aliceId, freshId], 60000);
        await daveBack.waitForTimeout(3000);
        await online(daveBack);
        await chat(daveBack, freshId, 'dave hat dich gefunden');
        await received(fresh, daveId, 'dave hat dich gefunden');

        // Alte Kopie oeffnet wieder: Router meldet den Umzug, sie sperrt sich.
        const aliceBack = await openPage('alice');
        await waitFor(aliceBack, () => state.movedAway === true, null, 60000);
        assert.ok(await aliceBack.locator('#moved-away-modal').isVisible(), 'old copy shows the lock notice');
        assert.equal(await aliceBack.evaluate(() => databaseRequest('keys', 'readonly', store => store.get('moved-away')).then(record => record && record.to)), freshId);

        assert.deepEqual(pageErrors, []);
        console.log('E2E OK (transfer offline)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
