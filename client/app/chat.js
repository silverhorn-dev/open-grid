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
    const peer = getPeerPresentation(peerId);
    if (state.activeChatPeerId !== peerId) resetChatTools();
    state.activeChatPeerId = peerId;
    await loadChatHistory(peerId);
    switchTab('chat');
    renderChatPeerIndicator();
    document.getElementById('chat-peer-name').textContent = peer.name || 'Peer';
    document.getElementById('chat-connection-type').textContent = 'Encrypted WebRTC DataChannel';
    const avatar = document.getElementById('chat-peer-avatar');
    avatar.innerHTML = '';
    const image = document.createElement('img');
    image.src = localAvatar(peer.avatar);
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

const DELIVERY_PATH_LABELS = {
    p2p: 'E2EE P2P',
    cache: 'Encrypted Path C',
    rejected: 'Delivery rejected',
    pending: 'Pending'
};

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
    if (!hasAttachment) input.value = '';
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
        bubble.className = `chat-bubble max-w-[80%] rounded-2xl px-4 py-2 overflow-hidden ${message.deleted ? 'bg-slate-900 text-slate-500 border border-slate-800 italic' : isMine ? 'bg-brand-600 text-white rounded-br-none' : 'bg-slate-800 text-slate-100 rounded-bl-none'}`;

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
                const image = document.createElement('img');
                image.src = message.snapData;
                image.alt = '';
                image.className = 'w-48 sm:w-64 rounded-xl mb-1.5 border border-slate-900/50 cursor-zoom-in';
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

// ================= CHAT-FUNKTIONEN: ANTWORTEN, REAGIEREN, MARKIEREN, SUCHEN =================
function messagePreview(message) {
    if (message.secureSnap) return 'Secure Snap';
    if (message.album) return `Album: ${message.album.name}`;
    if (message.snapData || message.snapMode) return message.text ? `Snap: ${message.text}` : 'Snap';
    const text = String(message.text || '');
    return text.length > REPLY_PREVIEW_LENGTH ? `${text.slice(0, REPLY_PREVIEW_LENGTH)}...` : text;
}

function buildReplyReference(peerId, messageId) {
    const original = messageId ? state.chats[peerId]?.find(item => item.id === messageId) : null;
    if (!original || original.deleted) return undefined;
    return { messageId: original.id, senderId: original.senderId, preview: messagePreview(original) };
}

function startReply(messageId) {
    state.replyToMessageId = messageId;
    renderReplyBar();
    document.getElementById('chat-input')?.focus();
}

function cancelReply() {
    state.replyToMessageId = null;
    renderReplyBar();
}

function renderReplyBar() {
    const bar = document.getElementById('chat-reply-bar');
    if (!bar) return;
    const reference = buildReplyReference(state.activeChatPeerId, state.replyToMessageId);
    bar.classList.toggle('hidden', !reference);
    if (!reference) return;
    const author = reference.senderId === state.myProfile.id ? 'dir selbst' : getPeerPresentation(reference.senderId).name || 'Peer';
    document.getElementById('chat-reply-author').textContent = `Antwort an ${author}`;
    document.getElementById('chat-reply-preview').textContent = reference.preview;
}

function renderReplyQuote(replyTo, isMine) {
    const quote = document.createElement('button');
    quote.type = 'button';
    quote.className = `max-w-[80%] mb-0.5 px-3 py-1 rounded-xl border-l-2 border-brand-400 bg-slate-800/60 text-[11px] text-slate-400 text-left truncate ${isMine ? 'self-end' : 'self-start'}`;
    const author = replyTo.senderId === state.myProfile.id ? 'Du' : getPeerPresentation(replyTo.senderId).name || 'Peer';
    quote.textContent = `${author}: ${replyTo.preview}`;
    quote.onclick = () => scrollToChatMessage(replyTo.messageId);
    return quote;
}

function scrollToChatMessage(messageId) {
    const target = document.getElementById(`chat-message-${messageId}`);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('chat-message-highlight');
    setTimeout(() => target.classList.remove('chat-message-highlight'), 1500);
}

// Auf Touch-Geraeten blendet ein Tipp auf die Nachricht die Aktionen ein, am Desktop das Hovern.
function toggleMessageActions(row) {
    const wasOpen = row.classList.contains('actions-open');
    closeMessageActions();
    if (!wasOpen) row.classList.add('actions-open');
}

function closeMessageActions() {
    document.querySelectorAll('#chat-messages .actions-open').forEach(element => element.classList.remove('actions-open'));
}

// Tipp ausserhalb schliesst offene Aktionsleisten.
document.addEventListener('click', event => {
    if (!event.target.closest?.('.actions-open')) closeMessageActions();
});

function openChatImageViewer(messageId) {
    const snaps = (state.chats[state.activeChatPeerId] || [])
        .filter(message => !message.deleted && isInlineSnap(message));
    openImageViewer(snaps.map(message => message.snapData), snaps.findIndex(message => message.id === messageId));
}

// Eigene Nachrichten rechtsbuendig, fremde linksbuendig: die Leiste waechst zur Bildschirmmitte.
// Auf Touch-Geraeten ist der Pfeil das aeussere Element der Leiste: er oeffnet und schliesst sie.
function renderMessageActions(message, isMine, row) {
    const actions = document.createElement('div');
    actions.className = `message-actions absolute -top-5 ${isMine ? 'right-0' : 'left-0'} z-10 flex items-center gap-0.5 rounded-full border border-slate-700 bg-slate-900/95 px-1 py-0.5 shadow-lg text-slate-300`;
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'message-actions-toggle w-6 h-6 rounded-full items-center justify-center text-[10px] text-slate-200 bg-black/25';
    toggle.setAttribute('aria-label', 'Aktionen ein- oder ausblenden');
    toggle.innerHTML = '<i class="fa-solid fa-chevron-down transition-transform"></i>';
    toggle.onclick = event => {
        event.stopPropagation();
        toggleMessageActions(row);
    };
    if (!isMine) actions.appendChild(toggle);
    const addAction = (iconClass, title, onClick, extraClass = 'hover:text-slate-50 hover:bg-slate-800') => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `message-action w-9 h-9 rounded-full flex items-center justify-center text-base transition ${extraClass}`;
        button.title = title;
        button.setAttribute('aria-label', title);
        button.onclick = event => {
            event.stopPropagation();
            onClick(event);
        };
        const icon = document.createElement('i');
        icon.className = iconClass;
        button.appendChild(icon);
        actions.appendChild(button);
    };
    addAction('fa-solid fa-reply', 'Antworten', () => startReply(message.id));
    if (message.text) addAction('fa-regular fa-copy', 'Kopieren', () => copyMessageText(message));
    addAction('fa-regular fa-face-smile', 'Reagieren', event => toggleReactionPicker(event.currentTarget, message.id));
    addAction(message.starred ? 'fa-solid fa-star text-amber-400' : 'fa-regular fa-star', message.starred ? 'Markierung entfernen' : 'Fuer dich markieren', () => toggleMessageStar(message.id));
    if (isMine) addAction('fa-solid fa-trash', 'Loeschen', () => deleteChatMessage(message.id), 'text-red-400 hover:text-red-300 hover:bg-slate-800');
    if (isMine) actions.appendChild(toggle);
    return actions;
}

async function copyMessageText(message) {
    try {
        await navigator.clipboard.writeText(message.text || '');
        showToast('Text kopiert.', 'success');
    } catch {
        showToast('Kopieren nicht moeglich.', 'error');
    }
    closeMessageActions();
}

function toggleReactionPicker(anchor, messageId) {
    const existing = document.getElementById('reaction-picker');
    if (existing) {
        const sameMessage = existing.dataset.messageId === messageId;
        existing.remove();
        if (sameMessage) return;
    }
    const picker = document.createElement('div');
    picker.id = 'reaction-picker';
    picker.dataset.messageId = messageId;
    picker.className = 'flex gap-1 bg-slate-900 border border-slate-700 rounded-full px-2 py-1 shadow-lg';
    REACTION_EMOJIS.forEach(emoji => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'text-base leading-none hover:scale-125 transition';
        button.textContent = emoji;
        button.onclick = () => {
            picker.remove();
            reactToMessage(messageId, emoji);
        };
        picker.appendChild(button);
    });
    anchor.closest('[id^="chat-message-"]').appendChild(picker);
}

function renderReactions(message, isMine) {
    const entries = Object.entries(message.reactions || {}).filter(([, reaction]) => reaction?.emoji);
    if (!entries.length || message.deleted) return null;
    const counts = new Map();
    entries.forEach(([actorId, reaction]) => {
        const item = counts.get(reaction.emoji) || { count: 0, mine: false };
        item.count += 1;
        item.mine = item.mine || actorId === state.myProfile.id;
        counts.set(reaction.emoji, item);
    });
    const row = document.createElement('div');
    // Eigene Nachrichten: unten links, fremde: unten rechts (Richtung Bildschirmmitte).
    row.className = `message-reactions absolute -bottom-4 ${isMine ? 'left-2' : 'right-2'} z-[5] flex gap-1`;
    counts.forEach(({ count, mine }, emoji) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = `text-sm leading-none px-2 py-1 rounded-full border shadow ${mine ? 'bg-brand-900 border-brand-500/60' : 'bg-slate-900 border-slate-700'}`;
        chip.textContent = count > 1 ? `${emoji} ${count}` : emoji;
        chip.onclick = () => reactToMessage(message.id, emoji);
        row.appendChild(chip);
    });
    return row;
}

// Gleiche Reaktion erneut = entfernen.
async function reactToMessage(messageId, emoji) {
    const peerId = state.activeChatPeerId;
    const message = state.chats[peerId]?.find(item => item.id === messageId);
    if (!peerId || !message || message.deleted || isPeerBlocked(peerId)) return;
    const current = message.reactions?.[state.myProfile.id]?.emoji || null;
    const operation = {
        operationId: `react:${messageId}:${window.crypto.randomUUID()}`,
        peerId,
        type: 'MESSAGE_REACT',
        messageId,
        actorId: state.myProfile.id,
        emoji: current === emoji ? null : emoji,
        createdAt: Date.now()
    };
    await applyChatOperation(peerId, operation);
    const { peerId: _localPeerId, ...sharedOperation } = operation;
    await sendSecurePayload(peerId, { type: 'CHAT_OPERATION', operation: sharedOperation });
}

// Markierungen sind rein lokal und werden nicht synchronisiert.
async function toggleMessageStar(messageId) {
    const peerId = state.activeChatPeerId;
    const message = state.chats[peerId]?.find(item => item.id === messageId);
    if (!message) return;
    message.starred = !message.starred;
    await persistChatMessage(peerId, message);
    renderChatHistory();
}

function filterChatMessages(messages) {
    const query = state.chatSearch.trim().toLowerCase();
    return messages.filter(message => {
        if (state.chatStarredOnly && !message.starred) return false;
        if (!query) return true;
        return !message.deleted && String(message.text || '').toLowerCase().includes(query);
    });
}

function toggleChatSearch() {
    const bar = document.getElementById('chat-search-bar');
    if (!bar) return;
    const open = bar.classList.toggle('hidden') === false;
    if (open) {
        document.getElementById('chat-search-input').focus();
        return;
    }
    state.chatSearch = '';
    state.chatStarredOnly = false;
    document.getElementById('chat-search-input').value = '';
    document.getElementById('chat-starred-toggle').checked = false;
    renderChatHistory();
}

function setChatSearch(value) {
    state.chatSearch = value;
    renderChatHistory();
}

function setChatStarredOnly(enabled) {
    state.chatStarredOnly = enabled;
    renderChatHistory();
}

function resetChatTools() {
    state.replyToMessageId = null;
    state.chatSearch = '';
    state.chatStarredOnly = false;
    document.getElementById('chat-search-bar')?.classList.add('hidden');
    const input = document.getElementById('chat-search-input');
    if (input) input.value = '';
    const starred = document.getElementById('chat-starred-toggle');
    if (starred) starred.checked = false;
    renderReplyBar();
}

function updateChatConnectionStatus(peerId, text, classes) {
    if (state.activeChatPeerId !== peerId) return;
    const pill = document.getElementById('connection-status-pill');
    pill.textContent = text;
    pill.className = `debug-only text-xs px-2.5 py-1 rounded-full border font-mono whitespace-nowrap ${classes}`;
    renderChatPeerIndicator();
}

function isSecureChannelOpen(peerId) {
    return state.dataChannels[peerId]?.readyState === 'open' && Boolean(state.sessionKeys[peerId]);
}

// Kontaktleiste: Online-Punkt am Avatar, darunter "online", "offline" oder "hat den Chat offen".
function renderChatPeerIndicator() {
    const dot = document.getElementById('chat-peer-online-dot');
    const status = document.getElementById('chat-peer-status');
    if (!dot || !status) return;
    const peerId = state.activeChatPeerId;
    const online = Boolean(peerId) && isPeerOnline(peerId) && !isPeerBlocked(peerId);
    const watching = online && isSecureChannelOpen(peerId) && Boolean(state.peerChatFocus[peerId]);
    dot.classList.toggle('hidden', !online);
    status.textContent = !peerId ? '' : watching ? '\u{1F440} hat den Chat offen' : online ? 'online' : 'offline';
    status.classList.toggle('text-emerald-400', online);
    status.classList.toggle('text-slate-400', !online);
}

function toggleChatHeaderMenu(event) {
    event?.stopPropagation();
    const menu = document.getElementById('chat-header-menu');
    const open = menu.classList.toggle('hidden') === false;
    document.getElementById('chat-header-menu-btn').setAttribute('aria-expanded', String(open));
}

function closeChatHeaderMenu() {
    document.getElementById('chat-header-menu')?.classList.add('hidden');
    document.getElementById('chat-header-menu-btn')?.setAttribute('aria-expanded', 'false');
}

document.addEventListener('click', event => {
    if (!event.target.closest?.('#chat-header-menu')) closeChatHeaderMenu();
});

function isChatVisibleFor(peerId) {
    return Boolean(peerId)
        && state.activeChatPeerId === peerId
        && document.visibilityState === 'visible'
        && !document.getElementById('view-chat')?.classList.contains('hidden');
}

// Teilt dem Gegenueber ueber den DataChannel mit, ob der Chat gerade sichtbar ist. Wird nie gequeued.
function sendChatFocus(peerId, open) {
    if (!peerId || !isSecureChannelOpen(peerId) || isPeerBlocked(peerId)) return;
    sendSecurePayload(peerId, { type: 'CHAT_FOCUS', open }).catch(() => {});
}

function syncChatFocus() {
    const focusedPeerId = isChatVisibleFor(state.activeChatPeerId) ? state.activeChatPeerId : null;
    const previousPeerId = state.chatFocusPeerId;
    if (previousPeerId === focusedPeerId) return;
    if (previousPeerId) sendChatFocus(previousPeerId, false);
    if (focusedPeerId) sendChatFocus(focusedPeerId, true);
    state.chatFocusPeerId = focusedPeerId;
}

function receiveChatFocus(peerId, open) {
    state.peerChatFocus[peerId] = Boolean(open);
    if (state.activeChatPeerId === peerId) renderChatPeerIndicator();
}

// ================= SNAPS =================
// Ein Snap erscheint dauerhaft im Chat (und in Medienuebersicht/Viewer), wenn er gespeichert wurde
// oder aus der Zeit vor den Einmal-Snaps stammt.
function isInlineSnap(message) {
    return isSafeInlineImage(message.snapData) && (message.snapMode !== 'replay' || message.snapSaved);
}

const REPLAY_SNAP_MAX_VIEWS = 2;

function renderReplaySnapMessage(bubble, message, isMine) {
    const views = message.snapViews || 0;
    const available = isSafeInlineImage(message.snapData) && (isMine || views < REPLAY_SNAP_MAX_VIEWS);
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'flex items-center gap-3 text-left w-56';
    const icon = document.createElement('span');
    icon.className = `w-10 h-10 shrink-0 rounded-xl flex items-center justify-center text-lg ${available ? 'bg-brand-500/20 text-brand-300' : 'bg-slate-700 text-slate-400'}`;
    icon.innerHTML = '<i class="fa-solid fa-bolt"></i>';
    const details = document.createElement('div');
    details.className = 'min-w-0';
    const title = document.createElement('div');
    title.className = 'font-semibold';
    title.textContent = 'Snap';
    const meta = document.createElement('div');
    meta.className = 'opacity-75 text-[11px]';
    if (isMine) meta.textContent = available ? 'Gesendet · Tippen zum Ansehen' : 'Angesehen';
    else if (!available) meta.textContent = 'Abgelaufen';
    else meta.textContent = views === 0 ? 'Tippen zum Ansehen' : 'Tippen zum Wiederholen (1x)';
    details.append(title, meta);
    card.append(icon, details);
    if (available) {
        card.onclick = event => {
            event.stopPropagation();
            openReplaySnap(message.id);
        };
    } else {
        card.disabled = true;
    }
    bubble.appendChild(card);
    if (message.text) {
        const caption = document.createElement('div');
        caption.className = 'opacity-90 mt-1';
        caption.textContent = message.text;
        bubble.appendChild(caption);
    }
}

function openReplaySnap(messageId) {
    const peerId = state.activeChatPeerId;
    const message = state.chats[peerId]?.find(item => item.id === messageId);
    if (!message || !isSafeInlineImage(message.snapData)) return;
    const isMine = message.senderId === state.myProfile.id;
    openSecureSnapViewer('');
    state.secureSnapViewing = { mode: 'replay', peerId, messageId, isMine };
    const image = document.getElementById('secure-snap-image');
    image.src = message.snapData;
    image.classList.remove('hidden');
    // Auch der Sender kann seinen eigenen Snap behalten.
    const save = document.getElementById('secure-snap-save');
    save.classList.remove('hidden');
    save.disabled = false;
    save.textContent = 'Speichern';
}

async function saveReplaySnap() {
    const viewing = state.secureSnapViewing;
    if (viewing?.mode !== 'replay') return;
    const message = state.chats[viewing.peerId]?.find(item => item.id === viewing.messageId);
    if (!message) return;
    message.snapSaved = true;
    viewing.saved = true;
    await persistChatMessage(viewing.peerId, message);
    const save = document.getElementById('secure-snap-save');
    save.disabled = true;
    save.textContent = 'Gespeichert';
    renderChatHistory();
}

// Wird beim Schliessen des Viewers aufgerufen: zaehlt die Ansicht, nach der Wiederholung ist der Snap weg.
async function finishReplaySnapView(viewing) {
    if (viewing.isMine || viewing.saved) return;
    const message = state.chats[viewing.peerId]?.find(item => item.id === viewing.messageId);
    if (!message || message.snapSaved) return;
    message.snapViews = (message.snapViews || 0) + 1;
    const consumed = message.snapViews >= REPLAY_SNAP_MAX_VIEWS;
    if (consumed) {
        message.snapData = undefined;
        await removeSnapFromOperation(message.id);
    }
    await persistChatMessage(viewing.peerId, message);
    if (state.activeChatPeerId === viewing.peerId) renderChatHistory();
    // Dem Sender mitteilen, dass der Snap verbraucht ist: er loescht dann seine Kopie.
    if (consumed) await sendSnapConsumed(viewing.peerId, message.id);
}

async function sendSnapConsumed(peerId, messageId) {
    const operation = {
        operationId: `consumed:${messageId}`,
        peerId,
        type: 'SNAP_CONSUMED',
        messageId,
        actorId: state.myProfile.id,
        createdAt: Date.now()
    };
    await persistChatOperation(operation);
    const { peerId: _localPeerId, ...sharedOperation } = operation;
    await sendSecurePayload(peerId, { type: 'CHAT_OPERATION', operation: sharedOperation });
}
// Snaps muessen auch ueber Pfad C passen (Queue-Limit 100 KB Ciphertext), daher max. ca. 70 KB als Data-URL.
const SNAP_MAX_EDGE = 1080;
const SNAP_MAX_DATA_URL_LENGTH = 70000;

async function openSnapUploadModal() {
    if (!state.activeChatPeerId || isPeerBlocked(state.activeChatPeerId)) {
        showToast('Bitte waehle zuerst einen aktiven Chat aus.', 'warning');
        return;
    }
    state.snapFacingMode = state.snapFacingMode || 'user';
    resetSnapPreview();
    document.getElementById('snap-capture-modal').classList.remove('hidden');
    pushModalEntry('snap', hideSnapModal);
    await startSnapCamera();
}

function stopSnapCamera() {
    if (state.mediaStream) {
        state.mediaStream.getTracks().forEach(track => track.stop());
        state.mediaStream = null;
    }
    const video = document.getElementById('snap-video-preview');
    if (video) video.srcObject = null;
}

async function startSnapCamera() {
    stopSnapCamera();
    const video = document.getElementById('snap-video-preview');
    const status = document.getElementById('snap-camera-status');
    status.classList.add('hidden');
    if (!navigator.mediaDevices?.getUserMedia) {
        showSnapCameraProblem('Keine Kamera verfuegbar. Du kannst ein Bild auswaehlen.');
        return;
    }
    try {
        try {
            state.mediaStream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: state.snapFacingMode, width: { ideal: 1920 }, height: { ideal: 1080 } },
                audio: false
            });
        } catch (error) {
            // Manche Geraete kennen facingMode oder die Aufloesung nicht.
            if (error.name === 'NotAllowedError') throw error;
            state.mediaStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        }
        // Das Modal kann waehrend der Kamera-Anfrage geschlossen worden sein.
        if (document.getElementById('snap-capture-modal').classList.contains('hidden')) {
            stopSnapCamera();
            return;
        }
        video.srcObject = state.mediaStream;
        video.classList.toggle('snap-mirrored', state.snapFacingMode === 'user');
        await video.play().catch(() => {});
    } catch (error) {
        logDebug(`Camera error: ${error.name}: ${error.message}`);
        showSnapCameraProblem(error.name === 'NotAllowedError'
            ? 'Kamera-Zugriff verweigert. Du kannst ein Bild auswaehlen.'
            : 'Kamera nicht verfuegbar. Du kannst ein Bild auswaehlen.');
    }
}

function showSnapCameraProblem(text) {
    const status = document.getElementById('snap-camera-status');
    status.textContent = text;
    status.classList.remove('hidden');
}

async function switchSnapCamera() {
    state.snapFacingMode = state.snapFacingMode === 'user' ? 'environment' : 'user';
    await startSnapCamera();
}

function closeSnapModal() {
    dismissModalEntry('snap', hideSnapModal);
}

function hideSnapModal() {
    stopSnapCamera();
    resetSnapPreview();
    document.getElementById('snap-capture-modal').classList.add('hidden');
}

function resetSnapPreview() {
    state.snapDraft = null;
    document.getElementById('snap-live-controls')?.classList.remove('hidden');
    document.getElementById('snap-review-controls')?.classList.add('hidden');
    const preview = document.getElementById('snap-review-image');
    if (preview) {
        preview.src = '';
        preview.classList.add('hidden');
    }
    const caption = document.getElementById('snap-caption-input');
    if (caption) caption.value = '';
}

// Verkleinert und komprimiert, bis der Snap unter das Pfad-C-Limit passt.
// Mit watermarkBits wird die Empfaenger-ID unsichtbar eingebettet (vor jeder Kompression neu).
function encodeSnap(source, width, height, mirror = false, watermarkBits = null) {
    const canvas = document.getElementById('snap-canvas-capture');
    let scale = Math.min(1, SNAP_MAX_EDGE / Math.max(width, height));
    let quality = 0.8;
    for (let attempt = 0; attempt < 12; attempt++) {
        canvas.width = Math.round(width * scale);
        canvas.height = Math.round(height * scale);
        const context = canvas.getContext('2d');
        context.save();
        if (mirror) {
            context.translate(canvas.width, 0);
            context.scale(-1, 1);
        }
        context.drawImage(source, 0, 0, canvas.width, canvas.height);
        context.restore();
        if (watermarkBits) embedWatermarkInCanvas(canvas, watermarkBits);
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        if (dataUrl.length <= SNAP_MAX_DATA_URL_LENGTH) return dataUrl;
        if (quality > 0.45) quality -= 0.1;
        else scale *= 0.8;
    }
    return null;
}

function showSnapReview(dataUrl) {
    stopSnapCamera();
    renderSnapSettings();
    state.snapDraft = dataUrl;
    const preview = document.getElementById('snap-review-image');
    preview.src = dataUrl;
    preview.classList.remove('hidden');
    document.getElementById('snap-live-controls').classList.add('hidden');
    document.getElementById('snap-review-controls').classList.remove('hidden');
}

async function captureSnap() {
    const video = document.getElementById('snap-video-preview');
    if (!video.videoWidth) return;
    const bits = await watermarkTag(state.activeChatPeerId);
    const dataUrl = encodeSnap(video, video.videoWidth, video.videoHeight, state.snapFacingMode === 'user', bits);
    if (!dataUrl) {
        showToast('Snap konnte nicht erstellt werden.', 'error');
        return;
    }
    showSnapReview(dataUrl);
}

async function pickSnapImage(input) {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
        const bitmap = await createImageBitmap(file);
        const dataUrl = encodeSnap(bitmap, bitmap.width, bitmap.height, false, await watermarkTag(state.activeChatPeerId));
        bitmap.close?.();
        if (!dataUrl) throw new Error('Image too large');
        showSnapReview(dataUrl);
    } catch (error) {
        logDebug(`Snap image failed: ${error.message}`);
        showToast('Bild konnte nicht geladen werden.', 'error');
    }
}

async function retakeSnap() {
    resetSnapPreview();
    await startSnapCamera();
}

async function sendSnapDraft() {
    const snapData = state.snapDraft;
    const peerId = state.activeChatPeerId;
    if (!snapData || !peerId) return;
    const caption = document.getElementById('snap-caption-input').value;
    const secure = state.snapSettings.secureSnaps;
    const views = Number(document.getElementById('snap-review-views')?.value) || state.snapSettings.views;
    const seconds = Number(document.getElementById('snap-review-seconds')?.value ?? state.snapSettings.seconds);
    closeSnapModal();
    if (!secure) {
        await sendChatMessage(snapData, caption);
        return;
    }
    const secureSnap = await createSecureSnap(snapData, peerId, views, Number.isFinite(seconds) ? seconds : 10);
    await sendChatMessage(null, caption, null, secureSnap);
}
