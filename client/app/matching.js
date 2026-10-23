// ================= MATCHING, CHAT-BERECHTIGUNGEN, PROFIL-SICHTBARKEIT =================
// Flammen (MATCH_PING) und Match-Aufloesungen (MATCH_RESET) sind normale Chat-Operationen:
// verschluesselt, idempotent, per P2P oder Pfad C, im Chat-Sync enthalten. Ein Match besteht,
// wenn beide Seiten nach der letzten Aufloesung eine Flamme gesendet haben. Der Server weiss nichts.
const FLAME_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const CHAT_LIMIT_OPTIONS = [1, 3, 5, 10];
const HIDDEN_PEER_NAME = 'Jemand in der Naehe';

const DEFAULT_CHAT_POLICY = { mode: 'A', limit: 5, allowImages: true };

function getMyVisibility() {
    return [1, 2, 3].includes(state.myProfile.visibility) ? state.myProfile.visibility : 1;
}

function getMyChatPolicy() {
    const policy = state.myProfile.chatPolicy || {};
    return {
        mode: ['A', 'B', 'C'].includes(policy.mode) ? policy.mode : DEFAULT_CHAT_POLICY.mode,
        limit: CHAT_LIMIT_OPTIONS.includes(policy.limit) ? policy.limit : DEFAULT_CHAT_POLICY.limit,
        allowImages: policy.allowImages !== false
    };
}

function sanitizeChatPolicy(policy) {
    if (!policy || typeof policy !== 'object') return { ...DEFAULT_CHAT_POLICY };
    return {
        mode: ['A', 'B', 'C'].includes(policy.mode) ? policy.mode : 'A',
        limit: CHAT_LIMIT_OPTIONS.includes(policy.limit) ? policy.limit : 5,
        allowImages: policy.allowImages !== false
    };
}

// ----- Match-Zustand -----
function emptyMatchEntry() {
    return { sentAt: 0, receivedAt: 0, resetAt: 0 };
}

function getMatchEntry(peerId) {
    return state.matchState[peerId] || emptyMatchEntry();
}

function isMatched(peerId) {
    const entry = getMatchEntry(peerId);
    return entry.sentAt > entry.resetAt && entry.receivedAt > entry.resetAt;
}

function hasReceivedFlame(peerId) {
    const entry = getMatchEntry(peerId);
    return entry.receivedAt > entry.resetAt;
}

function hasSentFlame(peerId) {
    const entry = getMatchEntry(peerId);
    return entry.sentAt > entry.resetAt;
}

function recordMatchOperation(peerId, operation) {
    const entry = { ...getMatchEntry(peerId) };
    const at = operation.createdAt || 0;
    if (operation.type === 'MATCH_PING') {
        if (operation.actorId === state.myProfile.id) entry.sentAt = Math.max(entry.sentAt, at);
        else entry.receivedAt = Math.max(entry.receivedAt, at);
    } else if (operation.type === 'MATCH_RESET') {
        entry.resetAt = Math.max(entry.resetAt, at);
    }
    state.matchState[peerId] = entry;
}

// Beim Start aus dem Operations-Log aufbauen.
async function loadMatchState() {
    const operations = await getAllDatabaseRecords('chatOperations').catch(() => []);
    state.matchState = {};
    operations
        .filter(operation => operation.type === 'MATCH_PING' || operation.type === 'MATCH_RESET')
        .forEach(operation => recordMatchOperation(operation.peerId, operation));
}

// Aus applyChatOperation: gibt false zurueck, wenn die Operation ungueltig ist.
async function applyMatchOperation(peerId, operation) {
    if (operation.actorId !== peerId && operation.actorId !== state.myProfile.id) return false;
    const wasMatched = isMatched(peerId);
    recordMatchOperation(peerId, operation);
    rememberChatPeer(peerId);
    const nowMatched = isMatched(peerId);
    if (wasMatched !== nowMatched) syncChatGate();
    if (!wasMatched && nowMatched) {
        await releaseHeldMessages(peerId);
        if (operation.actorId === peerId) showToast(`Match mit ${getPeerPresentation(peerId).name || 'Peer'}!`, 'success');
        // Das Profil ist jetzt fuer diesen Peer vollstaendig: neu anfragen.
        sendSecurePayload(peerId, { type: 'PROFILE_REQUEST' }).catch(() => {});
    } else if (operation.type === 'MATCH_PING' && operation.actorId === peerId && !nowMatched) {
        showToast(`${getPeerPresentation(peerId).name || HIDDEN_PEER_NAME} hat dir eine Flamme geschickt.`, 'info');
    }
    if (wasMatched && !nowMatched) sendSecurePayload(peerId, { type: 'PROFILE_REQUEST' }).catch(() => {});
    renderMatchUi(peerId);
    return true;
}

async function sendMatchOperation(peerId, type) {
    const operation = {
        operationId: `${type === 'MATCH_PING' ? 'flame' : 'unmatch'}:${window.crypto.randomUUID()}`,
        peerId,
        type,
        actorId: state.myProfile.id,
        createdAt: Date.now()
    };
    await applyChatOperation(peerId, operation);
    const { peerId: _localPeerId, ...sharedOperation } = operation;
    await sendSecurePayload(peerId, { type: 'CHAT_OPERATION', operation: sharedOperation });
}

function flameCooldownLeft(peerId) {
    const entry = getMatchEntry(peerId);
    return Math.max(0, entry.sentAt + FLAME_COOLDOWN_MS - Date.now());
}

async function sendFlame(peerId) {
    if (!peerId || isPeerBlocked(peerId)) return;
    if (isMatched(peerId)) return;
    if (flameCooldownLeft(peerId) > 0) {
        showToast('Du hast schon eine Flamme geschickt. Die naechste geht in 24 Stunden.', 'info');
        return;
    }
    await sendMatchOperation(peerId, 'MATCH_PING');
    showToast(isMatched(peerId) ? 'Match!' : 'Flamme gesendet.', 'success');
}

async function dissolveMatch(peerId) {
    if (!isMatched(peerId) || !window.confirm('Match wirklich loesen? Danach gelten wieder die Einschraenkungen.')) return;
    await sendMatchOperation(peerId, 'MATCH_RESET');
}

// ----- Chat-Berechtigungen (durchgesetzt beim Empfaenger) -----
// Ein Chat gilt als angenommen bei Match oder wenn man dem anderen selbst schon geschrieben hat.
function messageHasImage(message) {
    return Boolean(message?.snapData || message?.album || message?.secureSnap || message?.snapMode);
}

// true = Nachricht wird zurueckgehalten (nicht angezeigt), bis es ein Match gibt.
async function shouldHoldIncomingMessage(peerId, message) {
    if (message.senderId !== peerId || isMatched(peerId)) return false;
    const policy = getMyChatPolicy();
    if (policy.mode === 'A') return false;
    // Liest aus der Datenbank, der Chat muss dafuer nicht geoeffnet sein.
    const stored = await getDatabaseRecordsByIndex('messages', 'peerId', peerId).catch(() => []);
    if (stored.some(item => item.senderId === state.myProfile.id && !item.held)) return false;
    if (policy.mode === 'C') return true;
    if (!policy.allowImages && messageHasImage(message)) return true;
    const received = stored.filter(item => item.senderId === peerId && !item.held && item.id !== message.id).length;
    return received >= policy.limit;
}

async function releaseHeldMessages(peerId) {
    const stored = await getDatabaseRecordsByIndex('messages', 'peerId', peerId).catch(() => []);
    const held = stored.filter(message => message.held);
    for (const message of held) {
        delete message.held;
        await persistChatMessage(peerId, message);
        if (!state.chats[peerId]) state.chats[peerId] = [];
        const index = state.chats[peerId].findIndex(item => item.id === message.id);
        if (index >= 0) state.chats[peerId][index] = message;
        else state.chats[peerId].push(message);
    }
    if (held.length && state.activeChatPeerId === peerId) renderChatHistory();
}

// Absender-Sicht: was erlaubt die Einstellung des anderen? (nur Anzeige, durchgesetzt wird beim Empfaenger)
function getPeerChatAllowance(peerId) {
    if (isMatched(peerId)) return { allowed: true, remaining: Infinity, images: true };
    // Hat der andere schon geschrieben, hat er den Chat angenommen.
    const peerWrote = (state.chats[peerId] || []).some(message => message.senderId === peerId && !message.held);
    if (peerWrote) return { allowed: true, remaining: Infinity, images: true };
    const policy = sanitizeChatPolicy(state.cachedProfiles[peerId]?.chatPolicy);
    if (policy.mode === 'A') return { allowed: true, remaining: Infinity, images: true };
    if (policy.mode === 'C') return { allowed: false, remaining: 0, images: false, reason: 'Nur Matches koennen schreiben. Sende eine Flamme.' };
    const sent = (state.chats[peerId] || []).filter(message => message.senderId === state.myProfile.id && !message.deleted).length;
    const remaining = Math.max(0, policy.limit - sent);
    return {
        allowed: remaining > 0,
        remaining,
        images: policy.allowImages,
        reason: remaining > 0 ? null : 'Nachrichtenlimit bis zum Match erreicht. Sende eine Flamme.'
    };
}

// ----- Profil-Sichtbarkeit (durchgesetzt beim Besitzer) -----
function isGalleryVisibleTo(peerId) {
    return getMyVisibility() === 1 || isMatched(peerId);
}

// Baut das Profil, das genau dieser Peer sehen darf. `audience` bindet ein Match-Profil an ihn.
function buildProfilePayloadFor(peerId) {
    const visibility = getMyVisibility();
    const matched = isMatched(peerId);
    const base = {
        id: state.myProfile.id,
        version: state.myProfile.version,
        updatedAt: state.myProfile.updatedAt,
        visibility,
        chatPolicy: getMyChatPolicy()
    };
    if (visibility === 1 || matched) {
        return {
            ...base,
            audience: visibility === 1 ? 'public' : peerId,
            fields: state.myProfile.fields,
            avatar: state.myProfile.avatar,
            gallery: state.myProfile.gallery || []
        };
    }
    if (visibility === 2) {
        const privateFields = new Set(state.myProfile.privateFields || []);
        const fields = Object.fromEntries(Object.entries(state.myProfile.fields || {})
            .filter(([key]) => !privateFields.has(key)));
        return { ...base, audience: 'public', fields, avatar: state.myProfile.avatar, gallery: [], restricted: true };
    }
    return { ...base, audience: 'public', fields: {}, avatar: null, gallery: [], restricted: true };
}

// Darf ein empfangenes Profil (direkt oder ueber den Schwarm) gespeichert werden?
function isProfileAudienceAcceptable(profile) {
    return !profile?.audience || profile.audience === 'public' || profile.audience === state.myProfile.id;
}

function isProfileShareable(profile) {
    return !profile?.audience || profile.audience === 'public';
}

// Was der Router zu sehen bekommt.
function getRegistrationIdentity() {
    if (getMyVisibility() === 3) return { name: '', thumbnail: null };
    // Nur echte Bilder an den Router, keine externen Platzhalter-URLs alter Profile.
    const avatar = state.myProfile.avatar;
    return {
        name: state.myProfile.fields.displayName || 'Peer',
        thumbnail: typeof avatar === 'string' && avatar.startsWith('data:image/') ? avatar : null
    };
}

function displayNameFor(peerId) {
    const presentation = getPeerPresentation(peerId);
    return presentation.name || HIDDEN_PEER_NAME;
}

// Spiegelt Modus + angenommene Peers fuer den Service Worker (der keine Chat-Regeln kennt).
async function syncChatGate() {
    try {
        const messages = await getAllDatabaseRecords('messages');
        const accepted = new Set(messages
            .filter(message => message.senderId === state.myProfile.id && !message.held)
            .map(message => message.peerId));
        Object.keys(state.matchState).filter(isMatched).forEach(peerId => accepted.add(peerId));
        await putDatabaseRecord('keys', { id: 'chat-gate', mode: getMyChatPolicy().mode, acceptedPeerIds: [...accepted] });
    } catch (error) {
        logDebug(`Could not sync chat gate: ${error.message}`);
    }
}

// Vom Service Worker gespeicherte Nachrichten nicht angenommener Peers nachtraeglich pruefen.
async function resolvePendingPolicyMessages(peerId, messages) {
    for (const message of messages.filter(item => item.policyPending)) {
        delete message.policyPending;
        delete message.held;
        if (await shouldHoldIncomingMessage(peerId, message)) message.held = true;
        await persistChatMessage(peerId, message);
    }
}

// ----- Einstellungen -----
async function updateMatchingSetting(key, value) {
    if (key === 'visibility') state.myProfile.visibility = Number(value);
    else if (key === 'chatMode') state.myProfile.chatPolicy = { ...getMyChatPolicy(), mode: value };
    else if (key === 'chatLimit') state.myProfile.chatPolicy = { ...getMyChatPolicy(), limit: Number(value) };
    else if (key === 'chatImages') state.myProfile.chatPolicy = { ...getMyChatPolicy(), allowImages: Boolean(value) };
    renderMatchingSettings();
    if (key === 'visibility' && typeof renderProfileForm === 'function') renderProfileForm();
    await syncChatGate();
    // Neue Version, damit Peers das geaenderte Profil (Sichtbarkeit, Chat-Regeln) uebernehmen.
    await saveUserProfile();
}

async function togglePrivateField(fieldKey, isPrivate) {
    const privateFields = new Set(state.myProfile.privateFields || []);
    if (isPrivate) privateFields.add(fieldKey);
    else privateFields.delete(fieldKey);
    state.myProfile.privateFields = [...privateFields];
}

function renderMatchingSettings() {
    const policy = getMyChatPolicy();
    const visibility = document.getElementById('profile-visibility-select');
    if (visibility) visibility.value = String(getMyVisibility());
    const mode = document.getElementById('chat-mode-select');
    if (mode) mode.value = policy.mode;
    const limit = document.getElementById('chat-limit-select');
    if (limit) limit.value = String(policy.limit);
    const images = document.getElementById('chat-images-toggle');
    if (images) images.checked = policy.allowImages;
    document.getElementById('chat-limit-options')?.classList.toggle('hidden', policy.mode !== 'B');
}

// ----- UI -----
function renderMatchUi(peerId) {
    renderActivePeerList();
    if (state.activeModalPeerId === peerId) renderProfileMatchActions(peerId);
    if (state.activeChatPeerId === peerId) {
        updateChatActionButtons();
        renderChatAllowance();
    }
}

function renderProfileMatchActions(peerId) {
    const container = document.getElementById('modal-match-actions');
    if (!container) return;
    container.innerHTML = '';
    if (!peerId || isPeerBlocked(peerId)) return;
    const status = document.createElement('div');
    status.className = 'text-xs text-slate-400 flex items-center gap-1.5';
    const button = document.createElement('button');
    button.type = 'button';
    if (isMatched(peerId)) {
        status.innerHTML = '<i class="fa-solid fa-fire text-orange-400"></i>';
        status.appendChild(document.createTextNode(' Ihr habt ein Match'));
        button.className = 'text-xs px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800';
        button.textContent = 'Match loesen';
        button.onclick = () => dissolveMatch(peerId);
    } else {
        if (hasReceivedFlame(peerId)) status.textContent = 'Hat dir eine Flamme geschickt';
        else if (hasSentFlame(peerId)) status.textContent = 'Flamme gesendet';
        button.className = 'text-xs px-3 py-1.5 rounded-lg bg-orange-500/20 border border-orange-500/40 text-orange-300 hover:bg-orange-500/30 font-semibold flex items-center gap-1.5 disabled:opacity-50';
        button.innerHTML = '<i class="fa-solid fa-fire"></i>';
        button.appendChild(document.createTextNode(hasReceivedFlame(peerId) ? ' Zurueck-flammen' : ' Flamme senden'));
        button.disabled = flameCooldownLeft(peerId) > 0;
        button.onclick = () => sendFlame(peerId);
    }
    container.append(status, button);
}

// Hinweis/Sperre ueber dem Eingabefeld (Absender-Sicht).
function renderChatAllowance() {
    const hint = document.getElementById('chat-allowance-hint');
    const peerId = state.activeChatPeerId;
    if (!hint) return;
    if (!peerId || isPeerBlocked(peerId)) {
        hint.classList.add('hidden');
        return;
    }
    const allowance = getPeerChatAllowance(peerId);
    const input = document.getElementById('chat-input');
    const send = document.getElementById('send-chat-btn');
    if (input) input.disabled = !allowance.allowed;
    if (send) send.disabled = !allowance.allowed;
    document.querySelectorAll('[data-chat-image-action]').forEach(button => {
        button.disabled = !allowance.allowed || !allowance.images;
    });
    if (allowance.allowed && allowance.remaining === Infinity) {
        hint.classList.add('hidden');
        return;
    }
    hint.classList.remove('hidden');
    hint.innerHTML = '';
    const text = document.createElement('span');
    text.textContent = allowance.reason || `Noch ${allowance.remaining} ${allowance.remaining === 1 ? 'Nachricht' : 'Nachrichten'} bis zum Match${allowance.images ? '' : ' (ohne Bilder)'}.`;
    hint.appendChild(text);
    if (!hasSentFlame(peerId)) {
        const flame = document.createElement('button');
        flame.type = 'button';
        flame.className = 'ml-2 text-orange-300 font-semibold';
        flame.innerHTML = '<i class="fa-solid fa-fire"></i> Flamme senden';
        flame.onclick = () => sendFlame(peerId);
        hint.appendChild(flame);
    }
}
