#!/usr/bin/env node
/**
 * Werkzeug fuer Betreiber (Board T2): Sperren setzen und Daten fuer eine behoerdliche Anfrage lesen.
 * Laeuft im Container neben dem Server, nutzt dieselbe Datenbank und denselben SAFETY_KEY.
 *
 *   node scripts/safety-admin.mjs ban-peer <peerId> [grund]
 *   node scripts/safety-admin.mjs ban-email <adresse> [grund]
 *   node scripts/safety-admin.mjs access-log <peerId>      IP-Protokoll (nur mit ABUSE_LOG_DAYS > 0)
 *   node scripts/safety-admin.mjs email <peerId>           bestaetigte E-Mail entschluesseln
 *
 * Auskunft nur auf richterlichen Beschluss; jede Abfrage steht im Server-Log.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../server/database.js';
import { createSafetyCrypto, loadSafetyKey, normalizeEmail, parseSafetyConfig } from '../server/safety.js';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const [command, value, ...rest] = process.argv.slice(2);
const reason = rest.join(' ') || null;
if (!command || !value) {
    console.error('Aufruf: safety-admin.mjs ban-peer|ban-email|access-log|email <wert> [grund]');
    process.exit(1);
}
const store = createStore(process.env.DATABASE_PATH || join(root, 'data', 'open-grid.sqlite'));
const config = parseSafetyConfig({ safetyKey: process.env.SAFETY_KEY });
const safetyCrypto = () => createSafetyCrypto(loadSafetyKey(config, store));
try {
    if (command === 'ban-peer') {
        store.safety.addBan('peer', value, reason);
        console.log(`Peer ${value} gesperrt.`);
    } else if (command === 'ban-email') {
        const email = normalizeEmail(value);
        if (!email) throw new Error('Ungueltige E-Mail-Adresse.');
        store.safety.addBan('email', safetyCrypto().hash('email', email), reason);
        console.log('E-Mail-Adresse gesperrt (gespeichert ist nur ein HMAC).');
    } else if (command === 'access-log') {
        for (const entry of store.safety.listAccess(value)) console.log(`${new Date(entry.seenAt).toISOString()}  ${entry.ip}`);
    } else if (command === 'email') {
        const encrypted = store.safety.getEmailCiphertext(value);
        console.log(encrypted ? safetyCrypto().decrypt(encrypted) : 'Keine bestaetigte E-Mail.');
    } else {
        throw new Error(`Unbekannter Befehl ${command}`);
    }
} finally {
    store.close();
}
