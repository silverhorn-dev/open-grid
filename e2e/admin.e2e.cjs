// End-to-End: Admin-Panel mit echtem WebAuthn im Browser (virtueller Authenticator von Chrome).
// Erster Passkey ueber den Setup-Link, Auslastung mit Diagrammen und Fadenkreuz, Abmelden, Anmelden.
// Braucht ADMIN_SETUP_TOKEN=e2e-admin-setup am Server und "localhost" (WebAuthn erlaubt keine IP als RP-ID).
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const BASE_URL = (process.env.BASE_URL || 'http://127.0.0.1:3000').replace('127.0.0.1', 'localhost');
const SETUP = process.env.ADMIN_SETUP_TOKEN || 'e2e-admin-setup';

async function main() {
    if (process.env.MOBILE || process.env.OFFLINE) return;
    const browser = await chromium.launch();
    const pageErrors = [];
    try {
        const context = await browser.newContext({ locale: 'de-DE', viewport: { width: 1280, height: 900 } });
        const page = await context.newPage();
        page.on('pageerror', error => pageErrors.push(error.message));
        const cdp = await context.newCDPSession(page);
        await cdp.send('WebAuthn.enable');
        await cdp.send('WebAuthn.addVirtualAuthenticator', {
            options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true }
        });

        const session = await (await page.request.get(`${BASE_URL}/api/admin/session`)).json();
        if (!session.setupPending) {
            // Geteilter E2E-Server: ein frueherer Lauf hat schon einen Passkey angelegt.
            console.log('E2E SKIP (admin): passkey already exists on this server');
            return;
        }
        await page.goto(`${BASE_URL}/admin#setup=${SETUP}`);
        await page.waitForSelector('#admin-login:not(.hidden)');
        assert.equal(await page.textContent('#admin-login-title'), 'Ersten Admin-Passkey anlegen');
        assert.equal(page.url().includes('setup='), false, 'token removed from the address bar');
        await page.fill('#admin-passkey-name', 'E2E');
        await page.click('#admin-login-btn');
        await page.waitForSelector('#admin-panel:not(.hidden)', { timeout: 15000 });

        // Auslastung: zwoelf Diagramme, Fadenkreuz + Tooltip beim Zeigen, Tabelle.
        // Fuer einen Blick auf echte Linien: ADMIN_SCREENSHOT_WAIT_MS (eine Messung alle 10 s).
        if (process.env.ADMIN_SCREENSHOT_WAIT_MS) {
            await page.waitForTimeout(Number(process.env.ADMIN_SCREENSHOT_WAIT_MS));
            await page.click('[data-admin-range="1h"]');
            await page.waitForTimeout(800);
        }
        for (let attempt = 0; attempt < 30 && await page.locator('#admin-charts .admin-chart svg').count() < 12; attempt += 1) await page.waitForTimeout(500);
        assert.equal(await page.locator('#admin-charts .admin-chart').count(), 12);
        const hit = page.locator('#admin-charts .admin-chart .admin-hit').first();
        const box = await hit.boundingBox();
        await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2);
        assert.equal(await page.isVisible('#admin-tooltip'), true, 'tooltip on hover');
        assert.match(await page.textContent('#admin-tooltip'), /CPU/);
        assert.equal(await page.locator('#admin-load-table tr').count(), 12);
        await page.mouse.move(0, 0);
        await page.screenshot({ path: process.env.SCREENSHOT_DIR ? `${process.env.SCREENSHOT_DIR}/admin-load.png` : '/tmp/admin-load.png', fullPage: true });

        // Status und Passkeys.
        await page.click('[data-admin-tab="status"]');
        await page.waitForSelector('#admin-status dt');
        assert.match(await page.textContent('#admin-status'), /Peers/);
        await page.click('[data-admin-tab="passkeys"]');
        await page.waitForSelector('#admin-passkey-list li');
        assert.match(await page.textContent('#admin-passkey-list'), /E2E/);

        // Abmelden, mit dem Passkey wieder anmelden.
        await page.click('#admin-logout');
        await page.waitForSelector('#admin-login:not(.hidden)');
        assert.equal(await page.textContent('#admin-login-title'), 'Anmelden');
        await page.click('#admin-login-btn');
        await page.waitForSelector('#admin-panel:not(.hidden)', { timeout: 15000 });

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (admin panel)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
