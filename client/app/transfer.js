// ================= UMZUG AUF EIN ANDERES GERAET (Board T31) =================
// Die alte Kopie (z. B. Safari-Tab) packt alle lokalen Daten in ein Buendel: Profil, Chats, Kontakte, Alben,
// Medien, Status und Einstellungen. Was mit dem Speicherschluessel versiegelt ist, wird dafuer entsiegelt
// und auf dem neuen Geraet mit dessen eigenem Schluessel neu versiegelt. Nicht mit kommen: Identitaets- und
// Speicherschluessel (non-extractable CryptoKeys, by design), Router-Zugangsdaten und Sitzungsschluessel.
// Das neue Geraet behaelt seine eigene Node-ID; im Buendel wird die alte ID ueberall durch die neue ersetzt.
// Den Kontakten kuendigt ein signierter Umzug die neue ID an (Phase 3).
//
// Transportwege: verschluesselte Datei (Schluessel aus Passwort, PBKDF2) oder Router-Relay (Phase 2).
const TRANSFER_FORMAT = 'opengrid-transfer';
const TRANSFER_VERSION = 1;
const TRANSFER_FILE_FORMAT = 'opengrid-transfer-file';
const TRANSFER_PBKDF2_ITERATIONS = 600000;
const TRANSFER_MIN_PASSWORD = 8;
// Gridcache ist fluechtig und kommt nicht mit.
const TRANSFER_STORES = ['localProfile', 'profiles', 'messages', 'chatOperations', 'keys', 'media', 'albums', 'statusUpdates'];
// Versiegelt mit dem Speicherschluessel: ganzer Datensatz (ciphertext + iv oben) bzw. Feld `sealed`.
const TRANSFER_TOP_SEALED_STORES = ['localProfile', 'profiles', 'media'];
const TRANSFER_FIELD_SEALED_STORES = ['albums', 'statusUpdates'];
// Geraetegebunden: eigene Schluessel, Zugang zum Router, zwischengespeicherte Router-Konfiguration.
const TRANSFER_SKIPPED_KEYS = ['identity-key', 'profile-cache', 'router-auth', 'app-config', 'transfer-imported'];
const TRANSFER_SKIPPED_LOCAL = ['opengrid-node-id', 'opengrid-router-auth-token'];
const TRANSFER_EXTRA_LOCAL = ['appliedChatWipes', 'hiddenByPeers'];

// ----- Reine Hilfen (test/transfer.test.js) -----
function isCryptoKeyValue(value) {
    return typeof CryptoKey !== 'undefined' ? value instanceof CryptoKey : value?.constructor?.name === 'CryptoKey';
}

function containsCryptoKey(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 6) return false;
    if (isCryptoKeyValue(value)) return true;
    return Object.values(value).some(entry => containsCryptoKey(entry, depth + 1));
}

function transferKeepsKeyRecord(record) {
    if (!record || TRANSFER_SKIPPED_KEYS.includes(record.id)) return false;
    return !containsCryptoKey(record);
}

function transferKeepsLocalKey(key) {
    if (TRANSFER_SKIPPED_LOCAL.includes(key)) return false;
    return key.startsWith('opengrid-') || TRANSFER_EXTRA_LOCAL.includes(key);
}

// Alte Node-ID ueberall (Werte und Schluessel, auch in zusammengesetzten IDs) durch die neue ersetzen.
function rewriteTransferIds(value, oldId, newId) {
    if (!oldId || !newId || oldId === newId) return value;
    return JSON.parse(JSON.stringify(value).split(oldId).join(newId));
}

function validTransferBundle(bundle) {
    return Boolean(bundle) && bundle.format === TRANSFER_FORMAT && bundle.version === TRANSFER_VERSION
        && typeof bundle.nodeId === 'string' && bundle.nodeId.length > 0
        && bundle.stores && typeof bundle.stores === 'object';
}

// ----- Packen (alte Kopie) -----
async function unsealTransferRecord(storeName, record) {
    if (TRANSFER_TOP_SEALED_STORES.includes(storeName) && record?.ciphertext && record?.iv) {
        const { ciphertext, iv, ...meta } = record;
        const plain = await decryptStoredProfile({ ciphertext, iv }).catch(() => null);
        return plain === null ? null : { ...meta, __plain: plain };
    }
    if (TRANSFER_FIELD_SEALED_STORES.includes(storeName) && record?.sealed) {
        const { sealed, ...meta } = record;
        const plain = await decryptStoredProfile(sealed).catch(() => null);
        return plain === null ? null : { ...meta, __plain: plain };
    }
    return record;
}

async function collectTransferBundle() {
    const stores = {};
    let skipped = 0;
    for (const storeName of TRANSFER_STORES) {
        const records = await getAllDatabaseRecords(storeName).catch(() => []);
        const kept = [];
        for (const record of records) {
            if (storeName === 'keys' && !transferKeepsKeyRecord(record)) continue;
            const value = await unsealTransferRecord(storeName, record);
            if (value === null) skipped += 1;
            else kept.push(value);
        }
        stores[storeName] = kept;
    }
    const local = {};
    for (let index = 0; index < window.localStorage.length; index += 1) {
        const key = window.localStorage.key(index);
        if (key && transferKeepsLocalKey(key)) local[key] = window.localStorage.getItem(key);
    }
    return {
        format: TRANSFER_FORMAT,
        version: TRANSFER_VERSION,
        createdAt: Date.now(),
        nodeId: state.myProfile.id,
        publicKeys: { jwkPublic: state.myKeys?.jwkPublic || null, jwkEcdsaPublic: state.myKeys?.jwkEcdsaPublic || null },
        skipped,
        stores,
        local,
        // Vollmacht fuer den signierten Umzug (move.js) und eigene Sperren (beim Router unter der alten ID).
        move: typeof createMoveDelegation === 'function' ? await createMoveDelegation() : null,
        blocked: typeof blockedPeerIds === 'function' ? blockedPeerIds() : []
    };
}

// ----- Verschluesseln (gzip, wenn der Browser es kann) -----
async function gzipBytes(bytes) {
    if (typeof CompressionStream === 'undefined') return null;
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipBytes(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function sealTransferBundle(bundle, key) {
    const plain = new TextEncoder().encode(JSON.stringify(bundle));
    const zipped = await gzipBytes(plain);
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, zipped || plain);
    return { gzip: Boolean(zipped), iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(ciphertext)) };
}

async function openTransferBundle(sealed, key) {
    const plain = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(sealed.iv) }, key, base64ToBytes(sealed.ciphertext));
    const bytes = sealed.gzip ? await gunzipBytes(new Uint8Array(plain)) : new Uint8Array(plain);
    return JSON.parse(new TextDecoder().decode(bytes));
}

async function transferKeyFromPassword(password, salt, iterations = TRANSFER_PBKDF2_ITERATIONS) {
    const material = await window.crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    return window.crypto.subtle.deriveKey(
        { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
        material,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

// ----- Datei -----
async function createTransferFile(password) {
    const salt = window.crypto.getRandomValues(new Uint8Array(16));
    const key = await transferKeyFromPassword(password, salt);
    const bundle = await collectTransferBundle();
    const sealed = await sealTransferBundle(bundle, key);
    const file = {
        format: TRANSFER_FILE_FORMAT,
        version: TRANSFER_VERSION,
        kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: TRANSFER_PBKDF2_ITERATIONS, salt: bytesToBase64(salt) },
        ...sealed
    };
    return { blob: new Blob([JSON.stringify(file)], { type: 'application/octet-stream' }), skipped: bundle.skipped };
}

async function readTransferFile(file, password) {
    let parsed;
    try {
        parsed = JSON.parse(await file.text());
    } catch {
        throw new Error('format');
    }
    if (parsed?.format !== TRANSFER_FILE_FORMAT || parsed.kdf?.name !== 'PBKDF2') throw new Error('format');
    const iterations = Math.min(Math.max(Number(parsed.kdf.iterations) || 0, 100000), 5000000);
    const key = await transferKeyFromPassword(password, base64ToBytes(parsed.kdf.salt), iterations);
    let bundle;
    try {
        bundle = await openTransferBundle(parsed, key);
    } catch {
        throw new Error('password');
    }
    if (!validTransferBundle(bundle)) throw new Error('format');
    return bundle;
}

// ----- Relay ueber den Router (Code/QR) -----
// Code = <Transfer-ID>.<Schluessel>, beide base64url. Der Schluessel geht nie an den Router: er steht nur im
// Code bzw. im Fragment der Link-Adresse (/transfer#<code>), das Browser nicht mitschicken.
const TRANSFER_CODE_PATTERN = /([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})/;

function toBase64Url(bytes) {
    return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text) {
    const padded = text.replace(/-/g, '+').replace(/_/g, '/');
    return base64ToBytes(padded + '='.repeat((4 - (padded.length % 4)) % 4));
}

function parseTransferCode(input) {
    const match = String(input || '').match(TRANSFER_CODE_PATTERN);
    return match ? { id: match[1], key: fromBase64Url(match[2]) } : null;
}

function transferLink(code) {
    return `${window.location.origin}/transfer#${code}`;
}

async function createTransferRelay() {
    const raw = window.crypto.getRandomValues(new Uint8Array(32));
    const key = await window.crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
    const bundle = await collectTransferBundle();
    const sealed = await sealTransferBundle(bundle, key);
    const response = await fetch(`${API_BASE}/api/transfer`, {
        method: 'POST',
        headers: peerAuthHeaders({ 'Content-Type': 'application/octet-stream', 'X-Peer-Id': state.myProfile.id }),
        body: JSON.stringify(sealed)
    });
    if (response.status === 413) throw new Error('too-large');
    if (!response.ok) throw new Error(`relay ${response.status}`);
    const { id, expiresAt } = await response.json();
    return { code: `${id}.${toBase64Url(raw)}`, expiresAt };
}

async function readTransferCode(input) {
    const parsed = parseTransferCode(input);
    if (!parsed) throw new Error('code');
    const response = await fetch(`${API_BASE}/api/transfer/${parsed.id}`, { cache: 'no-store' });
    if (response.status === 404) throw new Error('gone');
    if (!response.ok) throw new Error(`relay ${response.status}`);
    const key = await window.crypto.subtle.importKey('raw', parsed.key, 'AES-GCM', false, ['decrypt']);
    let bundle;
    try {
        bundle = await openTransferBundle(JSON.parse(await response.text()), key);
    } catch {
        throw new Error('code');
    }
    if (!validTransferBundle(bundle)) throw new Error('format');
    return bundle;
}

// ----- Einspielen (neues Geraet) -----
async function resealTransferRecord(storeName, record) {
    if (!record || !Object.prototype.hasOwnProperty.call(record, '__plain')) return record;
    const { __plain: plain, ...meta } = record;
    const sealed = await encryptStoredProfile(plain);
    return TRANSFER_TOP_SEALED_STORES.includes(storeName) ? { ...meta, ...sealed } : { ...meta, sealed };
}

function clearDatabaseStore(storeName) {
    if (!db) return Promise.resolve();
    return databaseRequest(storeName, 'readwrite', store => store.clear());
}

async function applyTransferBundle(bundle) {
    if (!validTransferBundle(bundle)) throw new Error('format');
    if (!state.storageKey) throw new Error('storage');
    const newId = state.nodeId;
    const oldId = bundle.nodeId;
    const stores = rewriteTransferIds(bundle.stores, oldId, newId);
    const local = rewriteTransferIds(bundle.local || {}, oldId, newId);
    for (const storeName of TRANSFER_STORES) {
        const records = Array.isArray(stores[storeName]) ? stores[storeName] : [];
        // Der Schluessel-Store behaelt die eigenen Schluessel dieses Geraets; alles andere wird ersetzt.
        if (storeName !== 'keys') await clearDatabaseStore(storeName);
        for (const record of records) {
            if (storeName === 'keys' && TRANSFER_SKIPPED_KEYS.includes(record?.id)) continue;
            await putDatabaseRecord(storeName, await resealTransferRecord(storeName, record));
        }
    }
    // Eigenes Profil: neue Version, damit es mit dem neuen Schluessel neu signiert und verteilt wird.
    const own = stores.localProfile?.find(record => record?.slot === 'current')?.__plain;
    if (own) {
        own.version = (Number(own.version) || 1) + 1;
        own.updatedAt = Date.now();
        state.myProfile = own;
        await cacheOwnProfile();
    }
    for (const [key, value] of Object.entries(local)) {
        if (transferKeepsLocalKey(key) && typeof value === 'string') window.localStorage.setItem(key, value);
    }
    // Fuer den signierten Umzug (Phase 3): woher die Daten kamen.
    await putDatabaseRecord('keys', {
        id: 'transfer-imported',
        from: oldId,
        publicKeys: bundle.publicKeys || null,
        move: bundle.move || null,
        blocked: Array.isArray(bundle.blocked) ? bundle.blocked.filter(id => typeof id === 'string') : [],
        at: Date.now()
    });
    return { oldId, newId };
}

// ----- Oberflaeche -----
function transferPasswordField(id, labelText) {
    const label = document.createElement('label');
    label.className = 'block space-y-1';
    const text = document.createElement('span');
    text.className = 'text-xs font-semibold text-slate-400';
    text.textContent = labelText;
    const input = document.createElement('input');
    input.type = 'password';
    input.id = id;
    input.autocomplete = 'new-password';
    input.className = 'w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-base text-slate-100 focus:outline-hidden focus:border-brand-500';
    label.append(text, input);
    return label;
}

function transferNote(text, tone = 'slate') {
    const note = document.createElement('p');
    note.className = tone === 'amber'
        ? 'text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg p-3'
        : 'text-xs text-slate-400';
    note.textContent = text;
    return note;
}

function transferButton(id, text) {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = id;
    button.className = 'w-full rounded-full bg-brand-600 hover:bg-brand-500 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50';
    button.textContent = text;
    return button;
}

function transferError(output, text) {
    output.textContent = text;
    output.classList.toggle('hidden', !text);
}

function openTransferExport() {
    const content = openMediaModal(t('transfer.exportTitle'));
    const box = document.createElement('div');
    box.className = 'space-y-4';
    box.append(transferNote(t('transfer.exportIntro')));

    // Weg 1: Code/QR ueber den Router (Standard).
    const relay = document.createElement('div');
    relay.className = 'space-y-2 rounded-xl border border-slate-800 p-3';
    const relayTitle = document.createElement('h4');
    relayTitle.className = 'text-sm font-semibold text-slate-200';
    relayTitle.textContent = t('transfer.viaCode');
    const relayError = document.createElement('p');
    relayError.className = 'hidden text-xs text-red-300';
    const relayButton = transferButton('transfer-code-btn', t('transfer.createCode'));
    const result = document.createElement('div');
    result.id = 'transfer-code-result';
    result.className = 'hidden space-y-2';
    relay.append(relayTitle, transferNote(t('transfer.codeIntro')), relayError, relayButton, result);
    relayButton.onclick = async () => {
        transferError(relayError, '');
        relayButton.disabled = true;
        relayButton.textContent = t('transfer.working');
        try {
            const { code, expiresAt } = await createTransferRelay();
            renderTransferCode(result, code, expiresAt);
            relayButton.classList.add('hidden');
        } catch (failure) {
            logDebug(`Transfer relay failed: ${failure.message}`);
            transferError(relayError, failure.message === 'too-large' ? t('transfer.tooLargeForCode') : t('transfer.exportFailed'));
            relayButton.disabled = false;
            relayButton.textContent = t('transfer.createCode');
        }
    };

    // Weg 2: Datei mit Passwort (ohne Router).
    const fileBox = document.createElement('div');
    fileBox.className = 'space-y-2 rounded-xl border border-slate-800 p-3';
    const fileTitle = document.createElement('h4');
    fileTitle.className = 'text-sm font-semibold text-slate-200';
    fileTitle.textContent = t('transfer.viaFile');
    const error = document.createElement('p');
    error.id = 'transfer-export-error';
    error.className = 'hidden text-xs text-red-300';
    const button = transferButton('transfer-export-btn', t('transfer.createFile'));
    fileBox.append(
        fileTitle,
        transferPasswordField('transfer-export-password', t('transfer.password')),
        transferPasswordField('transfer-export-password-repeat', t('transfer.passwordRepeat')),
        transferNote(t('transfer.exportWarning'), 'amber'),
        error,
        button
    );
    box.append(relay, fileBox);
    content.append(box);
    button.onclick = async () => {
        const password = document.getElementById('transfer-export-password').value;
        if (password.length < TRANSFER_MIN_PASSWORD) return transferError(error, t('transfer.passwordTooShort', { count: TRANSFER_MIN_PASSWORD }));
        if (password !== document.getElementById('transfer-export-password-repeat').value) return transferError(error, t('transfer.passwordsDiffer'));
        transferError(error, '');
        button.disabled = true;
        button.textContent = t('transfer.working');
        try {
            const { blob, skipped } = await createTransferFile(password);
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = `opengrid-${new Date().toISOString().slice(0, 10)}.opengrid`;
            document.body.append(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(link.href), 60000);
            if (skipped) logDebug(`Transfer export skipped ${skipped} unreadable record(s).`);
            showToast(t('transfer.fileCreated'), 'success');
            closeMediaModal();
        } catch (failure) {
            logDebug(`Transfer export failed: ${failure.message}`);
            transferError(error, t('transfer.exportFailed'));
            button.disabled = false;
            button.textContent = t('transfer.createFile');
        }
    };
}

// Code zum Kopieren (gleiches Geraet, z. B. Safari-Tab -> App) und QR mit Link (anderes Geraet).
function renderTransferCode(container, code, expiresAt) {
    const input = document.createElement('input');
    input.id = 'transfer-code-output';
    input.readOnly = true;
    input.value = code;
    input.className = 'w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-100';
    const copy = transferButton('transfer-code-copy', t('transfer.copyCode'));
    copy.onclick = async () => {
        try {
            await navigator.clipboard.writeText(code);
            showToast(t('transfer.codeCopied'), 'success');
        } catch {
            input.select();
            showToast(t('common.copyingIsNotPossible'), 'error');
        }
    };
    const valid = transferNote(t('transfer.codeValid', { time: new Date(expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }));
    container.replaceChildren(input, copy, valid);
    if (typeof qrcode === 'function') {
        const qr = qrcode(0, 'M');
        qr.addData(transferLink(code));
        qr.make();
        const image = document.createElement('img');
        image.id = 'transfer-code-qr';
        image.alt = t('transfer.qrAlt');
        image.src = qr.createDataURL(4, 2);
        image.className = 'mx-auto rounded-lg bg-white p-2';
        container.append(image, transferNote(t('transfer.qrHint')));
    }
    container.classList.remove('hidden');
}

function openTransferImport(prefilledCode = '') {
    const content = openMediaModal(t('transfer.importTitle'));
    const box = document.createElement('div');
    box.className = 'space-y-3';
    const fileLabel = document.createElement('label');
    fileLabel.className = 'block space-y-1';
    const fileText = document.createElement('span');
    fileText.className = 'text-xs font-semibold text-slate-400';
    fileText.textContent = t('transfer.file');
    const file = document.createElement('input');
    file.type = 'file';
    file.id = 'transfer-import-file';
    file.className = 'block w-full text-sm text-slate-300';
    fileLabel.append(fileText, file);
    const password = transferPasswordField('transfer-import-password', t('transfer.password'));
    password.querySelector('input').autocomplete = 'current-password';
    const error = document.createElement('p');
    error.id = 'transfer-import-error';
    error.className = 'hidden text-xs text-red-300';
    const button = transferButton('transfer-import-btn', t('transfer.importNow'));
    const codeLabel = document.createElement('label');
    codeLabel.className = 'block space-y-1';
    const codeText = document.createElement('span');
    codeText.className = 'text-xs font-semibold text-slate-400';
    codeText.textContent = t('transfer.code');
    const code = document.createElement('input');
    code.id = 'transfer-import-code';
    code.autocomplete = 'off';
    code.placeholder = t('transfer.codePlaceholder');
    code.value = prefilledCode || '';
    code.className = 'w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-base font-mono text-slate-100 focus:outline-hidden focus:border-brand-500';
    codeLabel.append(codeText, code);
    const or = document.createElement('p');
    or.className = 'text-center text-xs text-slate-500';
    or.textContent = t('transfer.orFile');
    box.append(transferNote(t('transfer.importIntro')), codeLabel, or, fileLabel, password, error, button);
    content.append(box);
    button.onclick = async () => {
        const chosen = file.files?.[0];
        const codeValue = code.value.trim();
        if (!codeValue && !chosen) return transferError(error, t('transfer.chooseFile'));
        transferError(error, '');
        button.disabled = true;
        button.textContent = t('transfer.working');
        try {
            const bundle = codeValue
                ? await readTransferCode(codeValue)
                : await readTransferFile(chosen, document.getElementById('transfer-import-password').value);
            if (bundle.nodeId === state.nodeId) throw new Error('same');
            await applyTransferBundle(bundle);
            showToast(t('transfer.imported'), 'success');
            // Sauber neu starten: alles wird aus dem uebernommenen Speicher geladen.
            setTimeout(() => window.location.reload(), 600);
        } catch (failure) {
            logDebug(`Transfer import failed: ${failure.message}`);
            const messages = {
                password: t('transfer.wrongPassword'),
                format: t('transfer.notATransferFile'),
                code: t('transfer.invalidCode'),
                gone: t('transfer.codeGone'),
                same: t('transfer.sameDevice')
            };
            transferError(error, messages[failure.message] || t('transfer.importFailed'));
            button.disabled = false;
            button.textContent = t('transfer.importNow');
        }
    };
}
