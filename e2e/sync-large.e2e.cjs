// End-to-End: Chat-Sync mit vielen Bildern (delivery.client.js, sendRequestedChatOperations). Alice schickt
// 8 Bilder (je ~60 KB), waehrend Bob offline ist und Alices Cloud-Cache aus ist (kein Pfad C). Kommt Bob
// wieder, muss alles ueber den direkten Chat-Sync ankommen; frueher ging das als ein einziges, zu grosses
// DataChannel-Paket nicht durch.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';
const IMAGES = 8;

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
    async function open(name, onboard) {
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
        return page;
    }
    try {
        const alice = await open('Alice', true);
        const bob = await open('Bob', true);
        const [aliceId, bobId] = await Promise.all([alice, bob].map(page => page.evaluate(() => state.myProfile.id)));
        await bob.evaluate(async id => {
            await openChatWithPeer(id);
            document.getElementById('chat-input').value = 'hi';
            await sendChatMessage();
        }, aliceId);
        await waitFor(alice, id => (state.chats[id] || []).some(message => message.text === 'hi'), bobId);

        // Bob geht offline, Alice ohne Pfad C.
        await bob.close();
        await alice.evaluate(() => { state.gridSettings.cacheEnabled = false; });
        await alice.evaluate(async ([id, count]) => {
            await openChatWithPeer(id);
            for (let index = 0; index < count; index += 1) {
                // Rauschen komprimiert schlecht: ~60 KB je Bild.
                const canvas = document.createElement('canvas');
                canvas.width = 320;
                canvas.height = 320;
                const context = canvas.getContext('2d');
                const image = context.createImageData(320, 320);
                for (let pixel = 0; pixel < image.data.length; pixel += 1) image.data[pixel] = Math.random() * 255;
                context.putImageData(image, 0, 0);
                await sendChatMessage(canvas.toDataURL('image/jpeg', 0.8), `bild ${index}`, null, null, { asImage: true });
            }
        }, [bobId, IMAGES]);
        const sizes = await alice.evaluate(id => state.chats[id].filter(message => message.snapData).map(message => message.snapData.length), bobId);
        assert.equal(sizes.length, IMAGES);
        assert.ok(sizes.reduce((sum, size) => sum + size, 0) > 300 * 1024, `enough data to exceed one channel message (${sizes})`);

        // Alice laedt neu: die Sende-Queue im Speicher ist weg, nur der Chat-Sync kann jetzt noch zustellen.
        await alice.reload();
        await waitFor(alice, () => Boolean(state.ws && state.ws.readyState === 1 && state.myProfile.id));
        await alice.evaluate(() => { state.gridSettings.cacheEnabled = false; });

        // Bob kommt zurueck: alle Bilder per Chat-Sync.
        const back = await open('Bob', false);
        await back.evaluate(id => openChatWithPeer(id), aliceId);
        await waitFor(back, ([id, count]) => (state.chats[id] || []).filter(message => message.snapData && /^bild \d$/.test(message.text)).length === count, [aliceId, IMAGES], 90000);
        // Signierte Operationen (T36 P0): Alices Operationen kommen mit gueltiger Signatur an.
        const signature = await back.evaluate(async id => {
            const operations = await getChatOperations(id);
            const put = operations.find(operation => operation.type === 'MESSAGE_PUT' && operation.actorId === id);
            const key = (await getPeerIdentity(id))?.profileSigningKey;
            return { signed: typeof put?.sig === 'string', valid: await verifyOperationSignature(put, key) };
        }, aliceId);
        assert.deepEqual(signature, { signed: true, valid: true });
        assert.deepEqual(pageErrors, []);
        console.log('E2E OK (sync with many images)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
