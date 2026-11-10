// ================= MEHRERE GERAETE (Board T36, P4a) =================
// Jedes Geraet behaelt seine eigene Node-ID (`state.myProfile.id`): Router-Anmeldung, Pfad C und Signaling
// bleiben wie bisher. Die Identitaet einer Person ist die Node-ID ihres Wurzel-Geraets; eine von einem
// berechtigten Geraet signierte Geraeteliste sagt, welche Nodes dazugehoeren:
//   { identityId, version, devices: [{ nodeId, key: { x, y }, canAdd, addedAt }], updatedBy, updatedAt } + sig
// Koppeln: ein berechtigtes Geraet erzeugt einen Code (Umzugs-Relay, transfer.js) mit Daten-Buendel und einer
// Einladung; das neue Geraet uebernimmt die Daten OHNE die IDs umzuschreiben und meldet sich mit DEVICE_JOIN.
// Das einladende Geraet nimmt es in die Liste auf und verteilt sie (DEVICE_LIST) an alle eigenen Geraete.
// Spiegeln eigener Nachrichten (P4b), Kontakte an alle Geraete (P4c) und Grid (P4d) folgen.
const DEVICE_LIST_RECORD_ID = 'device-list';
const DEVICE_PAIRING_RECORD_ID = 'device-pairing';
const DEVICE_INVITE_TTL_MS = 15 * 60 * 1000;
const DEVICE_MAX = 8;

// ----- Reine Hilfen (test/devices.test.js) -----
function deviceListSignable(list) {
    return {
        identityId: list.identityId, version: list.version,
        devices: list.devices.map(device => ({ nodeId: device.nodeId, key: { x: device.key.x, y: device.key.y }, canAdd: device.canAdd === true, addedAt: device.addedAt })),
        updatedBy: list.updatedBy, updatedAt: list.updatedAt
    };
}

function isValidDeviceList(list) {
    return Boolean(list) && typeof list.identityId === 'string' && Number.isInteger(list.version) && list.version >= 1
        && Array.isArray(list.devices) && list.devices.length >= 1 && list.devices.length <= DEVICE_MAX
        && list.devices.every(device => typeof device?.nodeId === 'string' && typeof device.key?.x === 'string' && typeof device.key?.y === 'string')
        && new Set(list.devices.map(device => device.nodeId)).size === list.devices.length
        && list.devices.some(device => device.nodeId === list.identityId)
        && list.devices.some(device => device.nodeId === list.updatedBy && device.canAdd === true)
        && Number.isFinite(list.updatedAt);
}

// Eingehende Liste fuer meine Identitaet bewerten: 'accept' oder null.
// Bekannte Liste: Unterzeichner muss darin Geraete hinzufuegen duerfen, Version hoeher.
// Noch keine (frisch gekoppelt): nur vom einladenden Geraet und nur, wenn ich darin stehe.
function judgeDeviceList(next, current, { senderId, myNodeId, pairing = null }) {
    if (!isValidDeviceList(next) || next.updatedBy !== senderId) return null;
    if (current) {
        if (next.identityId !== current.identityId || next.version <= current.version) return null;
        const signer = current.devices.find(device => device.nodeId === senderId);
        if (!signer?.canAdd) return null;
        return 'accept';
    }
    if (!pairing || next.identityId !== pairing.identityId || senderId !== pairing.inviter) return null;
    return next.devices.some(device => device.nodeId === myNodeId) ? 'accept' : null;
}

// ----- Zustand -----
function myDeviceList() {
    return state.myDevices?.list || null;
}

function myIdentityId() {
    return myDeviceList()?.identityId || state.myProfile?.id || null;
}

function myNodeIds() {
    const list = myDeviceList();
    return list ? list.devices.map(device => device.nodeId) : [state.myProfile?.id].filter(Boolean);
}

// Gehoert die Node zu mir (dieses oder ein anderes eigenes Geraet)?
function isOwnNode(nodeId) {
    if (!nodeId) return false;
    if (nodeId === state.myProfile?.id) return true;
    return Boolean(myDeviceList()?.devices.some(device => device.nodeId === nodeId));
}

function canAddDevices() {
    const list = myDeviceList();
    if (!list) return true;
    return Boolean(list.devices.find(device => device.nodeId === state.myProfile.id)?.canAdd);
}

async function loadDevices() {
    const [record, pairing] = await Promise.all([DEVICE_LIST_RECORD_ID, DEVICE_PAIRING_RECORD_ID]
        .map(id => databaseRequest('keys', 'readonly', store => store.get(id)).catch(() => null)));
    state.myDevices = record?.list && isValidDeviceList(record.list) ? { list: record.list, sig: record.sig } : null;
    state.devicePairing = pairing || null;
    renderDevicesCard();
}

async function saveDeviceList(list, sig) {
    state.myDevices = { list, sig };
    await putDatabaseRecord('keys', { id: DEVICE_LIST_RECORD_ID, list, sig });
    renderDevicesCard();
}

function ownDeviceKey() {
    const jwk = state.myKeys?.jwkEcdsaPublic;
    return { x: jwk?.x, y: jwk?.y };
}

async function signDeviceList(list) {
    const signable = deviceListSignable({ ...list, updatedBy: state.myProfile.id, updatedAt: Date.now() });
    if (!isValidDeviceList(signable)) throw new Error('Invalid device list');
    return { list: signable, sig: await signOperation(signable, state.myKeys.ecdsaKeyPair.privateKey) };
}

// Erstes Koppeln: dieses Geraet wird Wurzel der Identitaet.
async function ensureRootDeviceList() {
    if (myDeviceList()) return myDeviceList();
    const signed = await signDeviceList({
        identityId: state.myProfile.id, version: 1,
        devices: [{ nodeId: state.myProfile.id, key: ownDeviceKey(), canAdd: true, addedAt: Date.now() }]
    });
    await saveDeviceList(signed.list, signed.sig);
    return signed.list;
}

async function publishDeviceList(next) {
    const signed = await signDeviceList(next);
    await saveDeviceList(signed.list, signed.sig);
    const others = signed.list.devices.map(device => device.nodeId).filter(id => id !== state.myProfile.id);
    await Promise.all(others.map(nodeId => sendSecurePayload(nodeId, { type: 'DEVICE_LIST', list: signed.list, sig: signed.sig }, () => {})
        .catch(logBackgroundError('publishDeviceList'))));
    return signed.list;
}

// ----- Koppeln: einladendes Geraet -----
async function createDeviceInvite() {
    if (!canAddDevices()) throw new Error('not-allowed');
    const list = await ensureRootDeviceList();
    if (list.devices.length >= DEVICE_MAX) throw new Error('too-many');
    const invite = { identityId: list.identityId, inviteId: window.crypto.randomUUID(), inviter: state.myProfile.id, expiresAt: Date.now() + DEVICE_INVITE_TTL_MS };
    const invites = (state.deviceInvites || []).filter(entry => entry.expiresAt > Date.now());
    state.deviceInvites = [...invites, invite];
    await putDatabaseRecord('keys', { id: 'device-invites', invites: state.deviceInvites });
    return invite;
}

// Buendel fuer das neue Geraet: Daten wie beim Umzug, aber ohne Router-Token und ohne Umzugs-Vollmacht.
async function collectPairingBundle() {
    const invite = await createDeviceInvite();
    const bundle = await collectTransferBundle();
    delete bundle.move;
    delete bundle.routerToken;
    bundle.pair = { invite, deviceList: state.myDevices.list, deviceListSig: state.myDevices.sig };
    return bundle;
}

async function createPairingRelay() {
    const raw = window.crypto.getRandomValues(new Uint8Array(32));
    const key = await window.crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
    const sealed = await sealTransferBundle(await collectPairingBundle(), key);
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

async function handleDeviceJoin(peerId, payload) {
    const invites = state.deviceInvites || (await databaseRequest('keys', 'readonly', store => store.get('device-invites')).catch(() => null))?.invites || [];
    const invite = invites.find(entry => entry.inviteId === payload.inviteId && entry.expiresAt > Date.now());
    const list = myDeviceList();
    if (!invite || !list || payload.nodeId !== peerId || invite.identityId !== list.identityId || !canAddDevices()) return false;
    // Der angemeldete Schluessel muss der sein, mit dem dieses Geraet wirklich spricht (gepinnt beim Verbinden).
    const pinned = (await getPeerIdentity(peerId).catch(() => null))?.profileSigningKey;
    if (pinned && (pinned.x !== payload.key?.x || pinned.y !== payload.key?.y)) return false;
    state.deviceInvites = invites.filter(entry => entry.inviteId !== invite.inviteId);
    await putDatabaseRecord('keys', { id: 'device-invites', invites: state.deviceInvites });
    if (list.devices.some(device => device.nodeId === peerId)) return true;
    await publishDeviceList({ ...list, version: list.version + 1, devices: [...list.devices, { nodeId: peerId, key: { x: payload.key.x, y: payload.key.y }, canAdd: false, addedAt: Date.now() }] });
    showToast(t('devices.added'), 'success');
    return true;
}

// ----- Koppeln: neues Geraet -----
function isPairingBundle(bundle) {
    return Boolean(bundle?.pair?.invite?.inviteId && bundle.pair.deviceList);
}

// Daten uebernehmen, ohne IDs umzuschreiben: alte eigene Nachrichten tragen die Node-ID des anderen Geraets
// und gelten ueber die Geraeteliste als eigene.
async function applyPairingBundle(bundle) {
    if (!validTransferBundle(bundle) || !isPairingBundle(bundle)) throw new Error('format');
    if (!state.storageKey) throw new Error('storage');
    for (const storeName of TRANSFER_STORES) {
        const records = Array.isArray(bundle.stores[storeName]) ? bundle.stores[storeName] : [];
        if (storeName !== 'keys') await clearDatabaseStore(storeName);
        for (const record of records) {
            if (storeName === 'keys' && TRANSFER_SKIPPED_KEYS.includes(record?.id)) continue;
            await putDatabaseRecord(storeName, await resealTransferRecord(storeName, record));
        }
    }
    const own = bundle.stores.localProfile?.find(record => record?.slot === 'current')?.__plain;
    if (own) {
        // Gleiches Profil, aber diese Node-ID (eigene Schluessel, eigene Router-Anmeldung).
        own.id = state.nodeId;
        own.version = (Number(own.version) || 1) + 1;
        own.updatedAt = Date.now();
        state.myProfile = own;
        await cacheOwnProfile();
    }
    for (const [key, value] of Object.entries(bundle.local || {})) {
        if (transferKeepsLocalKey(key) && typeof value === 'string') window.localStorage.setItem(key, value);
    }
    // Das einladende Geraet als bekannte Gegenstelle (fuer P2P und Pfad C).
    if (bundle.publicKeys?.jwkPublic) await persistPeerIdentityKey(bundle.pair.invite.inviter, bundle.publicKeys.jwkPublic, bundle.publicKeys.jwkEcdsaPublic);
    await putDatabaseRecord('keys', { id: DEVICE_PAIRING_RECORD_ID, ...bundle.pair.invite, joinedAt: null });
    await putDatabaseRecord('keys', { id: DEVICE_LIST_RECORD_ID, list: bundle.pair.deviceList, sig: bundle.pair.deviceListSig });
    return { identityId: bundle.pair.invite.identityId };
}

// Nach dem Start: beim einladenden Geraet melden, bis die Liste mich enthaelt.
async function finishDevicePairing() {
    const pairing = state.devicePairing;
    if (!pairing || pairing.joinedAt || myDeviceList()?.devices.some(device => device.nodeId === state.myProfile.id)) return;
    await sendSecurePayload(pairing.inviter, {
        type: 'DEVICE_JOIN', identityId: pairing.identityId, inviteId: pairing.inviteId,
        nodeId: state.myProfile.id, key: ownDeviceKey()
    }, () => {});
}

async function handleDeviceList(peerId, payload) {
    const verdict = judgeDeviceList(payload.list, myDeviceList(), { senderId: peerId, myNodeId: state.myProfile.id, pairing: state.devicePairing });
    // Erstes Mal nach dem Koppeln: die mitgebrachte Liste gilt noch nicht als "aktuell" fuer mich.
    const freshlyPaired = state.devicePairing && !state.devicePairing.joinedAt;
    const verdictPaired = freshlyPaired ? judgeDeviceList(payload.list, null, { senderId: peerId, myNodeId: state.myProfile.id, pairing: state.devicePairing }) : null;
    if (!verdict && !verdictPaired) {
        logDebug(`Ignored a device list from ${peerId}.`);
        return false;
    }
    const signerKey = payload.list.devices.find(device => device.nodeId === peerId)?.key;
    const jwk = signerKey ? { kty: 'EC', crv: 'P-256', x: signerKey.x, y: signerKey.y } : null;
    if (!jwk || !await verifyOperationSignature({ ...deviceListSignable(payload.list), sig: payload.sig }, jwk)) return false;
    await saveDeviceList(deviceListSignable(payload.list), payload.sig);
    if (freshlyPaired) {
        state.devicePairing = { ...state.devicePairing, joinedAt: Date.now() };
        await putDatabaseRecord('keys', { id: DEVICE_PAIRING_RECORD_ID, ...state.devicePairing });
        showToast(t('devices.paired'), 'success');
    }
    if (typeof renderChatHistory === 'function' && state.activeChatPeerId) renderChatHistory();
    return true;
}

// ----- Oberflaeche (Einstellungen > Geraete) -----
function renderDevicesCard() {
    const list = document.getElementById('devices-list');
    if (!list) return;
    const devices = myDeviceList()?.devices || [{ nodeId: state.myProfile?.id, canAdd: true }];
    list.replaceChildren(...devices.map(device => {
        const row = document.createElement('div');
        row.className = 'flex items-center gap-2 text-sm text-slate-200';
        row.dataset.deviceNode = device.nodeId;
        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-mobile-screen text-slate-400';
        const name = document.createElement('span');
        name.className = 'flex-1 min-w-0 truncate font-mono text-xs';
        name.textContent = `${device.nodeId === state.myProfile?.id ? `${t('devices.thisDevice')} · ` : ''}${String(device.nodeId).slice(-8)}`;
        row.append(icon, name);
        if (device.canAdd) {
            const badge = document.createElement('span');
            badge.className = 'text-[11px] text-brand-300';
            badge.textContent = t('devices.canAdd');
            row.appendChild(badge);
        }
        return row;
    }));
    document.getElementById('devices-add-btn')?.classList.toggle('hidden', !canAddDevices());
}

function openDevicePairing() {
    const content = openMediaModal(t('devices.addTitle'));
    const box = document.createElement('div');
    box.className = 'space-y-3';
    const note = document.createElement('p');
    note.className = 'text-sm text-slate-400';
    note.textContent = t('devices.addIntro');
    const error = document.createElement('p');
    error.className = 'hidden text-xs text-red-300';
    const button = document.createElement('button');
    button.type = 'button';
    button.id = 'devices-code-btn';
    button.className = 'w-full rounded-full bg-brand-600 hover:bg-brand-500 px-4 py-2.5 text-sm font-semibold text-white';
    button.textContent = t('devices.createCode');
    const result = document.createElement('div');
    result.id = 'devices-code-result';
    result.className = 'hidden space-y-2';
    button.onclick = async () => {
        button.disabled = true;
        error.classList.add('hidden');
        try {
            const { code, expiresAt } = await createPairingRelay();
            renderTransferCode(result, code, expiresAt);
            button.classList.add('hidden');
        } catch (failure) {
            error.textContent = failure.message === 'too-large' ? t('transfer.tooLargeForCode') : t('devices.codeFailed');
            error.classList.remove('hidden');
            button.disabled = false;
        }
    };
    box.append(note, error, button, result);
    content.appendChild(box);
}
