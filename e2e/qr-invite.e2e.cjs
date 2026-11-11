// End-to-End: OpenGrid-Codes einfuegen und scannen (qr-scan.js). Bob fuegt Alices Einladungslink ein, Carol scannt
// ihn mit der Kamera (Einladen-Karte), Dave hat ihn in der Snap-Kamera im Bild und tippt auf den Hinweis. Die
// "Kamera" ist ein Canvas mit dem QR-Code (captureStream); Chromium unter Linux hat keinen BarcodeDetector,
// also laeuft jsQR vom Router.
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
    const contexts = {};
    async function user(name, onboard = true) {
        contexts[name] = contexts[name] || await browser.newContext({ locale: 'de-DE' });
        const page = await contexts[name].newPage();
        page.on('pageerror', error => pageErrors.push(`[${name}] ${error.message}`));
        await page.goto(`${BASE_URL}/`);
        if (onboard) {
            await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
            const input = page.locator('#onboarding-profile-form input').first();
            await input.fill(name);
            await input.dispatchEvent('change');
            await page.click('#complete-onboarding-btn');
        }
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1 && state.myProfile.id));
        await page.evaluate(() => setAppMode('chat'));
        return page;
    }
    async function befriend(a, b) {
        const [aId, bId] = await Promise.all([a, b].map(page => page.evaluate(() => state.myProfile.id)));
        await a.evaluate(async id => { await openChatWithPeer(id); document.getElementById('chat-input').value = 'hi'; await sendChatMessage(); }, bId);
        await waitFor(b, id => (state.chats[id] || []).length > 0, aId);
        await a.evaluate(id => addFriend(id), bId);
        await waitFor(b, id => hasFriendRequest(id), aId);
        await b.evaluate(id => addFriend(id), aId);
        await waitFor(a, id => isFriend(id), bId);
    }
    // Kamera = Canvas mit dem QR-Code des Links.
    async function fakeCamera(page, link) {
        await page.evaluate(text => {
            const code = qrcode(0, 'M');
            code.addData(text);
            code.make();
            const canvas = document.createElement('canvas');
            canvas.width = 640;
            canvas.height = 480;
            const context = canvas.getContext('2d');
            const draw = () => {
                context.fillStyle = '#fff';
                context.fillRect(0, 0, 640, 480);
                const cells = code.getModuleCount();
                const cell = Math.floor(360 / cells);
                const left = (640 - cells * cell) / 2;
                const top = (480 - cells * cell) / 2;
                context.fillStyle = '#000';
                for (let row = 0; row < cells; row++) for (let col = 0; col < cells; col++) {
                    if (code.isDark(row, col)) context.fillRect(left + col * cell, top + row * cell, cell, cell);
                }
            };
            draw();
            setInterval(draw, 100);
            document.body.append(canvas);
            canvas.style.cssText = 'position:fixed;left:-9999px';
            navigator.mediaDevices.getUserMedia = async () => canvas.captureStream(10);
        }, link);
    }
    try {
        const alice = await user('Alice');
        const aliceId = await alice.evaluate(() => state.myProfile.id);
        const link = await alice.evaluate(() => getMyInviteLink());

        // Einfuegen.
        const bob = await user('Bob');
        await bob.evaluate(text => {
            document.getElementById('invite-paste-input').value = text;
            document.getElementById('invite-paste-btn').click();
        }, link);
        await waitFor(bob, id => state.activeChatPeerId === id, aliceId);
        // Nur der Code (ohne Link) geht auch; Unsinn gibt einen Hinweis.
        await bob.evaluate(() => { document.getElementById('invite-paste-input').value = 'kein code'; document.getElementById('invite-paste-btn').click(); });
        await waitFor(bob, () => document.getElementById('toast-container').textContent.includes('kein OpenGrid-Code'), null, 5000);

        // Scannen (Einladen-Karte).
        const carol = await user('Carol');
        await fakeCamera(carol, link);
        await carol.evaluate(() => document.getElementById('invite-scan-btn').click());
        await waitFor(carol, id => state.activeChatPeerId === id, aliceId, 20000);
        assert.equal(await carol.evaluate(() => Boolean(document.getElementById('qr-scan-video'))), false, 'scanner closed');

        // Snap-Kamera erkennt den Code im Bild.
        const dave = await user('Dave');
        await fakeCamera(dave, link);
        await dave.evaluate(() => openSnapCamera('chat'));
        await dave.waitForSelector('#snap-qr-chip:not(.hidden)', { timeout: 20000 });
        assert.match(await dave.textContent('#snap-qr-chip'), /Einladung öffnen/);
        await dave.click('#snap-qr-chip');
        await waitFor(dave, id => state.activeChatPeerId === id, aliceId, 20000);
        assert.equal(await dave.evaluate(() => document.getElementById('snap-capture-modal').classList.contains('hidden')), true);
        // Ankommen: Alice bekommt Bobs Nachricht ueber den neuen Kontakt.
        await bob.evaluate(async () => { document.getElementById('chat-input').value = 'per einladung'; await sendChatMessage(); });
        await waitFor(alice, () => Object.values(state.chats).flat().some(message => message.text === 'per einladung'), null, 30000);
        assert.deepEqual(pageErrors, []);
        console.log('E2E OK (invite paste and qr scan)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
