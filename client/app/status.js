// ================= STATUS (Chat- und Freunde-Modus) =================
// Text- oder Foto-Status fuer 24 Stunden, nur fuer Freunde. Verteilung als Chat-Operation
// STATUS_POST/STATUS_DELETE an jeden Freund einzeln: P2P, sonst ueber den Router-Cache (Pfad C, ohne
// Push). Mit "Status nur direkt" nur P2P; offline Freunde bekommen aktive Status beim naechsten
// Verbindungsaufbau (pushStatusesToPeer). Die Operationen landen nicht im Chat-Log.
// Gespeichert im Store `statusUpdates`, Inhalt mit dem Speicherschluessel verschluesselt.
// Dazu der Kurzstatus (Rich Presence) im Freundes-Profil: `presenceText`.
const STATUS_TTL_MS = 24 * 60 * 60 * 1000;
const STATUS_GC_INTERVAL_MS = 15 * 60 * 1000;
const STATUS_TEXT_MAX = 280;
const PRESENCE_TEXT_MAX = 60;
const STATUS_SHOW_MS = 5000;
const STATUS_COLORS = ['#7c3aed', '#db2777', '#ea580c', '#16a34a', '#0284c7', '#334155'];
const STATUS_SETTINGS_RECORD_ID = 'status-settings';

// ----- Einstellungen -----
async function loadStatusSettings() {
    const stored = await databaseRequest('keys', 'readonly', store => store.get(STATUS_SETTINGS_RECORD_ID)).catch(() => null);
    state.statusSettings = { directOnly: stored ? stored.directOnly === true : clientDefault('statusDirectOnly', false) === true };
    const toggle = document.getElementById('status-direct-toggle');
    if (toggle) toggle.checked = state.statusSettings.directOnly;
}

async function updateStatusSetting(key, value) {
    state.statusSettings = { ...state.statusSettings, [key]: value === true };
    await putDatabaseRecord('keys', { id: STATUS_SETTINGS_RECORD_ID, ...state.statusSettings })
        .catch(error => logDebug(`Could not store status settings: ${error.message}`));
}

// ----- Speicher -----
async function persistStatus(status) {
    const record = { id: status.id, peerId: status.peerId, expiresAt: status.expiresAt };
    if (state.storageKey) record.sealed = await encryptStoredProfile(status);
    else Object.assign(record, status);
    await putDatabaseRecord('statusUpdates', record);
}

async function loadStatuses() {
    const records = await getAllDatabaseRecords('statusUpdates').catch(() => []);
    state.statuses = {};
    for (const record of records) {
        const status = record.sealed ? await decryptStoredProfile(record.sealed).catch(() => null) : record;
        if (status?.id) state.statuses[status.id] = status;
    }
    await removeExpiredStatuses();
}

async function deleteStatusRecord(statusId) {
    delete state.statuses[statusId];
    await deleteDatabaseRecord('statusUpdates', statusId).catch(logBackgroundError('deleteStatusRecord'));
}

// Abgelaufene Status unwiderruflich loeschen (Datensatz und Bild).
async function removeExpiredStatuses(now = Date.now()) {
    const records = await getAllDatabaseRecords('statusUpdates').catch(() => []);
    const expired = records.filter(record => !(record.expiresAt > now)).map(record => record.id);
    Object.values(state.statuses).filter(status => !(status.expiresAt > now)).forEach(status => expired.push(status.id));
    for (const statusId of new Set(expired)) await deleteStatusRecord(statusId);
    if (expired.length) renderStatusBar();
    return expired.length;
}

function startStatusCleanup() {
    clearInterval(state.statusCleanupTimer);
    state.statusCleanupTimer = setInterval(() => removeExpiredStatuses().catch(logBackgroundError('removeExpiredStatuses')), STATUS_GC_INTERVAL_MS);
}

function activeStatusesOf(peerId, now = Date.now()) {
    return Object.values(state.statuses)
        .filter(status => status.peerId === peerId && status.expiresAt > now)
        .sort((left, right) => left.createdAt - right.createdAt);
}

function friendIds() {
    return Object.keys(state.friendState).filter(isFriend);
}

// ----- Senden -----
// Fotos traegt jeder Freund mit seinem eigenen Wasserzeichen (wenn eingeschaltet).
async function statusPayloadFor(status, friendId) {
    const payload = { statusId: status.id, kind: status.kind, createdAt: status.createdAt, expiresAt: status.expiresAt };
    if (status.kind === 'text') return { ...payload, text: status.text, color: status.color };
    let image = status.image;
    if (isTraceWatermarkEnabled() && typeof embedWatermark === 'function') {
        image = await embedWatermark(status.image, friendId).catch(() => status.image);
    }
    return { ...payload, image, text: status.text || '' };
}

async function sendStatusOperation(friendId, type, body) {
    const operation = {
        operationId: `${type === 'STATUS_POST' ? 'status' : 'unstatus'}:${body.statusId}:${window.crypto.randomUUID()}`,
        type,
        actorId: state.myProfile.id,
        createdAt: Date.now(),
        ...body
    };
    // Ohne Rueckruf bleibt es bei P2P (Warteschlange bis zum naechsten Kanal), sonst nach 10 s Pfad C.
    const fallback = state.statusSettings.directOnly ? null : () => {};
    await sendSecurePayload(friendId, { type: 'CHAT_OPERATION', operation }, fallback);
    (state.statusPushes[friendId] || (state.statusPushes[friendId] = new Set())).add(body.statusId);
}

async function distributeStatus(status) {
    for (const friendId of friendIds()) {
        await sendStatusOperation(friendId, 'STATUS_POST', await statusPayloadFor(status, friendId))
            .catch(logBackgroundError('distributeStatus'));
    }
}

// Beim Verbindungsaufbau: aktive eigene Status nachliefern, die der Freund noch nicht hat.
async function pushStatusesToPeer(peerId) {
    if (!isFriend(peerId)) return;
    const pushed = state.statusPushes[peerId] || new Set();
    for (const status of activeStatusesOf(state.myProfile.id).filter(entry => !pushed.has(entry.id))) {
        await sendStatusOperation(peerId, 'STATUS_POST', await statusPayloadFor(status, peerId));
    }
}

async function createOwnStatus(fields) {
    const createdAt = Date.now();
    const status = {
        id: `st_${window.crypto.randomUUID()}`,
        peerId: state.myProfile.id,
        createdAt,
        expiresAt: createdAt + STATUS_TTL_MS,
        ...fields
    };
    state.statuses[status.id] = status;
    await persistStatus(status);
    renderStatusBar();
    await distributeStatus(status);
    showToast(friendIds().length ? t('status.shared') : t('status.savedYouDontHave'), 'success');
    return status;
}

async function postTextStatus() {
    const input = document.getElementById('status-text-input');
    const text = input?.value.trim().substring(0, STATUS_TEXT_MAX);
    if (!text) return;
    const color = document.querySelector('#status-color-row [aria-checked="true"]')?.dataset.color || STATUS_COLORS[0];
    input.value = '';
    closeMediaModal();
    await createOwnStatus({ kind: 'text', text, color });
}

// Foto: Kamera + Editor der Snaps, beim Senden landet das Bild hier statt im Chat.
async function postPhotoStatus(image, caption) {
    if (!isSafeInlineImage(image)) return;
    await createOwnStatus({ kind: 'photo', image, text: String(caption || '').substring(0, STATUS_TEXT_MAX) });
}

async function deleteOwnStatus(statusId) {
    const status = state.statuses[statusId];
    if (!status || status.peerId !== state.myProfile.id) return;
    await deleteStatusRecord(statusId);
    for (const friendId of friendIds()) {
        await sendStatusOperation(friendId, 'STATUS_DELETE', { statusId }).catch(logBackgroundError('deleteOwnStatus'));
    }
    renderStatusBar();
    closeStatusViewer();
}

// ----- Empfangen (aus applyChatOperation) -----
async function handleStatusOperation(peerId, operation) {
    if (operation.actorId !== peerId || !isFriend(peerId)) return false;
    if (operation.type === 'STATUS_DELETE') {
        const existing = state.statuses[operation.statusId];
        if (existing?.peerId === peerId) await deleteStatusRecord(operation.statusId);
        renderStatusBar();
        return true;
    }
    const now = Date.now();
    // Hoechstens 24 h ab jetzt, auch wenn der Absender etwas anderes angibt.
    const expiresAt = Math.min(Number(operation.expiresAt) || 0, (Number(operation.createdAt) || now) + STATUS_TTL_MS, now + STATUS_TTL_MS);
    if (!(expiresAt > now)) return true;
    const status = {
        id: operation.statusId,
        peerId,
        kind: operation.kind === 'photo' ? 'photo' : 'text',
        text: String(operation.text || '').substring(0, STATUS_TEXT_MAX),
        color: STATUS_COLORS.includes(operation.color) ? operation.color : STATUS_COLORS[0],
        image: operation.kind === 'photo' && isSafeInlineImage(operation.image) ? operation.image : undefined,
        createdAt: Math.min(Number(operation.createdAt) || now, now),
        expiresAt,
        seen: state.statuses[operation.statusId]?.seen || false
    };
    if (status.kind === 'photo' && !status.image) return false;
    state.statuses[status.id] = status;
    await persistStatus(status);
    renderStatusBar();
    return true;
}

// Ende einer Freundschaft: deren Status sofort entfernen.
async function forgetStatusesOf(peerId) {
    for (const status of activeStatusesOf(peerId, 0)) await deleteStatusRecord(status.id);
    renderStatusBar();
}

// ----- Kurzstatus (Rich Presence) -----
function presenceTextOf(peerId) {
    if (peerId === state.myProfile.id) return state.myProfile.presenceText || '';
    if (!isFriend(peerId)) return '';
    const text = state.cachedProfiles[peerId]?.presenceText;
    return typeof text === 'string' ? text.substring(0, PRESENCE_TEXT_MAX) : '';
}

async function savePresenceText() {
    const input = document.getElementById('status-presence-input');
    state.myProfile.presenceText = String(input?.value || '').trim().substring(0, PRESENCE_TEXT_MAX);
    await saveUserProfile();
    // Neues Profil an online Freunde, damit der Kurzstatus sofort erscheint.
    for (const friendId of friendIds().filter(isSecureChannelOpen)) {
        await handleIncomingProfileRequest(friendId).catch(logBackgroundError('savePresenceText'));
    }
}

// ----- Statusleiste ueber der Chatliste -----
function statusAvatar(peerId, { ring, label, onClick }) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'shrink-0 w-16 flex flex-col items-center gap-1 text-[10px] text-slate-300';
    const frame = document.createElement('div');
    frame.className = `relative w-14 h-14 rounded-full p-0.5 ${ring}`;
    const image = document.createElement('img');
    image.src = localAvatar(peerId === state.myProfile.id ? state.myProfile.avatar : getPeerPresentation(peerId).avatar);
    image.alt = '';
    image.className = 'w-full h-full rounded-full object-cover border-2 border-slate-900';
    frame.appendChild(image);
    const name = document.createElement('span');
    name.className = 'w-full truncate text-center';
    name.textContent = label;
    button.append(frame, name);
    button.onclick = onClick;
    return { button, frame };
}

function renderStatusBar() {
    const bar = document.getElementById('status-bar');
    if (!bar) return;
    const visible = currentChatScope() === 'social';
    bar.classList.toggle('hidden', !visible);
    if (!visible) return;
    const own = activeStatusesOf(state.myProfile.id);
    const items = [];
    const mine = statusAvatar(state.myProfile.id, {
        ring: own.length ? 'bg-gradient-to-tr from-brand-500 to-amber-400' : 'bg-slate-800',
        label: t('status.yourStatus'),
        onClick: () => (own.length ? openStatusViewer(state.myProfile.id) : openStatusComposer())
    });
    const plus = document.createElement('span');
    plus.className = 'absolute -bottom-0.5 -right-0.5 w-5 h-5 rounded-full bg-brand-600 text-white text-[10px] flex items-center justify-center border-2 border-slate-900';
    plus.innerHTML = '<i class="fa-solid fa-plus"></i>';
    plus.onclick = event => {
        event.stopPropagation();
        openStatusComposer();
    };
    mine.frame.appendChild(plus);
    items.push(mine.button);
    friendIds()
        .map(peerId => ({ peerId, statuses: activeStatusesOf(peerId) }))
        .filter(entry => entry.statuses.length)
        .sort((left, right) => Number(left.statuses.every(status => status.seen)) - Number(right.statuses.every(status => status.seen))
            || right.statuses.at(-1).createdAt - left.statuses.at(-1).createdAt)
        .forEach(({ peerId, statuses }) => {
            const unseen = statuses.some(status => !status.seen);
            items.push(statusAvatar(peerId, {
                ring: unseen ? 'bg-gradient-to-tr from-brand-500 to-amber-400' : 'bg-slate-700',
                label: getPeerPresentation(peerId).name || t('status.friend'),
                onClick: () => openStatusViewer(peerId)
            }).button);
        });
    bar.replaceChildren(...items);
}

// ----- Verfassen -----
function openStatusComposer() {
    const content = openMediaModal(t('common.status'));
    const wrapper = document.createElement('div');
    wrapper.className = 'space-y-4';
    wrapper.innerHTML = `
        <div class="space-y-2">
            <textarea id="status-text-input" rows="3" maxlength="${STATUS_TEXT_MAX}" placeholder="Was ist los? (24 Stunden sichtbar fuer Freunde)" class="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-base md:text-sm text-slate-100 resize-none focus:outline-none focus:border-brand-500"></textarea>
            <div class="flex items-center justify-between gap-2">
                <div id="status-color-row" class="flex gap-1.5" role="radiogroup" aria-label="Hintergrund"></div>
                <button id="status-post-text-btn" type="button" class="px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-sm font-semibold">Teilen</button>
            </div>
        </div>
        <button id="status-photo-btn" type="button" class="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-slate-700 text-slate-200 hover:bg-slate-800 text-sm font-semibold">
            <i class="fa-solid fa-camera"></i> Foto-Status aufnehmen
        </button>
        <div class="space-y-2 pt-3 border-t border-slate-800">
            <label for="status-presence-input" class="text-xs font-bold text-slate-400">Kurzstatus (dauerhaft, neben deinem Online-Punkt, nur fuer Freunde)</label>
            <div class="flex gap-2">
                <input id="status-presence-input" type="text" maxlength="${PRESENCE_TEXT_MAX}" placeholder="z. B. Im Club" class="flex-1 min-w-0 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-base md:text-sm text-slate-100 focus:outline-none focus:border-brand-500">
                <button id="status-presence-btn" type="button" class="px-3 py-2 rounded-lg border border-slate-700 text-slate-200 hover:bg-slate-800 text-sm">Speichern</button>
            </div>
        </div>`;
    content.appendChild(wrapper);
    document.getElementById('status-presence-input').value = state.myProfile.presenceText || '';
    const colors = document.getElementById('status-color-row');
    STATUS_COLORS.forEach((color, index) => {
        const swatch = document.createElement('button');
        swatch.type = 'button';
        swatch.dataset.color = color;
        swatch.className = 'w-7 h-7 rounded-full border-2 border-transparent aria-checked:border-white';
        swatch.style.backgroundColor = color;
        swatch.setAttribute('role', 'radio');
        swatch.setAttribute('aria-label', t('status.colour', { value: index + 1 }));
        swatch.setAttribute('aria-checked', String(index === 0));
        swatch.onclick = () => colors.querySelectorAll('button').forEach(button => button.setAttribute('aria-checked', String(button === swatch)));
        colors.appendChild(swatch);
    });
    document.getElementById('status-post-text-btn').onclick = () => postTextStatus().catch(logBackgroundError('postTextStatus'));
    document.getElementById('status-photo-btn').onclick = () => replaceModal(closeMediaModal, () => openSnapCamera('status'));
    document.getElementById('status-presence-btn').onclick = () => savePresenceText()
        .then(() => showToast(t('status.shortStatusSaved'), 'success'))
        .catch(logBackgroundError('savePresenceText'));
}

// ----- Ansehen -----
function openStatusViewer(peerId) {
    const statuses = activeStatusesOf(peerId);
    if (!statuses.length) return;
    const viewer = document.getElementById('status-viewer');
    state.statusViewer = { peerId, statuses, index: Math.max(0, statuses.findIndex(status => !status.seen)), timer: null };
    if (viewer.classList.contains('hidden')) {
        viewer.classList.remove('hidden');
        pushModalEntry('status', hideStatusViewer);
    }
    showStatusAt(state.statusViewer.index);
}

function showStatusAt(index) {
    const viewing = state.statusViewer;
    if (!viewing) return;
    if (index < 0) index = 0;
    if (index >= viewing.statuses.length) {
        closeStatusViewer();
        return;
    }
    viewing.index = index;
    clearTimeout(viewing.timer);
    const status = viewing.statuses[index];
    const isMine = viewing.peerId === state.myProfile.id;
    document.getElementById('status-viewer-name').textContent = isMine ? t('status.yourStatus') : (getPeerPresentation(viewing.peerId).name || t('status.friend'));
    document.getElementById('status-viewer-time').textContent = formatChatListTime(status.createdAt);
    document.getElementById('status-viewer-delete').classList.toggle('hidden', !isMine);
    const progress = document.getElementById('status-viewer-progress');
    progress.replaceChildren(...viewing.statuses.map((_, position) => {
        const track = document.createElement('div');
        track.className = 'flex-1 h-1 rounded-full bg-white/30 overflow-hidden';
        const fill = document.createElement('div');
        fill.className = 'h-full bg-white';
        fill.style.width = position < index ? '100%' : '0%';
        if (position === index) {
            fill.style.transition = prefersReducedMotion() ? 'none' : `width ${STATUS_SHOW_MS}ms linear`;
            requestAnimationFrame(() => { fill.style.width = '100%'; });
        }
        track.appendChild(fill);
        return track;
    }));
    const canvas = document.getElementById('status-viewer-image');
    const text = document.getElementById('status-viewer-text');
    const panel = document.getElementById('status-viewer-content');
    if (status.kind === 'photo') {
        drawSecureImage(canvas, status.image).catch(logBackgroundError('showStatusAt'));
        canvas.classList.remove('hidden');
        panel.style.backgroundColor = '#000';
        text.className = status.text ? 'absolute inset-x-6 bottom-24 text-center text-white text-base font-semibold drop-shadow' : 'hidden';
    } else {
        clearSecureCanvas(canvas);
        canvas.classList.add('hidden');
        panel.style.backgroundColor = status.color;
        text.className = 'px-8 text-center text-white text-2xl font-bold leading-snug break-words';
    }
    text.textContent = status.text || '';
    if (!isMine && !status.seen) {
        status.seen = true;
        persistStatus(status).catch(logBackgroundError('showStatusAt'));
    }
    viewing.timer = setTimeout(() => showStatusAt(index + 1), STATUS_SHOW_MS);
}

function stepStatus(direction) {
    if (state.statusViewer) showStatusAt(state.statusViewer.index + direction);
}

function deleteViewedStatus() {
    const viewing = state.statusViewer;
    const status = viewing?.statuses[viewing.index];
    if (status && window.confirm(t('status.deleteThisStatus'))) deleteOwnStatus(status.id).catch(logBackgroundError('deleteViewedStatus'));
}

function closeStatusViewer() {
    const viewer = document.getElementById('status-viewer');
    if (!viewer || viewer.classList.contains('hidden')) return;
    dismissModalEntry('status', hideStatusViewer);
}

function hideStatusViewer() {
    clearTimeout(state.statusViewer?.timer);
    state.statusViewer = null;
    clearSecureCanvas(document.getElementById('status-viewer-image'));
    document.getElementById('status-viewer').classList.add('hidden');
    renderStatusBar();
}
