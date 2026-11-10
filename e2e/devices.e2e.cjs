// End-to-End: weiteres Geraet koppeln (devices.js, Board T36 P4a). Alices Handy erzeugt einen Code, ein frisches
// Geraet (PC) uebernimmt die Daten ohne Umzug; beide stehen danach in der signierten Geraeteliste, das Handy
// bleibt aktiv, und alte eigene Nachrichten gelten auf dem PC als eigene.
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
    async function page(name) {
        const result = await (await browser.newContext({ locale: 'de-DE' })).newPage();
        result.on('pageerror', error => pageErrors.push(`[${name}] ${error.message}`));
        await result.goto(`${BASE_URL}/`);
        await result.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        return result;
    }
    async function onboard(target, name) {
        const input = target.locator('#onboarding-profile-form input').first();
        await input.fill(name);
        await input.dispatchEvent('change');
        await target.click('#complete-onboarding-btn');
        await waitFor(target, () => Boolean(state.ws && state.ws.readyState === 1 && state.myProfile.id));
    }
    try {
        const phone = await page('phone');
        await onboard(phone, 'Alice');
        const bob = await page('bob');
        await onboard(bob, 'Bob');
        const [phoneId, bobId] = await Promise.all([phone, bob].map(target => target.evaluate(() => state.myProfile.id)));
        await phone.evaluate(async id => { await openChatWithPeer(id); document.getElementById('chat-input').value = 'vom handy'; await sendChatMessage(); }, bobId);
        await waitFor(bob, id => (state.chats[id] || []).some(message => message.text === 'vom handy'), phoneId);

        // Handy: Code ueber Einstellungen > Meine Geraete.
        await phone.evaluate(() => openDevicePairing());
        await phone.click('#devices-code-btn');
        await phone.waitForSelector('#transfer-code-output', { timeout: 15000 });
        const code = await phone.inputValue('#transfer-code-output');
        assert.ok(code && code.includes('.'), `code shown (${code})`);

        // PC: beim Einrichten uebernehmen.
        const pc = await page('pc');
        await pc.click('#onboarding-transfer-btn');
        await pc.fill('#transfer-import-code', code.trim());
        await Promise.all([pc.waitForEvent('load', { timeout: 60000 }), pc.click('#transfer-import-btn')]);
        await waitFor(pc, () => Boolean(state.ws && state.ws.readyState === 1 && state.myProfile.updatedAt));
        const pcId = await pc.evaluate(() => state.myProfile.id);
        assert.notEqual(pcId, phoneId, 'own node id per device');

        // Beide in der Liste, signiert vom Handy; Handy bleibt aktiv (kein Umzug).
        await waitFor(phone, id => myDeviceList()?.devices.some(device => device.nodeId === id), pcId, 60000);
        await waitFor(pc, id => myDeviceList()?.devices.some(device => device.nodeId === id) && state.devicePairing?.joinedAt, pcId, 60000);
        assert.equal(await phone.evaluate(() => Boolean(state.movedAway)), false, 'phone stays active');
        assert.deepEqual(await pc.evaluate(() => myDeviceList().devices.map(device => [device.nodeId === myIdentityId(), device.canAdd])), [[true, true], [false, false]]);
        // Alte eigene Nachricht gilt auf dem PC als eigene.
        await pc.evaluate(id => openChatWithPeer(id), bobId);
        assert.equal(await pc.evaluate(id => {
            const message = state.chats[id].find(entry => entry.text === 'vom handy');
            return isOwnNode(message.senderId) && message.senderId !== state.myProfile.id;
        }, bobId), true);
        assert.deepEqual(pageErrors, []);
        console.log('E2E OK (devices pairing)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
