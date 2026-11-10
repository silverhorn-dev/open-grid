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

        // Vor dem Koppeln: eine Gruppe mit Bob und eine Einstellung; beides muss mitkommen.
        const groupId = await phone.evaluate(async id => (await createGroup('Team', [id])).id, bobId);
        await waitFor(bob, id => Boolean(getGroup(id)), groupId);
        await phone.evaluate(async id => { await openChatWithPeer(id); document.getElementById('chat-input').value = 'gruppe vorher'; await sendChatMessage(); }, groupId);
        await phone.evaluate(() => window.localStorage.setItem('opengrid-chat-font-size', 'large'));

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
        // Alles uebernommen: Gruppe mit Verlauf und Einstellungen.
        assert.equal(await pc.evaluate(async id => isGroupActive(id)
            && (await getChatOperations(id)).some(op => op.message?.text === 'gruppe vorher'), groupId), true, 'group came along');
        assert.equal(await pc.evaluate(() => window.localStorage.getItem('opengrid-chat-font-size')), 'large', 'settings came along');
        // Alte eigene Nachricht gilt auf dem PC als eigene.
        await pc.evaluate(id => openChatWithPeer(id), bobId);
        assert.equal(await pc.evaluate(id => {
            const message = state.chats[id].find(entry => entry.text === 'vom handy');
            return isOwnNode(message.senderId) && message.senderId !== state.myProfile.id;
        }, bobId), true);
        // P4b: was das Handy schreibt, erscheint auf dem PC; was Bob ans Handy schickt, auch.
        await phone.evaluate(async id => { await openChatWithPeer(id); document.getElementById('chat-input').value = 'handy schreibt'; await sendChatMessage(); }, bobId);
        await waitFor(pc, id => (state.chats[id] || []).some(message => message.text === 'handy schreibt'), bobId, 45000);
        await bob.evaluate(async id => { await openChatWithPeer(id); document.getElementById('chat-input').value = 'bob antwortet'; await sendChatMessage(); }, phoneId);
        await waitFor(pc, id => (state.chats[id] || []).some(message => message.text === 'bob antwortet'), bobId, 45000);
        // P3: Original eines Bildes vom Handy kommt auch auf den PC (eigenes Geraet als Quelle).
        const imageId = await phone.evaluate(async id => {
            await openChatWithPeer(id);
            const canvas = document.createElement('canvas');
            canvas.width = 600; canvas.height = 400;
            const context = canvas.getContext('2d');
            for (let index = 0; index < 200; index++) { context.fillStyle = `hsl(${index * 41 % 360}, 60%, 50%)`; context.fillRect((index * 31) % 600, (index * 17) % 400, 50, 30); }
            await sendChatMessage(canvas.toDataURL('image/jpeg', 0.3), '', null, null, { original: await createOriginalImage(canvas, id) });
            return state.chats[id].at(-1).id;
        }, bobId);
        await waitFor(pc, mid => Object.values(state.chats).flat().find(message => message.id === mid)?.originalReady === true, imageId, 60000);

        // P4c: Bob kennt Alices Geraete; was der PC schreibt, steht bei Bob im Chat mit Alice (nicht als neuer Kontakt).
        await waitFor(bob, ([identity, device]) => contactDeviceNodes(identity).includes(device), [phoneId, pcId], 45000);
        await pc.evaluate(async id => { await openChatWithPeer(id); document.getElementById('chat-input').value = 'vom pc'; await sendChatMessage(); }, bobId);
        await waitFor(bob, id => (state.chats[id] || []).some(message => message.text === 'vom pc'), phoneId, 45000);
        assert.equal(await bob.evaluate(id => state.chatPeerIds.includes(id), pcId), false, 'no separate chat for the pc');
        assert.equal(await bob.evaluate(id => displayNameFor(id), pcId), 'Alice');
        await waitFor(phone, id => (state.chats[id] || []).some(message => message.text === 'vom pc'), bobId, 45000);
        // Gruppen ueber Geraete: der PC schreibt in die Gruppe, Bob sieht es als Alice; Bobs Antwort kommt auf beiden an.
        await pc.evaluate(async id => { await openChatWithPeer(id); document.getElementById('chat-input').value = 'gruppe vom pc'; await sendChatMessage(); }, groupId);
        await waitFor(bob, id => (state.chats[id] || []).some(message => message.text === 'gruppe vom pc'), groupId, 45000);
        await waitFor(phone, id => (state.chats[id] || []).some(message => message.text === 'gruppe vom pc'), groupId, 45000);
        await bob.evaluate(async id => { await openChatWithPeer(id); document.getElementById('chat-input').value = 'gruppe von bob'; await sendChatMessage(); }, groupId);
        await waitFor(pc, id => (state.chats[id] || []).some(message => message.text === 'gruppe von bob'), groupId, 45000);
        await waitFor(phone, id => (state.chats[id] || []).some(message => message.text === 'gruppe von bob'), groupId, 45000);
        // Eine neue Gruppe vom Handy erscheint auch auf dem PC.
        const group2 = await phone.evaluate(async id => (await createGroup('Zwei', [id])).id, bobId);
        await waitFor(pc, id => isGroupActive(id), group2, 45000);
        // Einstellungen danach nicht abgeglichen.
        await phone.evaluate(() => window.localStorage.setItem('opengrid-chat-font-size', 'small'));

        // P4d: zuletzt aktives Geraet im Grid; das andere meldet sich still an.
        await pc.evaluate(() => { state.ownDeviceActivity[state.myProfile.id] = 0; markThisDeviceActive(); });
        await waitFor(phone, () => deviceHiddenFromGrid(), null, 30000);
        // Beim Router: das Handy ist nicht mehr im Grid, der PC schon.
        const gridHas = (viewer, id) => viewer.evaluate(async peer => {
            const response = await fetch(`/api/grid?geohash=${state.myProfile.geohash}`);
            return (await response.json()).peers.some(entry => entry.id === peer);
        }, id);
        await waitFor(bob, async () => true, null, 500);
        const startedAt = Date.now();
        while (await gridHas(bob, phoneId) && Date.now() - startedAt < 30000) await bob.waitForTimeout(500);
        assert.equal(await gridHas(bob, phoneId), false, 'inactive device hidden from the grid');
        assert.equal(await gridHas(bob, pcId), true, 'active device visible');
        // Verwalten: das Handy gibt dem PC das Recht, dann entfernt es ihn wieder testweise nicht (Wurzel bleibt).
        await phone.evaluate(id => grantDeviceRight(id), pcId);
        await waitFor(pc, () => canAddDevices(), null, 30000);

        // Handy zu: Bob schreibt Alice, der PC bekommt es direkt.
        await phone.close();
        await bob.evaluate(async id => { await openChatWithPeer(id); document.getElementById('chat-input').value = 'handy ist aus'; await sendChatMessage(); }, phoneId);
        await waitFor(pc, id => (state.chats[id] || []).some(message => message.text === 'handy ist aus'), bobId, 60000);
        await bob.evaluate(async id => { await openChatWithPeer(id); document.getElementById('chat-input').value = 'gruppe handy aus'; await sendChatMessage(); }, groupId);
        await waitFor(pc, id => (state.chats[id] || []).some(message => message.text === 'gruppe handy aus'), groupId, 60000);
        assert.equal(await pc.evaluate(() => window.localStorage.getItem('opengrid-chat-font-size')), 'large', 'settings are not synced later');
        // Ein drittes Geraet wird gekoppelt und vom PC (hat jetzt das Recht) wieder entfernt.
        const tablet = await page('tablet');
        await pc.evaluate(() => openDevicePairing());
        await pc.click('#devices-code-btn');
        await pc.waitForSelector('#transfer-code-output', { timeout: 15000 });
        const tabletCode = await pc.inputValue('#transfer-code-output');
        await tablet.click('#onboarding-transfer-btn');
        await tablet.fill('#transfer-import-code', tabletCode.trim());
        await Promise.all([tablet.waitForEvent('load', { timeout: 60000 }), tablet.click('#transfer-import-btn')]);
        await waitFor(tablet, () => Boolean(state.ws && state.ws.readyState === 1 && state.myProfile.updatedAt));
        const tabletId = await tablet.evaluate(() => state.myProfile.id);
        await waitFor(pc, id => myDeviceList().devices.some(device => device.nodeId === id), tabletId, 60000);
        await pc.evaluate(id => removeOwnDevice(id), tabletId);
        await waitFor(tablet, () => !myDeviceList(), null, 60000);
        await waitFor(bob, ([identity, device]) => !contactDeviceNodes(identity).includes(device), [phoneId, tabletId], 60000);
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
