// ================= MODAL & CHAT =================
function updateProfilePresence(peerId, status) {
    if (state.activeModalPeerId !== peerId) return;
    const badge = document.getElementById('modal-online-badge');
    const styles = {
        checking: ['Checking...', 'bg-sky-500/10 text-sky-400 border-sky-500/30'],
        online: ['Online', 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'],
        absent: ['Abwesend', 'bg-amber-500/10 text-amber-400 border-amber-500/30'],
        offline: ['Offline', 'bg-slate-800 text-slate-400 border-slate-700']
    };
    const [label, classes] = styles[status];
    badge.textContent = label;
    badge.className = `px-2.5 py-0.5 rounded-full text-xs font-mono font-semibold flex items-center gap-1.5 border ${classes}`;
}

async function probePeerPresence(peerId) {
    const existing = state.presenceProbes[peerId];
    if (existing) clearTimeout(existing.timeout);
    if (!navigator.onLine || state.ws?.readyState !== WebSocket.OPEN) {
        updateProfilePresence(peerId, 'offline');
        return;
    }

    updateProfilePresence(peerId, 'checking');
    const nonce = window.crypto.randomUUID();
    const timeout = setTimeout(() => {
        delete state.presenceProbes[peerId];
        updateProfilePresence(peerId, 'absent');
    }, 8000);
    state.presenceProbes[peerId] = { nonce, timeout };
    await sendSecurePayload(peerId, { type: 'PRESENCE_PING', nonce });
}

function openProfileModal(peerId) {
    state.activeModalPeerId = peerId;
    const peer = state.peers.find(p => p.id === peerId);
    if (!peer) return;

    document.getElementById('profile-detail-modal').classList.remove('hidden');
    document.getElementById('modal-profile-name').textContent = peer.name || 'Peer';
    document.getElementById('modal-profile-id').textContent = peer.id;
    document.getElementById('modal-profile-img').src = peer.avatar || 'https://placehold.co/300x300/1e293b/ffffff?text=Peer';

    // SOFORTIGES LEEREN der alten Galerie, bevor neue Daten eintreffen
    const galleryContainer = document.getElementById('modal-gallery-container');
    if (galleryContainer) {
        galleryContainer.innerHTML = '';
        galleryContainer.classList.add('hidden');
        galleryContainer.classList.remove('flex');
    }

    updateProfilePresence(peerId, 'checking');
    const container = document.getElementById('modal-rendered-fields');
    container.innerHTML = '<div class="col-span-2 text-slate-500 text-center py-4"><i class="fa-solid fa-lock text-brand-500 mr-1"></i> Connecting securely to request full profile...</div>';

    if (peer.fullProfile) {
        renderProfileModalData(peer.fullProfile);
    } else {
        // Fordere das Profil an (wird ueber P2P oder Fallback-Cache geladen)
        // Fallback: Versuche gecachte Profildaten zu laden, falls vorhanden
        if (state.cachedProfiles[peerId]) {
            renderProfileModalData(state.cachedProfiles[peerId]);
        }
    }

    // Immer aktiv das neueste Profil anfragen (Handshake)
    sendSecurePayload(peerId, { type: 'PROFILE_REQUEST' }).catch(() => {});

    // SWARM FALLBACK: Wenn nach 800ms noch keine direkte Antwort kam, das Mesh befragen
    setTimeout(() => {
        if (state.activeModalPeerId !== peerId) return;
        const container = document.getElementById('modal-rendered-fields');
        if (container && container.innerHTML.includes('Connecting securely')) {
           const activePeers = Object.keys(state.dataChannels).filter(id => state.dataChannels[id].readyState === 'open');
           if (!activePeers.length) {
               logDebug(`Peer ${peerId} antwortet nicht und es gibt keinen offenen Kanal fuer eine Swarm-Suche.`);
               return;
           }
           logDebug(`Peer ${peerId} antwortet nicht direkt, starte Swarm-Suche ueber ${activePeers.length} Peer(s)...`);
           activePeers.forEach(swarmPeerId => {
               sendSecurePayload(swarmPeerId, { type: 'SWARM_PROFILE_REQUEST', targetNodeId: peerId }).catch(()=>{});
           });
        }
    }, 800);

    probePeerPresence(peerId).catch(error => logDebug(`Presence probe failed: ${error.message}`));
}

function renderProfileModalData(profile) {
    document.getElementById('modal-profile-name').textContent = profile.fields?.displayName || 'Peer';
    const container = document.getElementById('modal-rendered-fields');
    container.innerHTML = '';

    const galleryContainer = document.getElementById('modal-gallery-container');
    if (profile.gallery && profile.gallery.length > 0) {
        galleryContainer.innerHTML = '';
        galleryContainer.classList.remove('hidden');
        galleryContainer.classList.add('flex');
        processGalleryHandshake(state.activeModalPeerId, profile.gallery);
    } else {
        galleryContainer.innerHTML = '';
        galleryContainer.classList.add('hidden');
    }

    PROFILE_SCHEMA.forEach(field => {
        const value = profile.fields?.[field.key];
        if (value === undefined || value === null || value === '') return;
        const card = document.createElement('div');
        card.className = field.type === 'description' ? 'col-span-2 bg-slate-800 p-2 rounded' : 'bg-slate-800 p-2 rounded';
        const label = document.createElement('div');
        label.className = 'text-slate-400 font-bold';
        label.textContent = field.label;
        const content = document.createElement('div');
        content.className = 'text-slate-200';
        content.textContent = Array.isArray(value) ? value.join(', ') : String(value);
        card.append(label, content);
        container.appendChild(card);
    });
}

function closeProfileModal() {
    const probe = state.presenceProbes[state.activeModalPeerId];
    if (probe) {
        clearTimeout(probe.timeout);
        delete state.presenceProbes[state.activeModalPeerId];
    }
    document.getElementById('profile-detail-modal').classList.add('hidden');
    state.activeModalPeerId = null;
}

async function processGalleryHandshake(peerId, remoteGalleryMeta) {
    const container = document.getElementById('modal-gallery-container');
    for (const meta of remoteGalleryMeta) {
        // Abbruch, falls der User in der Zwischenzeit das Profil gewechselt hat!
        if (state.activeModalPeerId !== peerId) return;

        let imgEl = document.getElementById(`modal-img-${meta.id}`);
        if (!imgEl) {
            imgEl = document.createElement('div');
            imgEl.id = `modal-img-${meta.id}`;
            imgEl.className = 'h-24 w-24 rounded-xl border border-slate-700 bg-slate-800 animate-pulse shrink-0 flex items-center justify-center text-brand-500 text-xl overflow-hidden';
            imgEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
            container.appendChild(imgEl);
        }

        const localMedia = await loadMedia(meta.id);
        if (state.activeModalPeerId !== peerId) return;

        if (localMedia && localMedia.version === meta.version) {
            renderModalGalleryImage(meta.id, localMedia.data);
        } else {
            await new Promise(r => setTimeout(r, 200)); // Drosselung zum Schutz der P2P Leitung
            if (state.activeModalPeerId !== peerId) return;
            state.pendingImageRequests[`${peerId}:${meta.id}`] = meta.version;
            sendSecurePayload(peerId, { type: 'IMAGE_REQUEST', imageId: meta.id, version: meta.version }).catch(() => {});
        }
    }
}

function renderModalGalleryImage(imageId, base64) {
    const imgEl = document.getElementById(`modal-img-${imageId}`);
    if (!imgEl) return;
    if (!isSafeInlineImage(base64)) {
        imgEl.textContent = 'Invalid image';
        return;
    }
    imgEl.className = 'h-24 w-24 rounded-xl border border-slate-700 shrink-0 cursor-pointer hover:border-brand-500 transition overflow-hidden';
    imgEl.innerHTML = '';
    const image = document.createElement('img');
    image.src = base64;
    image.className = 'w-full h-full object-cover';
    image.alt = '';
    imgEl.appendChild(image);
    imgEl.onclick = () => { document.getElementById('modal-profile-img').src = base64; };
}

function isSafeInlineImage(value) {
    return typeof value === 'string'
        && /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(value);
}

function launchChatFromModal() {
    if (!state.activeModalPeerId) return;
    const peerId = state.activeModalPeerId;
    closeProfileModal();
    openChatWithPeer(peerId);
}

async function openChatWithPeer(peerId) {
    const peer = getPeerPresentation(peerId);
    state.activeChatPeerId = peerId;
    await loadChatHistory(peerId);
    switchTab('chat');
    document.getElementById('chat-peer-name').textContent = peer.name || 'Peer';
    document.getElementById('chat-connection-type').textContent = 'Encrypted WebRTC DataChannel';
    const avatar = document.getElementById('chat-peer-avatar');
    avatar.innerHTML = '';
    const image = document.createElement('img');
    image.src = peer.avatar || 'https://placehold.co/80x80/1e293b/ffffff?text=P';
    image.alt = '';
    image.className = 'w-full h-full object-cover';
    avatar.appendChild(image);
    renderActivePeerList();
    renderChatHistory();
    updateChatActionButtons();
    updateChatLayout();
    if (!isPeerBlocked(peerId)) initiateP2PConnection(peerId).catch(() => {});
}

// Auf Smartphones zeigt der Chat-Tab entweder die Liste oder den Vollbild-Chat.
function updateChatLayout() {
    const view = document.getElementById('view-chat');
    if (view) view.classList.toggle('chat-open', Boolean(state.activeChatPeerId));
}

function resetActiveChat(placeholderText) {
    state.activeChatPeerId = null;
    document.getElementById('chat-peer-name').textContent = 'Kein Chat ausgewaehlt';
    document.getElementById('chat-connection-type').textContent = 'Select a conversation';
    document.getElementById('chat-peer-avatar').textContent = '?';
    const messages = document.getElementById('chat-messages');
    messages.innerHTML = '';
    const placeholder = document.createElement('div');
    placeholder.className = 'text-center text-xs text-slate-500 my-8';
    placeholder.textContent = placeholderText;
    messages.appendChild(placeholder);
    updateChatActionButtons();
    updateChatLayout();
    renderActivePeerList();
}

function leaveActiveChat() {
    resetActiveChat('Waehle einen Chat aus oder starte einen im Grid.');
}

function updateChatActionButtons() {
    const peerId = state.activeChatPeerId;
    const deleteButton = document.getElementById('delete-chat-btn');
    const blockButton = document.getElementById('block-peer-btn');
    const input = document.getElementById('chat-input');
    const sendButton = document.getElementById('send-chat-btn');
    if (!peerId) {
        deleteButton.classList.add('hidden');
        blockButton.classList.add('hidden');
        input.disabled = true;
        sendButton.disabled = true;
        return;
    }
    const blocked = isPeerBlocked(peerId);
    deleteButton.classList.toggle('hidden', blocked);
    blockButton.classList.remove('hidden');
    blockButton.textContent = blocked ? 'Entblocken' : 'Blockieren';
    input.disabled = blocked;
    sendButton.disabled = blocked;
    if (blocked) {
        updateChatConnectionStatus(peerId, 'Blocked', 'bg-red-500/10 text-red-400 border-red-500/30');
    }
}

async function deleteActiveChat() {
    const peerId = state.activeChatPeerId;
    if (!peerId || !window.confirm('Diesen Chat lokal und aus dem Router-Cache loeschen?')) return;
    try {
        // Sende den Wipe-Befehl an den Peer, bevor wir den Chat lokal schliessen
        const operation = {
            operationId: `wipe:${window.crypto.randomUUID()}`,
            type: 'CHAT_WIPE',
            actorId: state.myProfile.id,
            createdAt: Date.now()
        };
        sendSecurePayload(peerId, { type: 'CHAT_OPERATION', operation });

        // Garantiere, dass das Kommando gesendet wird, bevor der Channel gekillt wird
        if (typeof flushPeerQueueToCache === 'function') await flushPeerQueueToCache(peerId);
        await new Promise(resolve => setTimeout(resolve, 500));

        await storeChatControl(peerId, 'DELETE_CHAT');
        resetActiveChat('Chat geloescht.');
        showToast('Chat und zwischengespeicherte Router-Nachrichten wurden geloescht.', 'success');
    } catch (error) {
        showToast(`Chat konnte nicht geloescht werden: ${error.message}`, 'error');
    }
}

async function toggleActivePeerBlock() {
    const peerId = state.activeChatPeerId;
    if (!peerId) return;
    try {
        if (isPeerBlocked(peerId)) {
            const response = await fetch(
                `${API_BASE}/api/chat-controls/${encodeURIComponent(state.myProfile.id)}/${encodeURIComponent(peerId)}/block`,
                { method: 'DELETE', headers: peerAuthHeaders() }
            );
            if (!response.ok) throw new Error(`Chat control API returned ${response.status}.`);
            await refreshChatControls();

            // UNHIDE senden, damit du beim Peer wieder im Grid auftauchst
            const operation = {
                operationId: `unhide:${window.crypto.randomUUID()}`,
                type: 'PEER_UNHIDE',
                actorId: state.myProfile.id,
                createdAt: Date.now()
            };
            sendSecurePayload(peerId, { type: 'CHAT_OPERATION', operation }).catch(() => {});

            initiateP2PConnection(peerId).catch(() => {});
            showToast('Peer wurde entblockt.', 'success');
        } else {
            if (!window.confirm('Diesen Peer blockieren und den Chat loeschen?')) return;

            // Sende Wipe-Befehl an den Peer, bevor die lokale Blockierung weitere P2P-Payloads verhindert
            const operation = {
                operationId: `wipe:${window.crypto.randomUUID()}`,
                type: 'CHAT_WIPE',
                actorId: state.myProfile.id,
                hidePeer: true,
                createdAt: Date.now()
            };
            sendSecurePayload(peerId, { type: 'CHAT_OPERATION', operation });

            // Garantiere Zustellung ueber Cloud Cache oder P2P, bevor Block aktiv wird
            if (typeof flushPeerQueueToCache === 'function') await flushPeerQueueToCache(peerId);
            await new Promise(resolve => setTimeout(resolve, 500));

            await storeChatControl(peerId, 'BLOCK');
            showToast('Peer wurde dauerhaft blockiert.', 'success');
        }
        updateChatActionButtons();
    } catch (error) {
        showToast(`Blockierung konnte nicht aktualisiert werden: ${error.message}`, 'error');
    }
}

async function sendChatMessage(snapData = null) {
    const input = document.getElementById('chat-input');
    const text = input.value.trim() || (snapData ? '? Snap' : '');
    if ((!text && !snapData) || !state.activeChatPeerId || isPeerBlocked(state.activeChatPeerId)) return;

    const peerId = state.activeChatPeerId;
    const message = {
        id: window.crypto.randomUUID(),
        senderId: state.myProfile.id,
        text,
        snapData,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        createdAt: Date.now(),
        deliveredVia: 'Establishing secure channel...'
    };
    if (!state.chats[peerId]) state.chats[peerId] = [];
    state.chats[peerId].push(message);
    rememberChatPeer(peerId);
    await persistChatMessage(peerId, message);
    const operation = createPutOperation(peerId, message);
    await persistChatOperation(operation);
    input.value = '';
    renderChatHistory();

    if (state.sessionKeys[peerId]) await beginChatSync(peerId);
    await sendSecurePayload(peerId, {
        type: 'CHAT_OPERATION',
        operation: {
            ...operation,
            peerId: undefined
        }
    }, (deliveryPath) => {
        message.deliveredVia = deliveryPath === 'cache'
            ? 'Encrypted Path C'
            : deliveryPath === 'rejected'
                ? 'Delivery rejected'
                : 'E2EE P2P';
        persistChatMessage(peerId, message).catch(error => logDebug(`Could not update chat message: ${error.message}`));
        renderChatHistory();
    });
}

async function receiveChatMessage(peerId, payload) {
    const operation = {
        operationId: `put:${payload.id}`,
        type: 'MESSAGE_PUT',
        messageId: payload.id,
        actorId: peerId,
        createdAt: payload.createdAt || Date.now(),
        message: {
            id: payload.id,
            senderId: peerId,
            text: payload.text,
            snapData: payload.snapData,
            timestamp: payload.timestamp,
            createdAt: payload.createdAt || Date.now()
        }
    };
    const applied = await applyChatOperation(peerId, operation);
    if (applied) {
        showToast(`New encrypted message from ${state.peers.find(peer => peer.id === peerId)?.name || 'peer'}.`, 'info');
    }
}

async function deleteChatMessage(messageId) {
    const peerId = state.activeChatPeerId;
    const message = state.chats[peerId]?.find(item => item.id === messageId);
    if (!peerId || !message || message.deleted || message.senderId !== state.myProfile.id) return;

    const operation = {
        operationId: `delete:${messageId}:${window.crypto.randomUUID()}`,
        peerId,
        type: 'MESSAGE_DELETE',
        messageId,
        actorId: state.myProfile.id,
        originalSenderId: message.senderId,
        messageCreatedAt: message.createdAt,
        timestamp: message.timestamp,
        createdAt: Date.now()
    };
    await applyChatOperation(peerId, operation);
    const { peerId: _localPeerId, ...sharedOperation } = operation;
    await sendSecurePayload(peerId, {
        type: 'CHAT_OPERATION',
        operation: sharedOperation
    });
}

function renderChatHistory() {
    const container = document.getElementById('chat-messages');
    if (!container || !state.activeChatPeerId) return;
    const msgs = state.chats[state.activeChatPeerId] || [];
    container.innerHTML = '';
    if (msgs.length === 0) {
        container.innerHTML = '<div class="text-center text-xs text-slate-500 my-8">Noch keine Nachrichten. Sag hallo!</div>';
        return;
    }
    msgs.forEach(message => {
        const isMine = message.senderId === state.myProfile.id;
        const row = document.createElement('div');
        row.className = `flex flex-col ${isMine ? 'items-end' : 'items-start'}`;
        const bubble = document.createElement('div');
        bubble.className = `max-w-[80%] rounded-2xl px-4 py-2 text-xs overflow-hidden ${message.deleted ? 'bg-slate-900 text-slate-500 border border-slate-800 italic' : isMine ? 'bg-brand-600 text-white rounded-br-none' : 'bg-slate-800 text-slate-100 rounded-bl-none'}`;

        if (message.deleted) {
            bubble.textContent = 'Nachricht geloescht';
        } else if (message.snapData) {
            if (isSafeInlineImage(message.snapData)) {
                const image = document.createElement('img');
                image.src = message.snapData;
                image.alt = '';
                image.className = 'w-48 sm:w-64 rounded-xl mb-1.5 border border-slate-900/50';
                bubble.appendChild(image);
            }
            const text = document.createElement('div');
            text.className = 'opacity-90';
            text.textContent = message.text || '';
            bubble.appendChild(text);
        } else {
            bubble.textContent = message.text;
        }
        const meta = document.createElement('div');
        meta.className = 'text-[9px] text-slate-500 mt-0.5 flex items-center gap-2';
        const status = document.createElement('span');
        status.textContent = message.timestamp;
        const deliveryPath = document.createElement('span');
        deliveryPath.className = 'debug-only';
        deliveryPath.textContent = message.deliveredVia;
        meta.append(status, deliveryPath);
        if (isMine && !message.deleted) {
            const deleteButton = document.createElement('button');
            deleteButton.type = 'button';
            deleteButton.className = 'text-red-400 hover:text-red-300 transition';
            deleteButton.textContent = 'Loeschen';
            deleteButton.onclick = () => deleteChatMessage(message.id);
            meta.appendChild(deleteButton);
        }
        row.append(bubble, meta);
        container.appendChild(row);
    });
    container.scrollTop = container.scrollHeight;
}

function updateChatConnectionStatus(peerId, text, classes) {
    if (state.activeChatPeerId !== peerId) return;
    const pill = document.getElementById('connection-status-pill');
    pill.textContent = text;
    pill.className = `debug-only text-xs px-2.5 py-1 rounded-full border font-mono whitespace-nowrap ${classes}`;
}

async function openSnapUploadModal() {
    if (!state.activeChatPeerId || isPeerBlocked(state.activeChatPeerId)) {
        showToast('Bitte waehle zuerst einen aktiven Chat aus.', 'warning');
        return;
    }
    try {
        state.mediaStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
        const video = document.getElementById('snap-video-preview');
        video.srcObject = state.mediaStream;
        document.getElementById('snap-capture-modal').classList.remove('hidden');
    } catch (error) {
        showToast('Kamera-Zugriff verweigert oder nicht verfuegbar.', 'error');
        logDebug(`Camera error: ${error.message}`);
    }
}

function closeSnapModal() {
    if (state.mediaStream) {
        state.mediaStream.getTracks().forEach(track => track.stop());
        state.mediaStream = null;
    }
    document.getElementById('snap-video-preview').srcObject = null;
    document.getElementById('snap-capture-modal').classList.add('hidden');
}

async function captureAndSendSnap() {
    const video = document.getElementById('snap-video-preview');
    const canvas = document.getElementById('snap-canvas-capture');
    if (!video.videoWidth) return;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);

    const imageData = canvas.toDataURL('image/jpeg', 0.8);
    closeSnapModal();
    await sendChatMessage(imageData);
}
