// ================= MODAL & CHAT =================
function updateProfilePresence(peerId, status) {
    if (state.activeModalPeerId !== peerId) return;
    const badge = document.getElementById('modal-online-badge');
    const styles = {
        checking: [t('common.checking'), 'bg-sky-500/10 text-sky-400 border-sky-500/30'],
        online: [t('common.online'), 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'],
        absent: [t('chat.away'), 'bg-amber-500/10 text-amber-400 border-amber-500/30'],
        offline: [t('chat.offline'), 'bg-slate-800 text-slate-400 border-slate-700']
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
        updateProfilePresence(peerId, { online: 'online', away: 'absent', offline: 'offline' }[presenceStatusOf(peerId)]);
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

    const profileModal = document.getElementById('profile-detail-modal');
    profileModal.classList.remove('hidden');
    // Immer oben starten: nach unten wischen schliesst nur von ganz oben.
    profileModal.scrollTop = 0;
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
    container.innerHTML = `<div class="col-span-2 text-slate-500 text-center py-4" data-profile-connecting><i class="fa-solid fa-lock text-brand-500 mr-1"></i> ${t('chat.connectingSecurelyToRequestFull')}</div>`;

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
        if (container?.querySelector('[data-profile-connecting]')) {
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
    // Profilbesuch melden (nur wenn erlaubt, push.js).
    sendProfileView(peerId);
}

// Match + Freund mit eigenem Social-Profil: zwei duenne Reiter "Dating | Freunde" (das Entdecken-Profil kommt
// als `discoveryProfile` mit). Im Entdecken-Modus ist "Dating" vorgewaehlt, sonst "Freunde".
function profileModalTab(profile) {
    const peerId = state.activeModalPeerId;
    const both = Boolean(profile?.discoveryProfile) && isMatched(peerId) && typeof isFriend === 'function' && isFriend(peerId);
    if (!both) return null;
    if (state.profileModalTab?.peerId !== peerId) {
        state.profileModalTab = { peerId, tab: typeof inExploringMode === 'function' && inExploringMode() ? 'dating' : 'friends' };
    }
    return state.profileModalTab.tab;
}

function setProfileModalTab(tab) {
    const peerId = state.activeModalPeerId;
    if (!peerId || !['dating', 'friends'].includes(tab)) return;
    state.profileModalTab = { peerId, tab };
    const profile = state.cachedProfiles[peerId];
    if (profile) renderProfileModalData(profile);
}

// Was im Popup gezeigt wird: das Profil oder (Reiter "Dating") das mitgeschickte Entdecken-Profil.
function profileModalView(profile) {
    return profileModalTab(profile) === 'dating' ? { ...profile, ...profile.discoveryProfile } : profile;
}

function renderProfileModalData(profile) {
    const tab = profileModalTab(profile);
    const tabs = document.getElementById('modal-profile-tabs');
    tabs?.classList.toggle('hidden', !tab);
    tabs?.querySelectorAll('[data-profile-tab]').forEach(button => {
        const active = button.dataset.profileTab === tab;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-selected', String(active));
    });
    profile = profileModalView(profile);
    document.getElementById('modal-profile-name').textContent = profile.fields?.displayName || HIDDEN_PEER_NAME;
    if (isSafeInlineImage(profile.avatar)) document.getElementById('modal-profile-img').src = profile.avatar;
    const container = document.getElementById('modal-rendered-fields');
    container.innerHTML = '';
    renderProfileMatchActions(state.activeModalPeerId);
    if (profile.restricted && !isMatched(state.activeModalPeerId)) {
        const notice = document.createElement('div');
        notice.className = 'col-span-2 bg-slate-800/60 border border-slate-700 p-2 rounded-sm text-slate-300 flex items-center gap-2';
        notice.innerHTML = '<i class="fa-solid fa-lock text-orange-300"></i>';
        notice.appendChild(document.createTextNode(profile.visibility === 3
            ? t('chat.thisProfileIsHiddenAfter')
            : t('chat.youllSeeMoreDetailsAnd')));
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
        card.className = field.type === 'description' ? 'col-span-2 bg-slate-800 p-2 rounded-sm' : 'bg-slate-800 p-2 rounded-sm';
        const label = document.createElement('div');
        label.className = 'text-slate-400 font-bold';
        label.textContent = localizedText(field.label);
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
        imgEl.textContent = t('chat.invalidImage');
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

// Profilbild plus alle schon geladenen Galeriebilder des offenen Profils. Das Profilbild in grosser Fassung,
// wenn es schon da ist; sonst erst das kleine, die grosse holt IMAGE_REQUEST nach (showFullProfilePicture).
async function openProfileImageViewer(startImage) {
    const peerId = state.activeModalPeerId;
    const avatar = document.getElementById('modal-profile-img').src;
    const ownPart = typeof editingProfilePart === 'function' ? editingProfilePart() : state.myProfile;
    const fullMeta = peerId === state.myProfile.id ? ownPart.avatarFull
        : (peerId && state.cachedProfiles[peerId] ? profileModalView(state.cachedProfiles[peerId]).avatarFull : null);
    const fullMedia = fullMeta?.id ? await loadMedia(fullMeta.id).catch(() => null) : null;
    const fullAvatar = fullMedia?.version === fullMeta?.version && isSafeInlineImage(fullMedia?.data) ? fullMedia.data : null;
    const gallery = [...document.querySelectorAll('#modal-gallery-container [data-viewer-image] img')].map(image => image.src);
    const images = [fullAvatar || avatar, ...gallery].filter((image, index, all) => isSafeInlineImage(image) && all.indexOf(image) === index);
    const start = startImage === avatar ? (fullAvatar || avatar) : startImage;
    openImageViewer(images, Math.max(0, images.indexOf(start)));
    if (fullMeta?.id && !fullAvatar && peerId !== state.myProfile.id) {
        state.profilePictureViewer = { peerId, thumbnail: avatar };
        state.pendingImageRequests[`${peerId}:${fullMeta.id}`] = fullMeta.version;
        sendSecurePayload(peerId, { type: 'IMAGE_REQUEST', imageId: fullMeta.id, version: fullMeta.version }).catch(logBackgroundError('openProfileImageViewer'));
    }
}

// Grosse Fassung des Profilbilds ist angekommen (p2p.client.js): im offenen Betrachter austauschen.
function showFullProfilePicture(peerId, data) {
    const pending = state.profilePictureViewer;
    if (pending?.peerId !== peerId) return;
    replaceViewerImage(pending.thumbnail, data);
    state.profilePictureViewer = null;
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
    // Profil des anderen geloescht (account.js): Antippen entfernt den Chat, statt ihn zu oeffnen.
    if (typeof isProfileDeleted === 'function' && isProfileDeleted(peerId)) {
        await removeDeletedProfileChat(peerId);
        return;
    }
    if (state.activeChatPeerId !== peerId) {
        resetChatTools();
        // Auswahl und Bearbeitung gehoeren zum vorherigen Chat.
        if (state.messageSelection && typeof hideMessageSelection === 'function') {
            hideMessageSelection();
            removeModalFromStack('messageselection');
        }
        if (state.editingMessageId && typeof cancelReply === 'function') cancelReply();
        // Menue des vorherigen Chats ohne eigenen Zurueck-Schritt schliessen.
        if (state.messageMenu && typeof hideMessageMenu === 'function') {
            hideMessageMenu();
            removeModalFromStack('messagemenu');
        }
        // Das Easteregg gilt nur fuer den Chat, in dem es ausgeloest wurde.
        state.albumButtonRevealedFor = null;
    }
    state.activeChatPeerId = peerId;
    // Beim Betreten immer unten.
    state.chatPinned = true;
    await loadChatHistory(peerId);
    await expireUsedReplaySnaps(peerId).catch(logBackgroundError('openChatWithPeer'));
    switchTab('chat');
    renderChatPeerIndicator();
    renderChatPeerHeader(peerId);
    document.getElementById('chat-connection-type').textContent = t('chat.encryptedWebrtcChannel');
    renderActivePeerList();
    renderChatHistory();
    updateChatActionButtons();
    updateChatLayout();
    if (!isPeerBlocked(peerId)) initiateP2PConnection(peerId).catch(logBackgroundError('openChatWithPeer'));
}

// Auf Smartphones zeigt der Chat-Tab entweder die Liste oder den Vollbild-Chat.
const CHAT_LOADING_TEXT = t('chat.loadingChat');

function isChatPlaceholderShown() {
    return document.getElementById('chat-peer-name')?.textContent === CHAT_LOADING_TEXT;
}

// Platzhalter beim Start ueber /chat/<id>: Chat-Layout (auf dem Smartphone Vollbild) ohne Inhalt.
function showChatLoadingPlaceholder() {
    document.getElementById('view-chat')?.classList.add('chat-open');
    const name = document.getElementById('chat-peer-name');
    if (name) name.textContent = CHAT_LOADING_TEXT;
    const messages = document.getElementById('chat-messages');
    if (messages) showEmptyState(messages, { icon: 'fa-spinner', spin: true, text: t('chat.loadingChat'), compact: true });
}

function updateChatLayout() {
    const view = document.getElementById('view-chat');
    if (view) view.classList.toggle('chat-open', Boolean(state.activeChatPeerId));
}

function resetActiveChat(placeholderText) {
    state.activeChatPeerId = null;
    resetChatTools();
    document.getElementById('chat-peer-name').textContent = t('chat.noChatSelected');
    document.getElementById('chat-connection-type').textContent = t('chat.chooseChat');
    document.getElementById('chat-peer-avatar').textContent = '?';
    showEmptyState(document.getElementById('chat-messages'), { icon: 'fa-comments', title: t('chat.noChatSelected'), text: placeholderText });
    updateChatActionButtons();
    updateChatLayout();
    renderActivePeerList();
    renderChatPeerIndicator();
    renderChatSwitcher();
    syncChatFocus();
    if (!state.applyingRoute && window.location.pathname.startsWith('/chat/')) replaceRoute('/chat');
}

// Kam man aus der Chatliste, fuehrt "Zurueck" dorthin; sonst wird der Chat-Eintrag ersetzt.
function leaveActiveChat() {
    if (!state.applyingRoute && window.history.state?.from === '/chat' && window.location.pathname.startsWith('/chat/')) {
        window.history.back();
        return;
    }
    resetActiveChat(t('chat.chooseChatOrStartOne'));
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
    document.getElementById('block-peer-label').textContent = blocked ? t('common.unblock') : t('chat.block');
    input.disabled = blocked;
    sendButton.disabled = blocked;
    updateChatAlbumButton();
    updateFlirtButton();
    if (blocked) {
        updateChatConnectionStatus(peerId, t('chat.blocked'), 'bg-red-500/10 text-red-400 border-red-500/30');
        return;
    }
    renderChatAllowance();
}

// Chat loeschen/blockieren: der Partner bekommt CHAT_WIPE. Reihenfolge ist wichtig: die Chat-Steuerung
// am Server (DELETE_CHAT/BLOCK) loescht alle Router-Nachrichten dieses Chats, also auch einen vorher
// eingereihten Wipe. Deshalb: offener Kanal -> sofort direkt; dann die Steuerung; danach den Wipe
// immer ueber Path C einreihen (fuer einen offline Partner bzw. falls der Kanal doch tot war). Doppelt
// ankommende Wipes ignoriert der Empfaenger (operationId).
async function wipeChatWithPeer(peerId, action, extra = {}) {
    const operation = {
        operationId: `wipe:${window.crypto.randomUUID()}`,
        type: 'CHAT_WIPE',
        actorId: state.myProfile.id,
        createdAt: Date.now(),
        ...extra
    };
    const payload = { type: 'CHAT_OPERATION', operation };
    const channel = state.dataChannels[peerId];
    if (channel?.readyState === 'open' && state.sessionKeys[peerId]) {
        await sendSecurePayload(peerId, payload).catch(logBackgroundError('wipeChatWithPeer'));
    }
    // Ungesendetes fuer diesen Chat verwerfen (es wuerde nach dem Wipe noch ankommen).
    (state.secureMessageQueues[peerId] || []).forEach(item => { item.discarded = true; });
    state.secureMessageQueues[peerId] = [];
    await storeChatControl(peerId, action);
    const queued = await queuePayloadInCache(peerId, { payload, cacheQueued: false }).catch(error => {
        logDebug(`Chat wipe for ${peerId} could not go through Path C: ${error.message}`);
        return false;
    });
    if (!queued) logDebug(`Chat wipe for ${peerId} not queued in the router cache.`);
}

// Ohne Argument der offene Chat; aus dem Menue der Chatliste auch ein anderer.
async function deleteActiveChat(peerId = state.activeChatPeerId) {
    if (typeof peerId !== 'string' || !peerId || !window.confirm(t('chat.deleteThisChatLocallyAnd'))) return;
    try {
        await wipeChatWithPeer(peerId, 'DELETE_CHAT');
        if (peerId === state.activeChatPeerId) resetActiveChat('Chat geloescht.');
        else renderActivePeerList();
        showToast(t('chat.andCachedRouterMessages'), 'success');
    } catch (error) {
        showToast(t('chat.couldNotDeleteChat', { message: error.message }), 'error');
    }
}

async function toggleActivePeerBlock(peerId = state.activeChatPeerId) {
    if (typeof peerId !== 'string' || !peerId) return;
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
            showToast(t('common.peerUnblocked'), 'success');
        } else {
            if (!window.confirm(t('chat.blockThisPeerAndDelete'))) return;

            // Wipe an den Partner (direkt und ueber Path C), dann blockieren.
            await wipeChatWithPeer(peerId, 'BLOCK', { hidePeer: true });
            showToast(t('chat.peerBlockedPermanently'), 'success');
        }
        updateChatActionButtons();
    } catch (error) {
        showToast(t('chat.couldNotUpdateBlock', { message: error.message }), 'error');
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
// options.asImage: Bild statt Einmal-Snap (dauerhaft im Chat).
async function sendChatMessage(snapData = null, caption = '', album = null, secureSnap = null, options = {}) {
    const input = document.getElementById('chat-input');
    const hasAttachment = Boolean(snapData || album || secureSnap || options.audio);
    // Chat-Berechtigungen des anderen (nur Anzeige; der Empfaenger setzt sie selbst durch).
    const allowance = state.activeChatPeerId ? getPeerChatAllowance(state.activeChatPeerId) : null;
    if (allowance && (!allowance.allowed || (hasAttachment && !allowance.images))) {
        showToast(allowance.reason || t('chat.imagesAreOnlyAllowedAfter'), 'info');
        return;
    }
    const text = hasAttachment ? String(caption || '').trim() : input.value.trim();
    // Bearbeiten einer eigenen Nachricht (chat-tools.js): Senden speichert die Aenderung.
    if (!hasAttachment && state.editingMessageId && typeof finishEditMessage === 'function') {
        await finishEditMessage(text);
        return;
    }
    if ((!text && !hasAttachment) || !state.activeChatPeerId || isPeerBlocked(state.activeChatPeerId)) return;

    const peerId = state.activeChatPeerId;
    // Senden fuehrt nach unten, ausser man liest gerade weit oben im Verlauf.
    const history = document.getElementById('chat-messages');
    if (history && !isChatFarUp(history)) state.chatPinned = true;
    const message = {
        id: window.crypto.randomUUID(),
        senderId: state.myProfile.id,
        text,
        snapData,
        // Neue normale Snaps: einmal ansehen, einmal wiederholen, nur gespeichert bleibt er.
        snapMode: snapData && !options.asImage ? 'replay' : undefined,
        // Ablauf nach der ersten Ansicht (Einstellung des Absenders), nur bei Einmal-Snaps.
        snapExpiry: snapData && !options.asImage ? state.snapSettings.expiry : undefined,
        album: album || undefined,
        secureSnap: secureSnap || undefined,
        replyTo: buildReplyReference(peerId, state.replyToMessageId),
        original: options.original?.meta,
        imageSize: snapData ? await measureImage(snapData) : undefined,
        // Sprachnachricht (voice.js) bzw. Video-Infos (video.js, das Video selbst kommt als Original).
        audioData: options.audio?.data,
        audioDuration: options.audio?.duration,
        audioSplitAt: options.audio?.splitAt,
        transcript: options.audio?.transcript,
        video: options.video,
        // Wer das Bild bzw. Video speichern/teilen darf (Einstellung des Absenders, media-rights.js).
        // 'none': im Snap-Editor als "nicht speicherbar" markiert (snaps.js).
        downloadable: options.downloadable === 'none' ? 'none'
            : (snapData && options.asImage) || options.video ? state.mediaDownload : undefined,
        // Liste dieses Chats (Grid & Event oder Chat & Freunde), der Empfaenger uebernimmt sie fuer neue Chats.
        scope: messageScopeFor(peerId),
        // Pflicht-Scan 'minor-chats': Bilder von unter 18 prueft jeder Empfaenger (nudity.js).
        nudityScan: (snapData || secureSnap || options.video) && typeof outgoingNudityScanFlag === 'function' && outgoingNudityScanFlag() ? true : undefined,
        timestamp: formatClockTime(Date.now()),
        createdAt: Date.now(),
        deliveredVia: 'Establishing secure channel...'
    };
    // Original lokal ablegen, bevor die Nachricht rausgeht (der Empfaenger fragt es dann an).
    if (options.original) await storeOwnOriginal(message.id, options.original.dataUrl);
    if (!state.chats[peerId]) state.chats[peerId] = [];
    state.chats[peerId].push(message);
    // Chat nach Tagen: nach dem Senden zum heutigen Tag.
    if (state.chatDayMode) state.chatDay = null;
    rememberChatPeer(peerId);
    await persistChatMessage(peerId, message);
    const operation = createPutOperation(peerId, message);
    await persistChatOperation(operation);
    syncChatGate();
    if (!hasAttachment) {
        input.value = '';
        fitChatInput(input);
        updateComposeButtons();
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
        // Direkt zugestellt, Partner aber abwesend: Benachrichtigung per Push anstossen (push.js).
        if (deliveryPath === 'p2p') nudgeAwayPeer(peerId, message.scope === 'discovery' ? 'discovery' : 'chat');
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
        showToast(t('chat.newEncryptedMessageFrom', { name: state.peers.find(peer => peer.id === peerId)?.name || HIDDEN_PEER_NAME }), 'info');
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

// ----- Scrollposition im Chat -----
// Beim Betreten und Senden bleibt der Chat unten. Wer weit nach oben gescrollt hat (mehr als
// CHAT_FAR_UP_SCREENS Bildschirmhoehen), behaelt seine Position und bekommt den Knopf "nach unten".
// Spaet geladene Bilder (Canvas) vergroessern den Verlauf noch; solange man unten "klebt", wird
// nachgezogen.
const CHAT_PINNED_PX = 80;
const CHAT_FAR_UP_SCREENS = 1.5;

function chatDistanceFromBottom(container) {
    return container.scrollHeight - container.scrollTop - container.clientHeight;
}

function isChatFarUp(container) {
    return chatDistanceFromBottom(container) > container.clientHeight * CHAT_FAR_UP_SCREENS;
}

function scrollChatToBottom(smooth = false) {
    const container = document.getElementById('chat-messages');
    if (!container) return;
    state.chatPinned = true;
    container.scrollTo({ top: container.scrollHeight, behavior: smooth && !prefersReducedMotion() ? 'smooth' : 'auto' });
    updateChatJumpButton();
}

function updateChatJumpButton() {
    const container = document.getElementById('chat-messages');
    const button = document.getElementById('chat-jump-bottom');
    if (!container || !button) return;
    button.classList.toggle('hidden', !state.activeChatPeerId || chatDistanceFromBottom(container) <= container.clientHeight);
}

// Der Senden-Knopf nimmt dem Nachrichtenfeld den Fokus nicht weg: so bleibt auf dem Smartphone die
// Tastatur offen und man kann direkt weiterschreiben.
function initChatInputFocus() {
    const send = document.getElementById('send-chat-btn');
    const input = document.getElementById('chat-input');
    if (!send || !input) return;
    send.addEventListener('pointerdown', event => {
        if (document.activeElement === input) event.preventDefault();
    });
    send.addEventListener('click', () => {
        if (!input.disabled) input.focus({ preventScroll: true });
    });
}

function initChatScroll() {
    const container = document.getElementById('chat-messages');
    if (!container) return;
    container.addEventListener('scroll', () => {
        state.chatPinned = chatDistanceFromBottom(container) <= CHAT_PINNED_PX;
        updateChatJumpButton();
        // Oben angekommen: die naechste Seite aelterer Nachrichten dazu.
        if (container.scrollTop < 80 && state.chatOlderCount) loadOlderChatMessages();
        updateFlirtTabCollapse(container);
    }, { passive: true });
    // Canvas-Bilder bekommen ihre Groesse erst nach dem Zeichnen: unten bleiben, wenn man dort war.
    new MutationObserver(() => {
        if (state.chatPinned) container.scrollTop = container.scrollHeight;
    }).observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['width', 'height'] });
}

function renderChatHistory() {
    const container = document.getElementById('chat-messages');
    if (!container || !state.activeChatPeerId) return;
    // Zurueckgehaltene Nachrichten (Chat-Berechtigungen) erscheinen erst nach einem Match.
    const peerMessages = state.chats[state.activeChatPeerId] || [];
    // Flirt-Teil im Freundes-Chat: nur im Flirt-Modus bzw. bei abgeschalteter Einstellung (friends.js).
    const allMessages = peerMessages.filter(message => !message.held
        && !isDiscoveryMessageHidden(state.activeChatPeerId, message));
    const filtering = Boolean(state.chatSearch) || state.chatStarredOnly;
    // Seiten: nur die letzten Nachrichten bzw. ein Tag (chat-tools.js).
    const page = chatHistoryWindow(filterChatMessages(allMessages), filtering);
    const msgs = page.messages;
    state.chatOlderCount = page.older;
    const markFlirt = isFlirting(state.activeChatPeerId);
    updateFlirtButton();
    // Wer nicht unten klebt, behaelt seine Position (der Inhalt darueber bleibt gleich).
    const previousScrollTop = container.scrollTop;
    container.innerHTML = '';
    if (allMessages.length === 0) {
        showEmptyState(container, { icon: 'fa-hand', title: t('chat.noMessagesYet'), text: t('chat.sayHello') });
        return;
    }
    if (msgs.length === 0) {
        showEmptyState(container, { icon: 'fa-magnifying-glass', text: t('chat.noMatchingMessages'), compact: true });
        return;
    }
    if (page.older) {
        const older = document.createElement('button');
        older.type = 'button';
        older.className = 'chat-load-older';
        older.textContent = t('chat.loadOlderMessages', { count: page.older });
        older.onclick = loadOlderChatMessages;
        container.appendChild(older);
    }
    msgs.forEach(message => {
        // Systemzeile (z. B. "Profil wurde geloescht", account.js): mittig, ohne Blase und Aktionen.
        if (message.system) {
            const note = document.createElement('div');
            note.id = `chat-message-${message.id}`;
            note.className = 'chat-system-note';
            note.textContent = message.text;
            container.appendChild(note);
            return;
        }
        const isMine = message.senderId === state.myProfile.id;
        const row = document.createElement('div');
        row.id = `chat-message-${message.id}`;
        row.className = `flex flex-col ${isMine ? 'items-end' : 'items-start'}`;
        if (message.replyTo && !message.deleted) row.appendChild(renderReplyQuote(message.replyTo, isMine));
        const bubble = document.createElement('div');
        if (markFlirt && message.scope === 'discovery' && !message.deleted) row.classList.add('flirt-message');
        bubble.className = `chat-bubble whitespace-pre-wrap wrap-break-word max-w-[80%] rounded-2xl px-4 py-2 overflow-hidden ${message.deleted ? 'bg-slate-900 text-slate-500 border border-slate-800 italic' : isMine ? 'bg-brand-600 text-white rounded-br-none' : 'bg-slate-800 text-slate-100 rounded-bl-none'}`;

        if (message.deleted) {
            bubble.textContent = t('common.messageDeleted');
        } else if (message.secureSnap) {
            renderSecureSnapMessage(bubble, message, isMine);
            if (message.text) {
                const caption = document.createElement('div');
                caption.className = 'opacity-90 mt-1';
                caption.textContent = message.text;
                bubble.appendChild(caption);
            }
        } else if (message.album) {
            renderAlbumMessage(bubble, message.album, message.id);
            if (message.text) {
                const caption = document.createElement('div');
                caption.className = 'opacity-90 mt-1';
                caption.textContent = message.text;
                bubble.appendChild(caption);
            }
        } else if (message.snapMode === 'replay' && !message.snapSaved) {
            renderReplaySnapMessage(bubble, message, isMine);
        } else if (message.audioData) {
            renderVoiceMessage(bubble, message, isMine);
        } else if (message.video) {
            renderVideoMessage(bubble, message, isMine);
        } else if (message.snapData) {
            if (isSafeInlineImage(message.snapData)) {
                if (message.nudityScan && message.senderId !== state.myProfile.id && typeof markForcedNudityScan === 'function') markForcedNudityScan(message.snapData);
                const image = createSecureImage(message.snapData, 'w-48 sm:w-64 rounded-xl mb-1.5 border border-slate-900/50 cursor-zoom-in', message.imageSize, { own: isMine, reuseKey: `image:${message.id}` });
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
            if (message.original) {
                const badge = document.createElement('div');
                badge.className = 'text-[11px] opacity-75';
                badge.dataset.originalBadge = message.id;
                badge.textContent = isMine || message.originalReady ? t('chat.original') : t('chat.originalFollowsOverDirectConnection');
                bubble.appendChild(badge);
                if (!isMine && !message.originalReady) renderOriginalProgress(message.id);
            }
            if (isMine && message.savedByPeer) {
                const saved = document.createElement('div');
                saved.className = 'text-[11px] opacity-75';
                saved.innerHTML = `<i class="fa-solid fa-bookmark"></i> ${t('chat.savedByRecipient')}`;
                bubble.appendChild(saved);
            }
        } else {
            bubble.textContent = message.text;
        }
        const meta = document.createElement('div');
        meta.className = 'text-[9px] text-slate-500 mt-0.5 flex items-center gap-2';
        const status = document.createElement('span');
        status.textContent = message.editedAt && !message.deleted ? `${message.timestamp} · ${t('chat.edited')}` : message.timestamp;
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
        // Neu gezeichnet unter der Maus: Leiste sofort wieder zeigen (sonst flackert sie, chat-tools.js).
        if (message.id === state.hoveredMessageId) bubbleWrap.classList.add('is-hovered');
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
    if (!filtering && state.chatPinned) container.scrollTop = container.scrollHeight;
    else container.scrollTop = previousScrollTop;
    // Offenes Kontextmenue an die neu gezeichnete Zeile haengen statt es zu verlieren.
    if (typeof syncMessageMenu === 'function') syncMessageMenu();
    updateChatJumpButton();
    renderChatAllowance();
    // Mehrfachauswahl (chat-tools.js): Markierungen nach dem Neuaufbau wieder setzen.
    if (state.messageSelection && typeof renderMessageSelection === 'function') renderMessageSelection();
}

// Path C haelt Nachrichten nur bis zur Queue-TTL. Danach liefert erst der naechste direkte Chat-Sync aus.
function describePendingDelivery(message, isMine) {
    if (!isMine || message.deleted || message.deliveryConfirmed) return null;
    if (message.cacheExpiresAt && Date.now() > message.cacheExpiresAt) {
        return t('chat.notPickedUpWillBe');
    }
    if (message.deliveredVia === 'Pending') return t('chat.waitingForConnection');
    return null;
}
