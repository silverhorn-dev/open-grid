// End-to-End: Multi-Device ohne Doppel-Eintrag (T38). Alices Handy ist offline, ihr PC meldet sich bei Bob und
// reicht die vom Handy unterschriebene Geraeteliste weiter. Bob hatte schon einen Chat unter der PC-ID (wie ihn der
// Service Worker bei einer Push-Nachricht anlegt): der wird in den Chat mit Alice gelegt, Alice steht einmal da.
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

        await phone.evaluate(() => openDevicePairing());
        await phone.click('#devices-code-btn');
        await phone.waitForSelector('#transfer-code-output', { timeout: 15000 });
        const code = await phone.inputValue('#transfer-code-output');
        const pc = await page('pc');
        await pc.click('#onboarding-transfer-btn');
        await pc.fill('#transfer-import-code', code.trim());
        await Promise.all([pc.waitForEvent('load', { timeout: 60000 }), pc.click('#transfer-import-btn')]);
        await waitFor(pc, () => Boolean(state.ws && state.ws.readyState === 1 && state.myProfile.updatedAt));
        const pcId = await pc.evaluate(() => state.myProfile.id);
        await waitFor(pc, id => myDeviceList()?.devices.some(device => device.nodeId === id) && state.devicePairing?.joinedAt, pcId, 60000);

        // Handy offline. Bob hat einen verirrten Chat unter der PC-ID (Push vom Service Worker).
        await phone.close();
        // Bob kennt Alices Geraete noch nicht (die Liste vom Handy kam z. B. nie an).
        await bob.evaluate(async id => {
            delete state.contactDevices[id];
            await deleteDatabaseRecord('keys', `contact-devices:${id}`);
        }, phoneId);
        await bob.evaluate(async id => {
            const message = { id: `stray-${Date.now()}`, peerId: id, senderId: id, text: 'aus dem push', createdAt: Date.now(), timestamp: '' };
            await persistChatMessage(id, message);
            await loadChatPeerIds();
        }, pcId);
        assert.equal(await bob.evaluate(id => state.chatPeerIds.includes(id), pcId), true, 'duplicate before the list');

        // Der PC verbindet sich mit Bob und reicht die Liste weiter; Bob nimmt sie an und legt den Chat zusammen.
        await pc.evaluate(id => openChatWithPeer(id), bobId);
        await waitFor(bob, ([identity, device]) => contactDeviceNodes(identity).includes(device), [phoneId, pcId], 45000);
        await waitFor(bob, id => !state.chatPeerIds.includes(id), pcId, 15000);
        await waitFor(bob, id => getDatabaseRecordsByIndex('messages', 'peerId', id).then(messages => messages.some(message => message.text === 'aus dem push')), phoneId, 15000);
        // Neue Nachricht vom PC landet ebenfalls bei Alice, nicht in einem neuen Eintrag.
        await pc.evaluate(async () => { document.getElementById('chat-input').value = 'vom pc'; await sendChatMessage(); });
        await waitFor(bob, id => (state.chats[id] || []).some(message => message.text === 'vom pc') || getDatabaseRecordsByIndex('messages', 'peerId', id).then(messages => messages.some(message => message.text === 'vom pc')), phoneId, 30000);
        assert.equal(await bob.evaluate(id => state.chatPeerIds.filter(peer => peer === id).length, phoneId), 1, 'Alice once in the chat list');
        assert.equal(await bob.evaluate(id => state.chatPeerIds.includes(id), pcId), false);
        assert.deepEqual(pageErrors, []);
        console.log('E2E OK (devices without duplicates)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
