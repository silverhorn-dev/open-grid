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

    // Chat-Partner: Status kommt ohne P2P-Probe vom Server.
    if (peerId in state.peerPresence) {
        updateProfilePresence(peerId, isPeerOnline(peerId) ? 'online' : 'offline');
        return;
    }
    updateProfilePresence(peerId, 'checking');
    const nonce = window.crypto.randomUUID();
    const timeout = setTimeout(() => {
        delete state.presenceProbes[peerId];
        updateProfilePresence(peerId, 'absent');
    }, 4000);
    state.presenceProbes[peerId] = { nonce, timeout };
    await sendSecurePayload(peerId, { type: 'PRESENCE_PING', nonce });
}

function openProfileModal(peerId) {
    state.activeModalPeerId = peerId;
    const peer = state.peers.find(p => p.id === peerId) || getPeerPresentation(peerId);
    if (!peer) return;

    document.getElementById('profile-detail-modal').classList.remove('hidden');
    pushModalEntry('profile', hideProfileModal);
    document.getElementById('modal-profile-name').textContent = peer.name || HIDDEN_PEER_NAME;
    document.getElementById('modal-profile-id').textContent = peer.id;
    document.getElementById('modal-profile-img').src = localAvatar(peer.avatar);
    renderProfileMatchActions(peerId);

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
    sendSecurePayload(peerId, { type: 'PROFILE_REQUEST' }).catch(logBackgroundError('openProfileModal'));

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
    document.getElementById('modal-profile-name').textContent = profile.fields?.displayName || HIDDEN_PEER_NAME;
    if (isSafeInlineImage(profile.avatar)) document.getElementById('modal-profile-img').src = profile.avatar;
    const container = document.getElementById('modal-rendered-fields');
    container.innerHTML = '';
    renderProfileMatchActions(state.activeModalPeerId);
    if (profile.restricted && !isMatched(state.activeModalPeerId)) {
        const notice = document.createElement('div');
        notice.className = 'col-span-2 bg-slate-800/60 border border-slate-700 p-2 rounded text-slate-300 flex items-center gap-2';
        notice.innerHTML = '<i class="fa-solid fa-lock text-orange-300"></i>';
        notice.appendChild(document.createTextNode(profile.visibility === 3
            ? 'Dieses Profil ist verborgen. Nach einem Match siehst du alles.'
            : 'Weitere Angaben und Bilder siehst du nach einem Match.'));
        container.appendChild(notice);
    }

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

    // Felder in Schema-Reihenfolge, danach unbekannte Felder aus dem Schema des Partners.
    const knownKeys = PROFILE_SCHEMA.map(field => field.key);
    const extraKeys = Object.keys(profile.fields || {}).filter(key => key !== 'displayName' && !knownKeys.includes(key));
    [...PROFILE_SCHEMA, ...extraKeys.map(key => findProfileField(key) || { key, label: key, type: 'string' })].forEach(field => {
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
    dismissModalEntry('profile', hideProfileModal);
}

function hideProfileModal() {
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
            sendSecurePayload(peerId, { type: 'IMAGE_REQUEST', imageId: meta.id, version: meta.version }).catch(logBackgroundError('processGalleryHandshake'));
            // Antwortet der Besitzer nicht, Kopien aus dem Schwarm holen (Hash aus dem signierten Profil).
            setTimeout(() => {
                if (state.pendingImageRequests[`${peerId}:${meta.id}`] === meta.version) requestGalleryImageFromSwarm(peerId, meta);
            }, SWARM_FALLBACK_MS);
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
    imgEl.dataset.viewerImage = 'true';
    imgEl.onclick = () => openProfileImageViewer(base64);
}

// Profilbild plus alle schon geladenen Galeriebilder des offenen Profils.
function openProfileImageViewer(startImage) {
    const avatar = document.getElementById('modal-profile-img').src;
    const gallery = [...document.querySelectorAll('#modal-gallery-container [data-viewer-image] img')].map(image => image.src);
    const images = [avatar, ...gallery].filter((image, index, all) => isSafeInlineImage(image) && all.indexOf(image) === index);
    openImageViewer(images, Math.max(0, images.indexOf(startImage)));
}

function isSafeInlineImage(value) {
    return typeof value === 'string'
        && /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(value);
}

function launchChatFromModal() {
    if (!state.activeModalPeerId) return;
    const peerId = state.activeModalPeerId;
    hideModalForNavigation('profile', hideProfileModal);
    openChatWithPeer(peerId);
}

async function openChatWithPeer(peerId) {
    if (state.activeChatPeerId !== peerId) resetChatTools();
    state.activeChatPeerId = peerId;
    await loadChatHistory(peerId);
    switchTab('chat');
    renderChatPeerIndicator();
    renderChatPeerHeader(peerId);
    document.getElementById('chat-connection-type').textContent = 'Encrypted WebRTC DataChannel';
    renderActivePeerList();
    renderChatHistory();
    updateChatActionButtons();
    updateChatLayout();
    if (!isPeerBlocked(peerId)) initiateP2PConnection(peerId).catch(logBackgroundError('openChatWithPeer'));
}

// Auf Smartphones zeigt der Chat-Tab entweder die Liste oder den Vollbild-Chat.
function updateChatLayout() {
    const view = document.getElementById('view-chat');
    if (view) view.classList.toggle('chat-open', Boolean(state.activeChatPeerId));
}

function resetActiveChat(placeholderText) {
    state.activeChatPeerId = null;
    resetChatTools();
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
    renderChatPeerIndicator();
    syncChatFocus();
    if (!state.applyingRoute && window.location.pathname.startsWith('/chat/')) replaceRoute('/chat');
}

// Kam man aus der Chatliste, fuehrt "Zurueck" dorthin; sonst wird der Chat-Eintrag ersetzt.
function leaveActiveChat() {
    if (!state.applyingRoute && window.history.state?.from === '/chat' && window.location.pathname.startsWith('/chat/')) {
        window.history.back();
        return;
    }
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
    document.getElementById('block-peer-label').textContent = blocked ? 'Entblocken' : 'Blockieren';
    input.disabled = blocked;
    sendButton.disabled = blocked;
    if (blocked) {
        updateChatConnectionStatus(peerId, 'Blocked', 'bg-red-500/10 text-red-400 border-red-500/30');
        return;
    }
    renderChatAllowance();
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
            subscribePresence();

            // UNHIDE senden, damit du beim Peer wieder im Grid auftauchst
            const operation = {
                operationId: `unhide:${window.crypto.randomUUID()}`,
                type: 'PEER_UNHIDE',
                actorId: state.myProfile.id,
                createdAt: Date.now()
            };
            sendSecurePayload(peerId, { type: 'CHAT_OPERATION', operation }).catch(logBackgroundError('toggleActivePeerBlock'));

            initiateP2PConnection(peerId).catch(logBackgroundError('toggleActivePeerBlock'));
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

const DELIVERY_PATH_LABELS = {
    p2p: 'E2EE P2P',
    cache: 'Encrypted Path C',
    rejected: 'Delivery rejected',
    pending: 'Pending'
};

// Nachrichtenfeld waechst mit dem Text bis CHAT_INPUT_MAX_LINES Zeilen, danach scrollt es.
const CHAT_INPUT_MAX_LINES = 5;

function fitChatInput(input) {
    if (!input) return;
    const style = getComputedStyle(input);
    const lineHeight = parseFloat(style.lineHeight) || 20;
    const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    const maxHeight = lineHeight * CHAT_INPUT_MAX_LINES + padding + border;
    input.style.height = 'auto';
    const height = Math.min(input.scrollHeight + border, maxHeight);
    input.style.height = `${height}px`;
    input.style.overflowY = input.scrollHeight + border > maxHeight ? 'auto' : 'hidden';
}

function isCoarsePointer() {
    return Boolean(window.matchMedia?.('(pointer: coarse)').matches);
}

// Ohne Anhang kommt der Text aus dem Eingabefeld; Snaps und Alben bringen eine eigene Bildunterschrift mit.
async function sendChatMessage(snapData = null, caption = '', album = null, secureSnap = null) {
    const input = document.getElementById('chat-input');
    const hasAttachment = Boolean(snapData || album || secureSnap);
    // Chat-Berechtigungen des anderen (nur Anzeige; der Empfaenger setzt sie selbst durch).
    const allowance = state.activeChatPeerId ? getPeerChatAllowance(state.activeChatPeerId) : null;
    if (allowance && (!allowance.allowed || (hasAttachment && !allowance.images))) {
        showToast(allowance.reason || 'Bilder sind erst nach einem Match erlaubt.', 'info');
        return;
    }
    const text = hasAttachment ? String(caption || '').trim() : input.value.trim();
    if ((!text && !hasAttachment) || !state.activeChatPeerId || isPeerBlocked(state.activeChatPeerId)) return;

    const peerId = state.activeChatPeerId;
    const message = {
        id: window.crypto.randomUUID(),
        senderId: state.myProfile.id,
        text,
        snapData,
        // Neue normale Snaps: einmal ansehen, einmal wiederholen, nur gespeichert bleibt er.
        snapMode: snapData ? 'replay' : undefined,
        album: album || undefined,
        secureSnap: secureSnap || undefined,
        replyTo: buildReplyReference(peerId, state.replyToMessageId),
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
    syncChatGate();
    if (!hasAttachment) {
        input.value = '';
        fitChatInput(input);
    }
    state.replyToMessageId = null;
    renderReplyBar();
    renderChatHistory();

    if (state.sessionKeys[peerId]) await beginChatSync(peerId);
    await sendSecurePayload(peerId, {
        type: 'CHAT_OPERATION',
        operation: {
            ...operation,
            peerId: undefined
        }
    }, (deliveryPath, details = {}) => {
        message.deliveredVia = DELIVERY_PATH_LABELS[deliveryPath] || 'E2EE P2P';
        // Path C haelt die Nachricht nur bis zum Ablauf der Queue-TTL.
        if (deliveryPath === 'cache' && details.expiresAt) message.cacheExpiresAt = details.expiresAt;
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
    // Zurueckgehaltene Nachrichten (Chat-Berechtigungen) erscheinen erst nach einem Match.
    const allMessages = (state.chats[state.activeChatPeerId] || []).filter(message => !message.held);
    const msgs = filterChatMessages(allMessages);
    container.innerHTML = '';
    if (allMessages.length === 0) {
        container.innerHTML = '<div class="text-center text-xs text-slate-500 my-8">Noch keine Nachrichten. Sag hallo!</div>';
        return;
    }
    if (msgs.length === 0) {
        container.innerHTML = '<div class="text-center text-xs text-slate-500 my-8">Keine passenden Nachrichten.</div>';
        return;
    }
    const filtering = Boolean(state.chatSearch) || state.chatStarredOnly;
    msgs.forEach(message => {
        const isMine = message.senderId === state.myProfile.id;
        const row = document.createElement('div');
        row.id = `chat-message-${message.id}`;
        row.className = `flex flex-col ${isMine ? 'items-end' : 'items-start'}`;
        if (message.replyTo && !message.deleted) row.appendChild(renderReplyQuote(message.replyTo, isMine));
        const bubble = document.createElement('div');
        bubble.className = `chat-bubble whitespace-pre-wrap break-words max-w-[80%] rounded-2xl px-4 py-2 overflow-hidden ${message.deleted ? 'bg-slate-900 text-slate-500 border border-slate-800 italic' : isMine ? 'bg-brand-600 text-white rounded-br-none' : 'bg-slate-800 text-slate-100 rounded-bl-none'}`;

        if (message.deleted) {
            bubble.textContent = 'Nachricht geloescht';
        } else if (message.secureSnap) {
            renderSecureSnapMessage(bubble, message, isMine);
            if (message.text) {
                const caption = document.createElement('div');
                caption.className = 'opacity-90 mt-1';
                caption.textContent = message.text;
                bubble.appendChild(caption);
            }
        } else if (message.album) {
            renderAlbumMessage(bubble, message.album);
            if (message.text) {
                const caption = document.createElement('div');
                caption.className = 'opacity-90 mt-1';
                caption.textContent = message.text;
                bubble.appendChild(caption);
            }
        } else if (message.snapMode === 'replay' && !message.snapSaved) {
            renderReplaySnapMessage(bubble, message, isMine);
        } else if (message.snapData) {
            if (isSafeInlineImage(message.snapData)) {
                const image = createSecureImage(message.snapData, 'w-48 sm:w-64 rounded-xl mb-1.5 border border-slate-900/50 cursor-zoom-in');
                image.onclick = event => {
                    event.stopPropagation();
                    openChatImageViewer(message.id);
                };
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
        const deliveryHint = describePendingDelivery(message, isMine);
        if (deliveryHint) {
            const hint = document.createElement('span');
            hint.className = 'text-amber-400';
            hint.textContent = deliveryHint;
            meta.appendChild(hint);
        }
        // Bubble + Aktionsleiste, die zur Haelfte ueber der Nachricht sitzt.
        const bubbleWrap = document.createElement('div');
        bubbleWrap.className = `chat-bubble-wrap ${isMine ? 'is-mine' : 'is-theirs'} relative max-w-[80%] flex ${isMine ? 'justify-end' : 'justify-start'}`;
        bubble.classList.remove('max-w-[80%]');
        bubbleWrap.appendChild(bubble);
        if (!message.deleted) bubbleWrap.appendChild(renderMessageActions(message, isMine, row));
        row.append(bubbleWrap);
        // Reaktionen sitzen auf der unteren Kante der Nachricht.
        const reactions = renderReactions(message, isMine);
        if (reactions) {
            bubbleWrap.appendChild(reactions);
            row.classList.add('has-reactions');
        }
        row.appendChild(meta);
        container.appendChild(row);
    });
    if (!filtering) container.scrollTop = container.scrollHeight;
    renderChatAllowance();
}

// Path C haelt Nachrichten nur bis zur Queue-TTL. Danach liefert erst der naechste direkte Chat-Sync aus.
function describePendingDelivery(message, isMine) {
    if (!isMine || message.deleted || message.deliveryConfirmed) return null;
    if (message.cacheExpiresAt && Date.now() > message.cacheExpiresAt) {
        return 'Nicht abgeholt - wird bei der naechsten direkten Verbindung zugestellt';
    }
    if (message.deliveredVia === 'Pending') return 'Wartet auf Verbindung';
    return null;
}
