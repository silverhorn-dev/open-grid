// End-to-End: zwei Nutzer, Nachricht zustellen, Chat loeschen, neu laden, blockieren.
// Laeuft gegen einen gestarteten Server (BASE_URL, Standard http://127.0.0.1:3000).
// MOBILE=1 emuliert ein iPhone (Touch), OFFLINE=1 nimmt den Partner vor dem Loeschen offline.
// Start ohne lokales Node: scripts/e2e.sh
const assert = require('node:assert/strict');
const { chromium, devices } = require('playwright');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';
const MOBILE = Boolean(process.env.MOBILE);
const OFFLINE = Boolean(process.env.OFFLINE);

// Polling ueber page.evaluate statt waitForFunction (das nutzt eval und scheitert an der CSP).
async function waitFor(page, predicate, arg, timeout = 20000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
        if (await page.evaluate(predicate, arg).catch(() => false)) return;
        await page.waitForTimeout(250);
    }
    throw new Error(`Timed out waiting for ${predicate}`);
}

async function recordToasts(page) {
    await page.evaluate(() => {
        window.__toasts = [];
        const original = showToast;
        showToast = (message, type) => {
            window.__toasts.push(`${type}: ${message}`);
            original(message, type);
        };
    });
}

async function main() {
    const browser = await chromium.launch();
    const pageErrors = [];

    async function user(name) {
        const context = await browser.newContext(MOBILE ? { ...devices['iPhone 13'] } : {});
        const page = await context.newPage();
        page.on('pageerror', error => pageErrors.push(`[${name}] ${error.message}`));
        page.on('dialog', dialog => dialog.accept());
        await page.goto(`${BASE_URL}/`);
        await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        const input = page.locator('#onboarding-profile-form input').first();
        await input.fill(name);
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1 && state.myProfile.id));
        await recordToasts(page);
        return page;
    }

    try {
        const alice = await user('Alice');
        const bob = await user('Bob');
        const bobId = await bob.evaluate(() => state.myProfile.id);
        const press = selector => (MOBILE ? alice.tap(selector, { timeout: 5000 }) : alice.click(selector, { timeout: 5000 }));

        // 1. Nachricht A -> B
        await alice.evaluate(id => openChatWithPeer(id), bobId);
        await alice.fill('#chat-input', 'hallo bob');
        await alice.click('#send-chat-btn');
        await waitFor(bob, () => Object.values(state.chats).some(list => list.some(message => message.text === 'hallo bob')), null, 30000);

        if (OFFLINE) {
            await bob.context().close();
            await alice.waitForTimeout(6000);
        }

        // 2. Chat loeschen ueber das Kopfzeilen-Menue
        await press('#chat-header-menu-btn');
        assert.ok(await alice.isVisible('#delete-chat-btn'), 'delete button visible');
        await press('#delete-chat-btn');
        await waitFor(alice, id => !(state.chats[id] || []).length && !state.chatPeerIds.includes(id), bobId);
        if (!OFFLINE) {
            await waitFor(bob, () => Object.values(state.chats).every(list => list.length === 0), null, 15000);
        }

        // 3. Nach dem Neuladen bleibt der Chat geloescht
        await alice.reload();
        await waitFor(alice, () => Boolean(state.ws && state.ws.readyState === 1 && state.myProfile.id));
        await alice.waitForTimeout(3000);
        assert.equal(await alice.evaluate(id => (state.chats[id] || []).length, bobId), 0, 'chat stays deleted after reload');
        assert.equal(await alice.evaluate(id => state.chatPeerIds.includes(id), bobId), false);
        await recordToasts(alice);

        // 4. Blockieren
        await alice.evaluate(id => openChatWithPeer(id), bobId);
        await press('#chat-header-menu-btn');
        assert.ok(await alice.isVisible('#block-peer-btn'), 'block button visible');
        await press('#block-peer-btn');
        await waitFor(alice, id => isPeerBlocked(id), bobId);

        assert.deepEqual(pageErrors, [], 'no uncaught page errors');
        console.log(`E2E OK (${MOBILE ? 'mobile' : 'desktop'}${OFFLINE ? ', offline partner' : ''})`);
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
