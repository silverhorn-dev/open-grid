// ================= UNTERHALTUNGEN (Board T36, P1) =================
// Ohne Migration: in einem 1:1-Chat ist die Unterhaltungs-ID die Node-ID des Partners (wie bisher). Eine Gruppe
// hat eine eigene ID `group_<uuid>` und steht ueberall dort, wo sonst die Partner-ID steht (Verlauf, Liste,
// Operationen). Gesendet wird an alle Mitglieder (sendSecurePayload verteilt), empfangen wird ueber das Feld
// `conversationId` der Nutzlast: nur bekannte Gruppen, nur von Mitgliedern.
// Gruppen liegen im vorhandenen `keys`-Store (`group:<id>`), kein neues IndexedDB-Schema. Anlegen, Mitglieder,
// Admins und Oberflaeche folgen in P2 (documentation/GRUPPEN-MEHRGERAETE.md).
const GROUP_PREFIX = 'group_';
const GROUP_RECORD_PREFIX = 'group:';
const GROUP_MAX_MEMBERS = 16;

// ----- Reine Hilfen (test/conversations.test.js) -----
function isGroupId(id) {
    return typeof id === 'string' && /^group_[A-Za-z0-9-]{8,64}$/.test(id);
}

function newGroupId() {
    return `${GROUP_PREFIX}${window.crypto.randomUUID()}`;
}

function isValidGroup(group) {
    return Boolean(group) && isGroupId(group.id) && Array.isArray(group.members)
        && group.members.length >= 1 && group.members.length <= GROUP_MAX_MEMBERS
        && group.members.every(member => typeof member === 'string' && member.length > 0 && member.length <= 200)
        && new Set(group.members).size === group.members.length;
}

// An wen eine Nachricht der Unterhaltung geht: Gruppe = alle Mitglieder ausser mir, sonst der Partner.
function conversationRecipients(conversationId, { groups = {}, myId = null } = {}) {
    if (!isGroupId(conversationId)) return conversationId ? [conversationId] : [];
    const group = groups[conversationId];
    if (!isValidGroup(group) || (myId && !group.members.includes(myId))) return [];
    return group.members.filter(member => member !== myId);
}

// Zu welcher Unterhaltung eine eingehende Nutzlast von senderId gehoert; null = verwerfen.
function resolveIncomingConversation(senderId, conversationId, { groups = {}, myId = null } = {}) {
    if (conversationId === undefined || conversationId === null) return senderId;
    if (!isGroupId(conversationId)) return null;
    const group = groups[conversationId];
    if (!isValidGroup(group) || !group.members.includes(senderId) || (myId && !group.members.includes(myId))) return null;
    // Ausgetreten oder entfernt: nichts mehr annehmen, nichts mehr abgleichen.
    if (group.left || group.removed) return null;
    return conversationId;
}

// ----- Gruppen-Register -----
function getGroup(groupId) {
    return state.groups?.[groupId] || null;
}

async function loadGroups() {
    const records = await getAllDatabaseRecords('keys').catch(() => []);
    state.groups = Object.fromEntries(records
        .filter(record => typeof record?.id === 'string' && record.id.startsWith(GROUP_RECORD_PREFIX))
        .map(record => record.group)
        .filter(isValidGroup)
        .map(group => [group.id, group]));
}

async function saveGroup(group) {
    if (!isValidGroup(group)) throw new Error('Invalid group');
    state.groups = { ...(state.groups || {}), [group.id]: group };
    await putDatabaseRecord('keys', { id: `${GROUP_RECORD_PREFIX}${group.id}`, group });
    return group;
}

function groupRecipients(groupId) {
    return conversationRecipients(groupId, { groups: state.groups || {}, myId: state.myProfile?.id });
}

// Fan-out einer Chat-Operation an alle Mitglieder. Der Rueckruf meldet den besten Weg einmal (P2P vor Pfad C).
async function sendGroupPayload(groupId, payload, onSent = null, options = {}) {
    const recipients = groupRecipients(groupId);
    if (!recipients.length || payload?.type !== 'CHAT_OPERATION') return false;
    // Die Gruppe gehoert in die (signierte) Operation selbst, damit niemand sie in eine andere Gruppe umleiten kann.
    payload = { ...payload, operation: { ...payload.operation, conversationId: groupId } };
    const reported = new Set();
    const report = (path, details) => {
        if (!onSent || reported.has(path)) return;
        // "pending" nur melden, solange noch nichts zugestellt ist.
        if (path === 'pending' && (reported.has('p2p') || reported.has('cache'))) return;
        reported.add(path);
        onSent(path, details);
    };
    const results = await Promise.all(recipients.map(member => sendSecurePayload(member, { ...payload, conversationId: groupId }, report, options)
        .catch(error => {
            logDebug(`Group send to ${member} failed: ${error.message}`);
            return false;
        })));
    return results.some(Boolean);
}

function conversationDisplayName(conversationId) {
    if (isGroupId(conversationId)) return getGroup(conversationId)?.name || t('groups.unnamed');
    return null;
}

// ================= GRUPPEN VERWALTEN (T36 P2a) =================
// Der Zustand einer Gruppe (Name, Mitglieder, Admins, Version) wird von einem Admin signiert und als
// GROUP_STATE an alle Mitglieder (und frisch Entfernte) geschickt; P2P, sonst Pfad C. Angenommen wird ein
// Zustand nur direkt vom Unterzeichner, nur wenn er Admin ist (bei einer bekannten Gruppe: im bisherigen Stand)
// und nur mit hoeherer Version. Austreten (GROUP_LEAVE) darf jedes Mitglied fuer sich; der erste verbleibende
// Admin veroeffentlicht danach den neuen Stand. Wer ausgetreten ist, nimmt keine Zustaende dieser Gruppe mehr an.
const GROUP_NAME_MAX = 60;
const GROUP_PENDING_LIMIT = 50;

// since: ab wann ein Mitglied den Verlauf bekommt (P2b, Wahl des Admins beim Hinzufuegen).
// memberKeys: Signaturschluessel der Mitglieder ({ x, y }), damit weitergereichte Operationen auch ohne direkten
// Kontakt pruefbar sind (der Admin buergt mit seiner Signatur dafuer).
function groupSignable(group) {
    const signable = {
        id: group.id, name: group.name, members: [...group.members], admins: [...group.admins],
        createdAt: group.createdAt, version: group.version, updatedBy: group.updatedBy, updatedAt: group.updatedAt
    };
    if (group.since) signable.since = Object.fromEntries(group.members.filter(member => Number.isFinite(group.since[member])).map(member => [member, group.since[member]]));
    if (group.memberKeys) {
        signable.memberKeys = Object.fromEntries(group.members.filter(member => group.memberKeys[member]?.x && group.memberKeys[member]?.y)
            .map(member => [member, { x: group.memberKeys[member].x, y: group.memberKeys[member].y }]));
    }
    return signable;
}

function compactKey(jwk) {
    return typeof jwk?.x === 'string' && typeof jwk?.y === 'string' ? { x: jwk.x, y: jwk.y } : null;
}

async function collectMemberKeys(members, existing = {}) {
    const keys = { ...existing };
    for (const member of members) {
        const key = member === state.myProfile.id ? compactKey(state.myKeys?.jwkEcdsaPublic)
            : compactKey((await getPeerIdentity(member).catch(() => null))?.profileSigningKey) || keys[member];
        if (key) keys[member] = key;
    }
    return keys;
}

// Ab wann der Sync einem Mitglied Operationen dieser Gruppe gibt.
function groupSyncCutoff(group, memberId) {
    const since = group?.since?.[memberId];
    return Number.isFinite(since) ? since : (group?.createdAt || 0);
}

function groupMemberKey(group, actorId) {
    const key = group?.memberKeys?.[actorId];
    return key ? { kty: 'EC', crv: 'P-256', x: key.x, y: key.y } : null;
}

// Fremde Operation, die ein Mitglied im Gruppen-Sync weiterreicht: Urheber muss Mitglied sein, die Operation
// muss zur Gruppe gehoeren und gueltig vom Urheber signiert sein (gepinnter oder vom Admin bestaetigter Schluessel).
async function acceptRelayedOperation(groupId, senderId, operation) {
    const group = getGroup(groupId);
    if (!group || !isGroupActive(groupId) || !group.members.includes(senderId)) return false;
    if (operation?.conversationId !== groupId || !group.members.includes(operation.actorId) || typeof operation.sig !== 'string') return false;
    const pinned = (await getPeerIdentity(operation.actorId).catch(() => null))?.profileSigningKey;
    const key = pinned || groupMemberKey(group, operation.actorId);
    return Boolean(key) && verifyOperationSignature(operation, key);
}

function sharedActiveGroups(peerId) {
    return Object.values(state.groups || {}).filter(group => isGroupActive(group.id) && group.members.includes(peerId)).map(group => group.id);
}

function isValidGroupState(group) {
    return isValidGroup(group) && typeof group.name === 'string' && group.name.trim().length > 0 && group.name.length <= GROUP_NAME_MAX
        && (group.since === undefined || (typeof group.since === 'object' && Object.values(group.since).every(Number.isFinite)))
        && (group.memberKeys === undefined || (typeof group.memberKeys === 'object' && Object.values(group.memberKeys).every(key => typeof key?.x === 'string' && typeof key?.y === 'string')))
        && Array.isArray(group.admins) && group.admins.length >= 1 && group.admins.every(admin => group.members.includes(admin))
        && Number.isInteger(group.version) && group.version >= 1 && typeof group.updatedBy === 'string'
        && Number.isFinite(group.createdAt) && Number.isFinite(group.updatedAt);
}

// Entscheidet ueber einen eingehenden Zustand: 'accept', 'removed' (ich bin raus), oder null (verwerfen).
function judgeGroupState(next, current, { senderId, myId }) {
    if (!isValidGroupState(next) || next.updatedBy !== senderId) return null;
    if (current?.left) return null;
    if (current) {
        if (!current.admins.includes(senderId) || next.version <= current.version) return null;
    } else if (!next.admins.includes(senderId)) {
        return null;
    }
    if (!next.members.includes(myId)) return current ? 'removed' : null;
    return 'accept';
}

function isGroupAdmin(groupId, peerId = state.myProfile?.id) {
    return Boolean(getGroup(groupId)?.admins?.includes(peerId));
}

function isGroupActive(groupId) {
    const group = getGroup(groupId);
    return Boolean(group) && !group.left && !group.removed && group.members.includes(state.myProfile?.id);
}

async function publishGroupState(next, previousMembers = []) {
    const memberKeys = await collectMemberKeys(next.members, next.memberKeys || {});
    const signable = groupSignable({ ...next, memberKeys, updatedBy: state.myProfile.id, updatedAt: Date.now() });
    if (!isValidGroupState(signable)) throw new Error('Invalid group state');
    const sig = await signOperation(signable, state.myKeys.ecdsaKeyPair.privateKey);
    await saveGroup({ ...signable, sig });
    const recipients = [...new Set([...previousMembers, ...signable.members])].filter(member => member !== state.myProfile.id);
    // Leerer Rueckruf: so greift der Pfad-C-Fallback auch fuer diese Nutzlast.
    await Promise.all(recipients.map(member => sendSecurePayload(member, { type: 'GROUP_STATE', ['state']: signable, sig }, () => {})
        .catch(logBackgroundError('publishGroupState'))));
    refreshGroupViews(signable.id);
    return signable;
}

async function handleGroupState(peerId, payload) {
    const next = payload['state'];
    const current = getGroup(next?.id);
    const verdict = judgeGroupState(next, current, { senderId: peerId, myId: state.myProfile.id });
    if (!verdict) {
        logDebug(`Ignored a group state from ${peerId}.`);
        return false;
    }
    const key = (await getPeerIdentity(peerId).catch(() => null))?.profileSigningKey;
    if (key && !await verifyOperationSignature({ ...groupSignable(next), sig: payload.sig }, key)) {
        logDebug(`Ignored a group state from ${peerId} with an invalid signature.`);
        return false;
    }
    if (verdict === 'removed') {
        await saveGroup({ ...current, removed: true });
        showToast(t('groups.youWereRemoved', { name: current.name }), 'info');
        refreshGroupViews(current.id);
        return true;
    }
    await saveGroup({ ...groupSignable(next), sig: payload.sig });
    if (typeof ensureChatScope === 'function') await ensureChatScope(next.id, 'social');
    rememberChatPeer(next.id);
    if (!current) showToast(t('groups.youWereAdded', { name: next.name }), 'info');
    refreshGroupViews(next.id);
    await replayPendingGroupOperations(next.id);
    return true;
}

// Chat-Operationen fuer eine (noch) unbekannte Gruppe kurz zurueckhalten: der Zustand kann knapp danach kommen.
function stashGroupOperation(groupId, peerId, payload, deliveredVia) {
    const pending = state.pendingGroupOperations || (state.pendingGroupOperations = {});
    const list = pending[groupId] || (pending[groupId] = []);
    if (list.length < GROUP_PENDING_LIMIT) list.push({ peerId, payload, deliveredVia });
}

async function replayPendingGroupOperations(groupId) {
    const list = state.pendingGroupOperations?.[groupId];
    if (!list?.length) return;
    delete state.pendingGroupOperations[groupId];
    for (const entry of list) await handleSecurePayload(entry.peerId, entry.payload, entry.deliveredVia);
}

async function handleGroupLeave(peerId, groupId) {
    const group = getGroup(groupId);
    if (!group || !group.members.includes(peerId) || group.left) return false;
    const members = group.members.filter(member => member !== peerId);
    const admins = group.admins.filter(admin => admin !== peerId);
    // Der erste verbleibende Admin veroeffentlicht den neuen Stand; die anderen ziehen lokal nach.
    if (admins[0] === state.myProfile.id && members.length) {
        await publishGroupState({ ...group, members, admins, version: group.version + 1 }, group.members);
    } else {
        await saveGroup({ ...group, members, admins: admins.length ? admins : [members[0]].filter(Boolean) });
        refreshGroupViews(groupId);
    }
    return true;
}

// ----- Aktionen (Oberflaeche) -----
async function createGroup(name, memberIds) {
    const members = [state.myProfile.id, ...new Set(memberIds.filter(id => typeof id === 'string' && id !== state.myProfile.id))];
    if (members.length < 2 || members.length > GROUP_MAX_MEMBERS) throw new Error('group size');
    const now = Date.now();
    const group = await publishGroupState({
        id: newGroupId(), name: String(name || '').trim().slice(0, GROUP_NAME_MAX) || t('groups.unnamed'),
        members, admins: [state.myProfile.id], createdAt: now, version: 1
    });
    if (typeof setChatScope === 'function') await setChatScope(group.id, 'social');
    rememberChatPeer(group.id);
    return group;
}

async function updateGroupAsAdmin(groupId, change) {
    const group = getGroup(groupId);
    if (!group || !isGroupAdmin(groupId) || !isGroupActive(groupId)) throw new Error('not an admin');
    const next = { ...group, ...change(group), version: group.version + 1 };
    next.admins = next.admins.filter(admin => next.members.includes(admin));
    if (!next.admins.length) next.admins = [state.myProfile.id];
    return publishGroupState(next, group.members);
}

// history: 'none' = ab jetzt, 'last50' = ab der 50.-letzten Nachricht der Gruppe (Wahl des Admins).
async function addGroupMembers(groupId, ids, history = 'none') {
    let since = Date.now();
    if (history === 'last50') {
        const puts = (await getChatOperations(groupId)).filter(operation => operation.type === 'MESSAGE_PUT');
        since = puts.length >= 50 ? puts[49].createdAt : (getGroup(groupId)?.createdAt || 0);
    }
    return updateGroupAsAdmin(groupId, group => ({
        members: [...new Set([...group.members, ...ids])],
        since: { ...(group.since || {}), ...Object.fromEntries(ids.filter(id => !group.members.includes(id)).map(id => [id, since])) }
    }));
}
const removeGroupMember = (groupId, id) => updateGroupAsAdmin(groupId, group => ({ members: group.members.filter(member => member !== id) }));
const makeGroupAdmin = (groupId, id) => updateGroupAsAdmin(groupId, group => ({ admins: [...new Set([...group.admins, id])] }));
const renameGroup = (groupId, name) => updateGroupAsAdmin(groupId, () => ({ name: String(name || '').trim().slice(0, GROUP_NAME_MAX) }));

async function leaveGroup(groupId) {
    const group = getGroup(groupId);
    if (!group || !isGroupActive(groupId)) return false;
    const others = group.members.filter(member => member !== state.myProfile.id);
    // Einziger Admin: vorher ein anderes Mitglied zum Admin machen und den Stand ohne mich veroeffentlichen.
    if (group.admins.length === 1 && group.admins[0] === state.myProfile.id && others.length) {
        await publishGroupState({ ...group, members: others, admins: [others[0]], version: group.version + 1 }, group.members);
    } else {
        await Promise.all(others.map(member => sendSecurePayload(member, { type: 'GROUP_LEAVE', groupId }, () => {})
            .catch(logBackgroundError('leaveGroup'))));
    }
    await saveGroup({ ...getGroup(groupId), left: true });
    refreshGroupViews(groupId);
    return true;
}

// ----- Darstellung -----
const GROUP_COLORS = ['#7c3aed', '#db2777', '#0891b2', '#16a34a', '#ea580c', '#2563eb'];

function groupAvatar(group) {
    const name = String(group?.name || '?').trim();
    const initials = name.split(/\s+/).slice(0, 2).map(word => [...word][0] || '').join('').toUpperCase() || '#';
    let hash = 0;
    for (const character of String(group?.id || '')) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
    const color = GROUP_COLORS[hash % GROUP_COLORS.length];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${color}"/>`
        + `<text x="32" y="41" font-family="sans-serif" font-size="24" font-weight="700" fill="#fff" text-anchor="middle">${initials.replace(/[<>&"]/g, '')}</text></svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function groupPresentation(groupId) {
    const group = getGroup(groupId);
    return { id: groupId, name: group?.name || t('groups.unnamed'), avatar: groupAvatar(group), isGroup: true, offline: true };
}

function refreshGroupViews(groupId) {
    if (typeof renderActivePeerList === 'function') renderActivePeerList();
    if (state.activeChatPeerId === groupId) {
        if (typeof renderChatPeerHeader === 'function') renderChatPeerHeader(groupId);
        if (typeof renderChatPeerIndicator === 'function') renderChatPeerIndicator();
        if (typeof updateChatActionButtons === 'function') updateChatActionButtons();
    }
    if (state.groupInfoOpen === groupId) openGroupInfo(groupId);
}

// Kandidaten fuer neue Mitglieder: Freunde, im Event-Modus auch die Leute im Event-Grid.
function groupCandidates(excluded = []) {
    const ids = new Set(Object.keys(state.friendState || {}).filter(id => typeof isFriend === 'function' && isFriend(id)));
    if (state.appMode === 'event') (state.peers || []).forEach(peer => ids.add(peer.id));
    excluded.forEach(id => ids.delete(id));
    ids.delete(state.myProfile?.id);
    return [...ids].filter(id => !isPeerBlocked(id) && !isGroupId(id));
}

function groupsAllowedHere() {
    return (typeof isSocialMode === 'function' && isSocialMode()) || state.appMode === 'event';
}

function memberPicker(candidates, limit) {
    const list = document.createElement('div');
    list.className = 'space-y-1 max-h-72 overflow-y-auto';
    if (!candidates.length) {
        const empty = document.createElement('p');
        empty.className = 'text-sm text-slate-400';
        empty.textContent = t('groups.noCandidates');
        list.appendChild(empty);
    }
    candidates.forEach(id => {
        const label = document.createElement('label');
        label.className = 'flex items-center gap-3 rounded-lg border border-slate-800 px-3 py-2 text-sm text-slate-200 cursor-pointer';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.value = id;
        box.dataset.groupCandidate = id;
        box.onchange = () => {
            if (list.querySelectorAll('input:checked').length > limit) {
                box.checked = false;
                showToast(t('groups.tooMany', { count: GROUP_MAX_MEMBERS }), 'info');
            }
        };
        const image = document.createElement('img');
        image.src = localAvatar(getPeerPresentation(id).avatar);
        image.alt = '';
        image.className = 'w-8 h-8 rounded-full object-cover';
        const name = document.createElement('span');
        name.textContent = displayNameFor(id);
        label.append(box, image, name);
        list.appendChild(label);
    });
    return { list, selected: () => [...list.querySelectorAll('input:checked')].map(input => input.value) };
}

function openGroupCreator() {
    if (!groupsAllowedHere()) {
        showToast(t('groups.onlySocialOrEvent'), 'info');
        return;
    }
    const content = openMediaModal(t('groups.create'));
    const name = document.createElement('input');
    name.type = 'text';
    name.id = 'group-name-input';
    name.maxLength = GROUP_NAME_MAX;
    name.placeholder = t('groups.namePlaceholder');
    name.className = 'w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-base text-slate-100 focus:outline-hidden focus:border-brand-500 mb-3';
    const picker = memberPicker(groupCandidates(), GROUP_MAX_MEMBERS - 1);
    const create = document.createElement('button');
    create.type = 'button';
    create.id = 'group-create-btn';
    create.className = 'w-full mt-3 rounded-full bg-brand-600 hover:bg-brand-500 px-4 py-2.5 text-sm font-semibold text-white';
    create.textContent = t('groups.createButton');
    create.onclick = async () => {
        const members = picker.selected();
        if (!members.length) {
            showToast(t('groups.pickMembers'), 'info');
            return;
        }
        create.disabled = true;
        try {
            const group = await createGroup(name.value, members);
            closeMediaModal();
            await openChatWithPeer(group.id);
        } catch (error) {
            create.disabled = false;
            showToast(t('groups.createFailed'), 'error');
            logDebug(`Group creation failed: ${error.message}`);
        }
    };
    content.append(name, picker.list, create);
}

function openGroupInfo(groupId = state.activeChatPeerId) {
    const group = getGroup(groupId);
    if (!group) return;
    state.groupInfoOpen = groupId;
    const content = openMediaModal(group.name);
    const previousCleanup = state.mediaModalCleanup;
    state.mediaModalCleanup = () => {
        state.groupInfoOpen = null;
        previousCleanup?.();
    };
    const admin = isGroupAdmin(groupId) && isGroupActive(groupId);
    const box = document.createElement('div');
    box.className = 'space-y-3';
    if (!isGroupActive(groupId)) {
        const note = document.createElement('p');
        note.className = 'text-sm text-amber-300';
        note.textContent = group.left ? t('groups.youLeft') : t('groups.youAreRemoved');
        box.appendChild(note);
    }
    if (admin) {
        const rename = document.createElement('div');
        rename.className = 'flex gap-2';
        const input = document.createElement('input');
        input.type = 'text';
        input.id = 'group-rename-input';
        input.value = group.name;
        input.maxLength = GROUP_NAME_MAX;
        input.className = 'flex-1 min-w-0 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-base text-slate-100';
        const save = document.createElement('button');
        save.type = 'button';
        save.id = 'group-rename-btn';
        save.className = 'btn-secondary';
        save.textContent = t('common.save');
        save.onclick = () => input.value.trim() && renameGroup(groupId, input.value).catch(logBackgroundError('openGroupInfo'));
        rename.append(input, save);
        box.appendChild(rename);
    }
    const heading = document.createElement('h4');
    heading.className = 'text-xs font-bold uppercase tracking-wider text-slate-400';
    heading.textContent = t('groups.memberCount', { count: group.members.length });
    box.appendChild(heading);
    group.members.forEach(member => {
        const row = document.createElement('div');
        row.className = 'flex items-center gap-3';
        row.dataset.groupMember = member;
        const image = document.createElement('img');
        image.src = localAvatar(member === state.myProfile.id ? state.myProfile.avatar : getPeerPresentation(member).avatar);
        image.alt = '';
        image.className = 'w-8 h-8 rounded-full object-cover';
        const name = document.createElement('span');
        name.className = 'flex-1 min-w-0 truncate text-sm text-slate-200';
        name.textContent = member === state.myProfile.id ? t('groups.you') : displayNameFor(member);
        row.append(image, name);
        if (group.admins.includes(member)) {
            const badge = document.createElement('span');
            badge.className = 'text-[11px] font-semibold text-brand-300';
            badge.textContent = t('groups.admin');
            row.appendChild(badge);
        }
        if (admin && member !== state.myProfile.id) {
            if (!group.admins.includes(member)) {
                const promote = document.createElement('button');
                promote.type = 'button';
                promote.className = 'text-xs text-slate-300 hover:text-white';
                promote.dataset.groupPromote = member;
                promote.textContent = t('groups.makeAdmin');
                promote.onclick = () => makeGroupAdmin(groupId, member).catch(logBackgroundError('openGroupInfo'));
                row.appendChild(promote);
            }
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'text-xs text-red-300 hover:text-red-200';
            remove.dataset.groupRemove = member;
            remove.textContent = t('groups.remove');
            remove.onclick = () => window.confirm(t('groups.confirmRemove', { name: displayNameFor(member) }))
                && removeGroupMember(groupId, member).catch(logBackgroundError('openGroupInfo'));
            row.appendChild(remove);
        }
        box.appendChild(row);
    });
    if (admin && group.members.length < GROUP_MAX_MEMBERS) {
        const add = document.createElement('button');
        add.type = 'button';
        add.id = 'group-add-btn';
        add.className = 'btn-secondary w-full';
        add.textContent = t('groups.addMembers');
        add.onclick = () => openGroupMemberAdder(groupId);
        box.appendChild(add);
    }
    if (isGroupActive(groupId)) {
        const leave = document.createElement('button');
        leave.type = 'button';
        leave.id = 'group-leave-btn';
        leave.className = 'w-full rounded-full border border-red-500/40 px-4 py-2 text-sm font-semibold text-red-300 hover:bg-red-500/10';
        leave.textContent = t('groups.leave');
        leave.onclick = async () => {
            if (!window.confirm(t('groups.confirmLeave', { name: group.name }))) return;
            await leaveGroup(groupId);
        };
        box.appendChild(leave);
    }
    content.appendChild(box);
}

function openGroupMemberAdder(groupId) {
    const group = getGroup(groupId);
    if (!group) return;
    const content = openMediaModal(t('groups.addMembers'));
    const picker = memberPicker(groupCandidates(group.members), GROUP_MAX_MEMBERS - group.members.length);
    // Verlauf fuer die Neuen (Wahl des Admins).
    const history = document.createElement('div');
    history.className = 'mt-3 space-y-1 text-sm text-slate-200';
    history.setAttribute('role', 'radiogroup');
    [['none', t('groups.historyNone')], ['last50', t('groups.historyLast50')]].forEach(([value, text], index) => {
        const label = document.createElement('label');
        label.className = 'flex items-center gap-2';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'group-history';
        radio.value = value;
        radio.checked = index === 0;
        radio.dataset.groupHistory = value;
        const span = document.createElement('span');
        span.textContent = text;
        label.append(radio, span);
        history.appendChild(label);
    });
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.id = 'group-add-confirm';
    confirm.className = 'w-full mt-3 rounded-full bg-brand-600 hover:bg-brand-500 px-4 py-2.5 text-sm font-semibold text-white';
    confirm.textContent = t('groups.add');
    confirm.onclick = async () => {
        const ids = picker.selected();
        if (!ids.length) return;
        confirm.disabled = true;
        const choice = history.querySelector('input[name="group-history"]:checked')?.value || 'none';
        await addGroupMembers(groupId, ids, choice).catch(logBackgroundError('openGroupMemberAdder'));
        openGroupInfo(groupId);
    };
    content.append(picker.list, history, confirm);
}

function chatMenuGroupInfo() {
    if (typeof closeChatHeaderMenu === 'function') closeChatHeaderMenu();
    openGroupInfo(state.activeChatPeerId);
}

function connectGroupMembers(groupId) {
    groupRecipients(groupId).forEach(member => initiateP2PConnection(member).catch(() => {}));
}
