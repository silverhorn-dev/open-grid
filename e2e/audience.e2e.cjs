// End-to-End: "Nur zeigen fuer ...". Bob zeigt sich nur Leuten mit Position "Top". Der Router haengt
// nur den kurzen Code an Bobs Karte; die App von Alice (Bottom) blendet ihn aus, Carol (Top) sieht ihn.
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
    async function user(name, role) {
        const page = await (await browser.newContext({ locale: 'de-DE' })).newPage();
        page.on('pageerror', error => pageErrors.push(`[${name}] ${error.message}`));
        await page.goto(`${BASE_URL}/`);
        await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        const input = page.locator('#onboarding-profile-form input').first();
        await input.fill(name);
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1 && state.myProfile.id));
        await page.evaluate(async value => {
            await setAppMode('discovery');
            state.myProfile.fields.role = value;
        }, role);
        return page;
    }
    const gridNames = page => page.evaluate(async () => {
        await fetchPeersFromWorkerGrid();
        switchTab('grid');
        renderDiscoveryGrid();
        return document.getElementById('grid-container').textContent;
    });

    // Eindeutige Namen: im Gesamtlauf stehen andere "Bob" aus frueheren Tests in derselben Zelle.
    const tag = Math.random().toString(36).slice(2, 7);
    const bobName = `Bob${tag}`;
    try {
        const bob = await user(bobName, 'Versatile');
        const alice = await user(`Alice${tag}`, 'Bottom');
        const carol = await user(`Carol${tag}`, 'Top');
        const bobId = await bob.evaluate(() => state.myProfile.id);

        // Ohne Regel sehen ihn beide.
        await waitFor(alice, async name => { await fetchPeersFromWorkerGrid(); return state.peers.some(peer => peer.name === name); }, bobName);
        assert.ok((await gridNames(alice)).includes(bobName));

        // Regel in den Einstellungen: nur Position "Top". Auch im Chat-Modus (Bereich "Entdecken & Freunde")
        // stehen die Felder aus "Entdecken" zur Wahl (vorher: keine, weil das Chat-Schema keine hat).
        await bob.evaluate(async () => { await setAppMode('chat'); });
        // App startet im Chat-Modus (neu laden): beim Laden ist das aktive Schema das Chat-Schema.
        await bob.reload();
        await waitFor(bob, () => Boolean(state.ws && state.ws.readyState === 1 && state.audienceRule));
        await bob.evaluate(() => { switchTab('keys'); switchSettingsTab('privacy'); });
        assert.ok(await bob.locator('[data-audience-option^="role:"]').count() > 0, 'explore fields selectable when the app starts in chat mode');
        await bob.evaluate(async () => { await setAppMode('discovery'); switchTab('keys'); switchSettingsTab('privacy'); });
        await bob.click('[data-audience-option="role:Top"]');
        await waitFor(bob, () => /Regel aktiv/.test(document.getElementById('audience-summary').textContent));

        // Der Router liefert nur den Code an der Karte.
        await waitFor(alice, async id => {
            const response = await fetch(`/api/grid?geohash=${state.myProfile.geohash}`);
            const card = (await response.json()).peers.find(peer => peer.id === id);
            return typeof card?.audience === 'string' && card.audience.length <= 12;
        }, bobId);
        await waitFor(alice, async name => { await fetchPeersFromWorkerGrid(); renderDiscoveryGrid(); return !document.getElementById('grid-container').textContent.includes(name); }, bobName);
        assert.ok((await gridNames(carol)).includes(bobName), 'Top sees him');

        // Schalter aus: Regel bleibt gespeichert, gilt aber nicht -> Alice sieht ihn wieder; wieder an -> weg.
        await bob.click('#audience-enabled-toggle');
        await waitFor(bob, () => /Alle sehen dich/.test(document.getElementById('audience-summary').textContent));
        assert.equal(await bob.evaluate(() => state.audienceRule.options.role.includes('Top')), true, 'rule kept');
        await waitFor(alice, async name => { await fetchPeersFromWorkerGrid(); renderDiscoveryGrid(); return document.getElementById('grid-container').textContent.includes(name); }, bobName);
        await bob.click('#audience-enabled-toggle');
        await waitFor(bob, () => /Regel aktiv/.test(document.getElementById('audience-summary').textContent));
        await waitFor(alice, async name => { await fetchPeersFromWorkerGrid(); renderDiscoveryGrid(); return !document.getElementById('grid-container').textContent.includes(name); }, bobName);

        // Regel weg: wieder fuer alle.
        await bob.click('[data-click="resetAudienceRule"]');
        await waitFor(alice, async name => { await fetchPeersFromWorkerGrid(); renderDiscoveryGrid(); return document.getElementById('grid-container').textContent.includes(name); }, bobName);

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (audience)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
