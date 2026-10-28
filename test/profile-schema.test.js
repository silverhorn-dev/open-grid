import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { buildApp } from '../server/app.js';
import { createStore } from '../server/database.js';
import { I18N_STUBS } from './i18n-stubs.js';

function loadClientConfig() {
    const storage = new Map();
    const context = {
        window: {
            location: { origin: 'https://grid.example', protocol: 'https:', host: 'grid.example', search: '' },
            localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
            sessionStorage: { getItem: () => null, setItem: () => {} },
            crypto: globalThis.crypto
        },
        document: { getElementById: () => null, querySelector: () => null, documentElement: { dataset: {}, style: { setProperty: () => {} }, classList: { toggle: () => {}, add: () => {}, remove: () => {} } } },
        localStorage: { getItem: () => null, setItem: () => {} },
        navigator: {},
        console
    };
    vm.runInNewContext(readFileSync(new URL('../client/app/config.js', import.meta.url), 'utf8'), Object.assign(context, I18N_STUBS));
    return context;
}

// Regression: die eingebauten Schemas haben Labels je Sprache ({ de, en }); der Client verwarf deshalb
// alle Schemas vom Router, und "Nur Chat" bekam nie sein schlankes Profil.
test('the built-in profile schemas from the router pass the client check, chat keeps its slim schema', async () => {
    const store = createStore(':memory:');
    const app = await buildApp({ store, buildVersion: 'x', buildTimestamp: 'y' });
    try {
        const { profileSchemas } = (await app.inject({ method: 'GET', url: '/api/config' })).json();
        const client = loadClientConfig();
        const normalized = client.normalizeProfileSchemas(profileSchemas);
        assert.deepEqual(Object.keys(normalized).sort(), Object.keys(profileSchemas).sort());
        assert.deepEqual(normalized.chat.map(field => field.key), ['displayName', 'status']);
        assert.equal(typeof normalized.discovery[0].label, 'object', 'labels per language stay intact');
        assert.throws(() => client.validateProfileSchema([{ key: 'x', label: { de: 1 } }]), /key and label/);
        assert.throws(() => client.validateProfileSchema([{ key: 'x' }]), /key and label/);
        assert.ok(client.validateProfileSchema([{ key: 'x', label: 'Plain' }]));
    } finally {
        await app.close();
        store.close();
    }
});
