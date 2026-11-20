// End-to-End: Profilbild verifizieren (verify.js, Board T37 V2). Alice laedt ein Profilbild hoch, stimmt zu,
// die "Kamera" (Canvas) liefert je Schritt ein Bild; die Router-Antworten (/api/verify/*) sind hier nachgebaut, die
// echte Pruefung testet test/verify.test.js. Danach traegt Alices Profil den Haken, Bob bekommt ihn mit dem
// Profil; ein neues Profilbild nimmt ihn wieder weg.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
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
    const finished = [];
    async function user(name, verifyRouter = false) {
        const context = await browser.newContext({ locale: 'de-DE' });
        if (verifyRouter) {
            await context.route('**/api/config', async route => {
                const response = await route.fetch();
                const config = await response.json();
                config.verify = { enabled: true, key: { x: 'x', y: 'y' }, steps: ['straight', 'left', 'right'], days: 90 };
                await route.fulfill({ response, json: config });
            });
            await context.route('**/api/verify/start', route => route.fulfill({
                json: { sessionId: 'session-1', steps: ['left', 'straight', 'right'], expiresAt: Date.now() + 120000 }
            }));
            await context.route('**/api/verify/finish', route => {
                const body = route.request().postDataJSON();
                finished.push(body);
                const now = Date.now();
                return route.fulfill({ json: { ok: true, badge: { subject: body.peerId, avatarSha256: body.avatarSha256, issuedAt: now, expiresAt: now + 90 * 86400000 }, sig: 'c2lnbmF0dXJl' } });
            });
        }
        const page = await context.newPage();
        page.on('pageerror', error => pageErrors.push(`[${name}] ${error.message}`));
        await page.goto(`${BASE_URL}/`);
        await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        const input = page.locator('#onboarding-profile-form input').first();
        await input.fill(name);
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1 && state.myProfile.id));
        return page;
    }
    async function uploadAvatar(page, shade) {
        const png = await page.evaluate(value => {
            const canvas = document.createElement('canvas');
            canvas.width = 400;
            canvas.height = 400;
            const context = canvas.getContext('2d');
            context.fillStyle = `rgb(${value}, 120, 160)`;
            context.fillRect(0, 0, 400, 400);
            return canvas.toDataURL('image/png').split(',')[1];
        }, shade);
        const before = await page.evaluate(() => state.myProfile.avatarFull?.id || null);
        await page.setInputFiles('input[data-change="handleAvatarUpload"]', { name: 'me.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
        await waitFor(page, previous => Boolean(state.myProfile.avatarFull?.id) && state.myProfile.avatarFull.id !== previous, before);
    }
    try {
        const alice = await user('Alice', true);
        const bob = await user('Bob');
        const [aliceId, bobId] = await Promise.all([alice, bob].map(page => page.evaluate(() => state.myProfile.id)));

        // Profil-Editor (Entdecken-Profil). Ohne Profilbild: Knopf aus.
        await alice.evaluate(async () => { await setAppMode('discovery'); switchTab('editprofile'); renderVerifyCard(); });
        assert.equal(await alice.evaluate(() => document.getElementById('verify-card').classList.contains('hidden')), false, 'card shown when the router verifies');
        assert.equal(await alice.evaluate(() => document.getElementById('verify-start-btn').disabled), true, 'needs a profile picture');

        await uploadAvatar(alice, 200);
        await alice.evaluate(() => renderVerifyCard());
        assert.equal(await alice.evaluate(() => document.getElementById('verify-start-btn').disabled), false);

        // Kamera = Canvas.
        await alice.evaluate(() => {
            const canvas = document.createElement('canvas');
            canvas.width = 640;
            canvas.height = 480;
            const context = canvas.getContext('2d');
            let frame = 0;
            setInterval(() => {
                context.fillStyle = `hsl(${frame++ % 360}, 60%, 50%)`;
                context.fillRect(0, 0, 640, 480);
            }, 100);
            canvas.style.cssText = 'position:fixed;left:-9999px';
            document.body.append(canvas);
            navigator.mediaDevices.getUserMedia = async constraints => {
                window.verifyCameraConstraints = constraints;
                return canvas.captureStream(10);
            };
        });
        await alice.click('#verify-start-btn');
        await alice.waitForSelector('#verify-consent-btn', { state: 'visible' });
        await alice.click('#verify-consent-btn');
        // Schritte in der Reihenfolge des Routers, mit Anweisung.
        await waitFor(alice, () => document.getElementById('verify-instruction')?.dataset.step === 'left');
        assert.match(await alice.textContent('#verify-instruction'), /links/);
        await waitFor(alice, () => document.getElementById('verify-instruction')?.dataset.step === 'straight', undefined, 6000);
        await waitFor(alice, () => document.getElementById('verify-instruction')?.dataset.step === 'right', undefined, 6000);
        await waitFor(alice, () => Boolean(ownVerification()), undefined, 15000);
        assert.equal(await alice.evaluate(() => window.verifyCameraConstraints.video.facingMode), 'user', 'front camera');

        // Was an den Router ging: drei Kamerabilder, das Profilbild in voller Groesse und dessen Hash.
        assert.equal(finished.length, 1);
        const sent = finished[0];
        assert.equal(sent.sessionId, 'session-1');
        assert.equal(sent.frames.length, 3);
        assert.ok(sent.frames.every(frame => frame.startsWith('data:image/jpeg;base64,')));
        assert.equal(sent.avatarSha256, createHash('sha256').update(sent.profileImage).digest('base64'));
        assert.equal(sent.avatarSha256, await alice.evaluate(() => state.myProfile.avatarFull.sha256));
        // Kamera wieder aus.
        assert.equal(await alice.evaluate(() => document.getElementById('verify-video')?.srcObject || null), null);

        // Haken im Profil: Karte und Profil fuer andere.
        await alice.evaluate(() => renderVerifyCard());
        assert.ok(await alice.evaluate(() => document.getElementById('verify-card').classList.contains('is-verified')));
        assert.equal(await alice.evaluate(id => buildProfilePayloadFor(id).verified?.badge.subject, bobId), aliceId);
        await bob.evaluate(id => openProfileModal(id), aliceId);
        await waitFor(bob, id => state.cachedProfiles[id]?.verified?.badge?.subject === id, aliceId);

        // Neues Profilbild: Haken weg.
        await uploadAvatar(alice, 40);
        assert.equal(await alice.evaluate(() => ownVerification()), null);
        assert.equal(await alice.evaluate(id => buildProfilePayloadFor(id).verified, bobId), undefined);

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (profile verification)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
