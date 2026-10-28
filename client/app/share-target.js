// ================= TEILEN NACH OPENGRID (share_target) =================
// Installiert erscheint OpenGrid im Teilen-Menue anderer Apps. Der Service Worker legt geteilte Bilder
// und Text in den Cache `opengrid-share-inbox` und oeffnet /chat?share=1. Hier waehlt man den Chat;
// Bilder gehen als normale Chat-Bilder raus (wie aus der Galerie), Text landet nur im Eingabefeld.
const SHARE_INBOX_CACHE = 'opengrid-share-inbox';
// Beim Laden merken: der Router ersetzt die Adresse beim Start (ohne ?share=...).
const INITIAL_SHARE_STATUS = new URLSearchParams(window.location.search).get('share');

// Liest und leert den Eingang; danach liegt der Inhalt nur noch im Speicher der Seite.
async function takeSharedInbox() {
    if (!('caches' in window)) return null;
    try {
        const cache = await caches.open(SHARE_INBOX_CACHE);
        const metaResponse = await cache.match('/__share/meta');
        if (!metaResponse) return null;
        const meta = await metaResponse.json();
        const files = [];
        for (let index = 0; index < Math.min(Number(meta.files) || 0, 20); index += 1) {
            const response = await cache.match(`/__share/file-${index}`);
            if (!response) continue;
            const blob = await response.blob();
            if (blob.type.startsWith('image/')) files.push(blob);
        }
        return { text: sharedText(meta), files, skipped: Number(meta.skipped) || 0 };
    } finally {
        await caches.delete(SHARE_INBOX_CACHE).catch(() => false);
    }
}

// Titel, Text und Link zu einer Zeile, ohne Doppelungen (viele Apps schicken den Link auch im Text).
function sharedText(meta) {
    const values = [meta?.title, meta?.text, meta?.url].map(value => String(value || '').trim()).filter(Boolean);
    // Teile weglassen, die schon in einem anderen stecken (z. B. Titel im Text, Link im Text).
    const parts = values.filter((value, index) => !values.some((other, otherIndex) => otherIndex !== index
        && other.includes(value) && (other.length > value.length || otherIndex < index)));
    return parts.join(' ').slice(0, 4000);
}

async function handleIncomingShare() {
    const status = INITIAL_SHARE_STATUS;
    if (!status) return;
    const params = new URLSearchParams(window.location.search);
    if (params.has('share')) {
        params.delete('share');
        const query = params.toString();
        window.history.replaceState(window.history.state, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
    }
    if (status !== '1') {
        showToast(t('share.couldNotReceive'), 'error');
        return;
    }
    const inbox = await takeSharedInbox();
    if (!inbox || (!inbox.files.length && !inbox.text)) {
        showToast(t('share.nothingToSend'), 'info');
        return;
    }
    if (inbox.skipped) showToast(t('share.someFilesSkipped', { count: inbox.skipped }), 'warning');
    openSharePicker(inbox);
}

function openSharePicker(inbox) {
    const content = openMediaModal(t('share.sendTo'));
    const summary = document.createElement('p');
    summary.className = 'text-xs text-slate-400 mb-3';
    summary.textContent = inbox.files.length
        ? t('share.imagesReady', { count: inbox.files.length })
        : t('share.textReady');
    content.appendChild(summary);
    const peerIds = (state.chatPeerIds || []).filter(peerId => !isPeerBlocked(peerId));
    if (!peerIds.length) {
        renderMediaModalMessage(t('share.noChatsYet'), 'fa-comments');
        return;
    }
    content.appendChild(createChatPickerList(peerIds, peerId => replaceModal(closeMediaModal, () => deliverShare(peerId, inbox))));
}

async function deliverShare(peerId, inbox) {
    switchTab('chat');
    await openChatWithPeer(peerId);
    replaceRoute(routeForTab('chat'));
    let sent = 0;
    for (const file of inbox.files) {
        try {
            const bitmap = await createImageBitmap(file);
            const base = captureSnapBase(bitmap, bitmap.width, bitmap.height, false);
            bitmap.close?.();
            const bits = isTraceWatermarkEnabled() ? await watermarkTag(peerId) : null;
            const data = encodeSnap(base, base.width, base.height, false, bits);
            if (!data) continue;
            await sendChatMessage(data, '', null, null, { asImage: true });
            sent += 1;
        } catch (error) {
            logDebug(`Shared image failed: ${error.message}`);
        }
    }
    if (inbox.files.length) showToast(t('snaps.imagesSent', { count: sent }) + '.', sent ? 'success' : 'error');
    // Text nie automatisch senden: nur vorbefuellen, abschicken entscheidet man selbst.
    if (inbox.text) {
        const input = document.getElementById('chat-input');
        if (input) {
            input.value = input.value ? `${input.value} ${inbox.text}` : inbox.text;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.focus();
        }
    }
}
