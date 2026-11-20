// ================= PROFILBILD-VERIFIZIERUNG (documentation/VERIFIZIERUNG.md, Board T37 V2) =================
// Nur das Entdecken-Profil (Dating). Ablauf: Zustimmung -> Frontkamera -> je Schritt (Reihenfolge vom Router)
// Countdown und ein Bild -> Upload mit dem Profilbild in voller Groesse -> signierter Haken des Routers.
// Der Haken liegt im eigenen Profil (`myProfile.verification`) und reist im signierten Profil als `verified` mit,
// solange er zum aktuellen Profilbild passt und nicht abgelaufen ist. Neues Profilbild = Haken weg.
const VERIFY_COUNTDOWN_SECONDS = 3;
const VERIFY_FRAME_EDGE = 720;
const VERIFY_STEP_ICONS = { straight: 'fa-circle-dot', left: 'fa-arrow-left', right: 'fa-arrow-right' };
// Texte woertlich: scripts/i18n-keys.mjs findet nur feste Schluessel, keine zusammengesetzten.
const VERIFY_STEP_TEXT = { straight: () => t('verify.step.straight'), left: () => t('verify.step.left'), right: () => t('verify.step.right') };
// Ablehnungsgruende des Routers mit eigenem Text (server/verify.js), sonst ein allgemeiner.
const VERIFY_REASON_TEXT = {
    'profile-face': () => t('verify.reason.profileFace'),
    'no-face': () => t('verify.reason.noFace'),
    'many-faces': () => t('verify.reason.manyFaces'),
    'too-far': () => t('verify.reason.tooFar'),
    pose: () => t('verify.reason.pose'),
    'not-same-person': () => t('verify.reason.notSamePerson'),
    mismatch: () => t('verify.reason.mismatch'),
    expired: () => t('verify.reason.expired')
};

function verifyConfig() {
    return state.appConfig?.verify || { enabled: false };
}

// Eigener Haken, wenn er noch gilt (passt zu Profilbild, eigener ID und ist nicht abgelaufen), sonst null.
function ownVerification(now = Date.now()) {
    const profile = state.myProfile;
    const record = profile?.verification;
    const badge = record?.badge;
    if (!badge || typeof record.sig !== 'string' || !profile.avatar || !profile.avatarFull?.sha256) return null;
    if (badge.subject !== profile.id || badge.avatarSha256 !== profile.avatarFull.sha256 || !(badge.expiresAt > now)) return null;
    return { badge: { ...badge }, sig: record.sig };
}

// Karte im Profil-Editor (nur beim Bearbeiten des Entdecken-Profils und wenn der Router pruefen kann).
function renderVerifyCard() {
    const card = document.getElementById('verify-card');
    if (!card) return;
    const show = Boolean(verifyConfig().enabled) && editingProfilePart() === state.myProfile;
    card.classList.toggle('hidden', !show);
    if (!show) return;
    const status = document.getElementById('verify-status');
    const button = document.getElementById('verify-start-btn');
    const own = ownVerification();
    const stale = !own && Boolean(state.myProfile.verification);
    if (status) {
        status.textContent = own
            ? t('verify.statusVerified', { date: new Date(own.badge.expiresAt).toLocaleDateString() })
            : stale ? t('verify.statusStale') : t('verify.statusNone');
    }
    card.classList.toggle('is-verified', Boolean(own));
    if (button) {
        button.textContent = own ? t('verify.again') : t('verify.start');
        button.disabled = !state.myProfile.avatar || !state.myProfile.avatarFull?.id;
    }
}

async function verifyRequest(path, body) {
    const response = await fetch(`${API_BASE}/api/verify/${path}`, {
        method: 'POST',
        headers: peerAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ peerId: state.myProfile.id, ...body })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok && !data.reason) {
        const error = new Error(data.error || `HTTP ${response.status}`);
        error.status = response.status;
        throw error;
    }
    return data;
}

// Profilbild in voller Groesse, genau die Fassung, auf die `avatarFull.sha256` im Profil zeigt.
async function loadOwnFullAvatar() {
    const meta = state.myProfile.avatarFull;
    if (!meta?.id) return null;
    const media = await loadMedia(meta.id);
    const data = typeof media?.data === 'string' ? media.data : null;
    if (!data || !data.startsWith('data:image/jpeg;base64,')) return null;
    return (await sha256Base64(data)) === meta.sha256 ? data : null;
}

// Ein Bild aus der Kamera, ungespiegelt (wie es die Kamera sieht), lange Seite hoechstens VERIFY_FRAME_EDGE.
function captureVerifyFrame(video) {
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return null;
    const scale = Math.min(1, VERIFY_FRAME_EDGE / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.85);
}

const verifyWait = ms => new Promise(resolve => setTimeout(resolve, ms));

function verifyElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
}

// Schritt 1: erklaeren und zustimmen lassen.
function openProfileVerification() {
    if (!verifyConfig().enabled) return;
    if (!state.myProfile.avatar || !state.myProfile.avatarFull?.id) {
        showToast(t('verify.needPicture'), 'warning');
        return;
    }
    const content = openMediaModal(t('verify.title'));
    const box = verifyElement('div', 'space-y-3');
    box.id = 'verify-consent';
    box.append(
        verifyElement('p', 'text-sm text-slate-300', t('verify.intro')),
        verifyElement('p', 'text-xs text-slate-400', t('verify.privacy', { days: verifyConfig().days || 90 }))
    );
    const start = verifyElement('button', 'btn-primary w-full', t('verify.consentStart'));
    start.type = 'button';
    start.id = 'verify-consent-btn';
    start.addEventListener('click', () => runProfileVerification().catch(logBackgroundError('runProfileVerification')));
    box.appendChild(start);
    content.appendChild(box);
}

// Schritt 2: Kamera, Schritte, Upload, Ergebnis.
async function runProfileVerification() {
    const content = document.getElementById('media-modal-content');
    if (!content) return;
    content.innerHTML = '';
    const box = verifyElement('div', 'space-y-3');
    const video = verifyElement('video', 'verify-video w-full max-h-[55vh] rounded-xl bg-black object-cover');
    video.id = 'verify-video';
    video.poster = EMPTY_VIDEO_POSTER;
    video.setAttribute('playsinline', '');
    video.muted = true;
    const instruction = verifyElement('p', 'verify-instruction text-base font-bold text-slate-100 flex items-center gap-2');
    instruction.id = 'verify-instruction';
    const hint = verifyElement('p', 'text-sm text-slate-400');
    hint.id = 'verify-hint';
    box.append(video, instruction, hint);
    content.appendChild(box);

    let stream = null;
    let stopped = false;
    const stop = () => {
        stopped = true;
        stream?.getTracks().forEach(track => track.stop());
        video.srcObject = null;
    };
    state.mediaModalCleanup = stop;
    const fail = (message, retry = true) => {
        stop();
        instruction.textContent = '';
        hint.textContent = message;
        hint.className = 'text-sm text-rose-300';
        video.classList.add('hidden');
        if (retry) {
            const again = verifyElement('button', 'btn-secondary w-full', t('verify.retry'));
            again.type = 'button';
            again.id = 'verify-retry-btn';
            again.addEventListener('click', () => runProfileVerification().catch(logBackgroundError('runProfileVerification')));
            box.appendChild(again);
        }
    };

    const profileImage = await loadOwnFullAvatar().catch(() => null);
    if (!profileImage) return fail(t('verify.pictureMissing'), false);
    try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    } catch (error) {
        return fail(error?.name === 'NotAllowedError' ? t('scan.cameraDenied') : t('scan.noCamera'), false);
    }
    if (stopped) return stop();
    video.srcObject = stream;
    await video.play().catch(() => {});

    let session;
    try {
        session = await verifyRequest('start', {});
    } catch (error) {
        return fail(error.status === 429 ? t('verify.tooMany') : t('verify.unavailable'), error.status !== 429);
    }
    const frames = [];
    for (const step of session.steps) {
        if (stopped) return;
        instruction.innerHTML = '';
        instruction.append(verifyElement('i', `fa-solid ${VERIFY_STEP_ICONS[step] || 'fa-circle-dot'} text-brand-400`), verifyElement('span', '', (VERIFY_STEP_TEXT[step] || VERIFY_STEP_TEXT.straight)()));
        instruction.dataset.step = step;
        for (let second = VERIFY_COUNTDOWN_SECONDS; second > 0; second--) {
            hint.textContent = t('verify.countdown', { seconds: second });
            await verifyWait(1000);
            if (stopped) return;
        }
        const frame = captureVerifyFrame(video);
        if (!frame) return fail(t('scan.noCamera'));
        frames.push(frame);
    }
    stop();
    video.classList.add('hidden');
    instruction.textContent = '';
    delete instruction.dataset.step;
    hint.textContent = t('verify.checking');
    let result;
    try {
        result = await verifyRequest('finish', { sessionId: session.sessionId, frames, profileImage, avatarSha256: state.myProfile.avatarFull.sha256 });
    } catch {
        return fail(t('verify.unavailable'));
    }
    // Die Bilder werden nicht behalten.
    frames.length = 0;
    if (!result.ok) return fail(Object.hasOwn(VERIFY_REASON_TEXT, result.reason) ? VERIFY_REASON_TEXT[result.reason]() : t('verify.reason.generic'));
    state.myProfile.verification = { badge: result.badge, sig: result.sig };
    await saveUserProfile({ quiet: true });
    renderVerifyCard();
    hint.className = 'text-sm text-emerald-300';
    hint.textContent = t('verify.success');
    showToast(t('verify.success'), 'success');
}

// ================= HAKEN BEI ANDEREN (Board T37 V3) =================
// Profil-Popup und Chat-Kopf: der signierte Haken aus dem Profil (`verified`), geprueft mit dem Schluessel des eigenen
// Routers (/api/config verify.key): Signatur, Ablauf, gehoert zu diesem Kontakt (auch ein anderes Geraet derselben
// Person, devices.js) und passt zum aktuellen Profilbild. Grid-Karten zeigen die Markierung des Routers (`verified`).
const peerVerificationCache = new Map();

function verifyBadgeKeyJwk() {
    const key = verifyConfig().key;
    return typeof key?.x === 'string' && typeof key?.y === 'string' ? { kty: 'EC', crv: 'P-256', x: key.x, y: key.y } : null;
}

function badgeSubjectFits(peerId, subject) {
    if (subject === peerId) return true;
    if (typeof identityOf !== 'function' || typeof contactDeviceNodes !== 'function') return false;
    return contactDeviceNodes(identityOf(peerId)).includes(subject);
}

async function checkPeerVerification(peerId, profile = state.cachedProfiles?.[peerId], now = Date.now()) {
    const record = profile?.verified;
    const badge = record?.badge;
    const jwk = verifyBadgeKeyJwk();
    if (!badge || typeof record.sig !== 'string' || !jwk) return false;
    if (!(badge.expiresAt > now) || !badgeSubjectFits(peerId, badge.subject)) return false;
    if (!profile.avatar || !profile.avatarFull?.sha256 || badge.avatarSha256 !== profile.avatarFull.sha256) return false;
    // Schluessel ueber den ganzen Haken: ein veraenderter Haken mit alter Signatur darf nie das alte Ergebnis bekommen.
    const cacheKey = `${canonicalJson(badge)}|${record.sig}|${jwk.x}|${jwk.y}`;
    const cached = peerVerificationCache.get(peerId);
    if (cached?.key === cacheKey) return cached.ok;
    const ok = await verifyOperationSignature({ ...badge, sig: record.sig }, jwk);
    peerVerificationCache.set(peerId, { key: cacheKey, ok });
    return ok;
}

// Ergebnis der letzten Pruefung (synchron, fuer Filter); Ablauf zaehlt erneut.
function peerVerifiedCached(peerId, now = Date.now()) {
    const profile = state.cachedProfiles?.[peerId];
    const badge = profile?.verified?.badge;
    return peerVerificationCache.get(peerId)?.ok === true && badge?.expiresAt > now && badge.avatarSha256 === profile.avatarFull?.sha256;
}

// Haken-Element (Profil-Popup, Chat-Kopf) passend schalten; `stillCurrent` verhindert Treffer fuer einen alten Peer.
function showPeerVerifiedBadge(elementId, peerId, stillCurrent) {
    const element = document.getElementById(elementId);
    if (!element) return;
    element.classList.add('hidden');
    if (!peerId) return;
    checkPeerVerification(peerId).then(ok => {
        if (stillCurrent()) element.classList.toggle('hidden', !ok);
    }).catch(() => {});
}

function renderModalVerifiedBadge(peerId) {
    showPeerVerifiedBadge('modal-profile-verified', peerId, () => state.activeModalPeerId === peerId);
}

function renderChatVerifiedBadge(peerId) {
    showPeerVerifiedBadge('chat-peer-verified', peerId, () => state.activeChatPeerId === peerId);
}

// Kleiner Haken fuer die Grid-Karte (nur Entdecken, Markierung des Routers).
function gridVerifiedBadge(peer) {
    if (!peer?.verified || state.appMode !== 'discovery') return null;
    const badge = document.createElement('span');
    badge.className = 'verified-badge absolute top-2 left-2 h-7 w-7 rounded-full bg-black/60 flex items-center justify-center text-sm';
    badge.title = t('verify.badgeTitle');
    badge.setAttribute('aria-label', t('verify.badgeTitle'));
    badge.innerHTML = '<i class="fa-solid fa-circle-check"></i>';
    return badge;
}
