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
