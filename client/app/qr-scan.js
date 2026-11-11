// ================= OPENGRID-CODES EINFUEGEN UND SCANNEN =================
// Einladungen (/invite#<peerId>.<fingerprint>~<modus> oder nur der Teil nach #), Umzugs-/Kopplungs-Codes
// (/transfer#<code>) und Router-Adressen (opengrid://connect?url=...) lassen sich einfuegen, mit der Kamera
// scannen (Einladen-Karte) und werden in der Snap-Kamera erkannt. Erkennung auf dem Geraet: BarcodeDetector,
// wo der Browser ihn hat, sonst jsQR (Apache-2.0, vom Router ausgeliefert, /vendor/jsqr/jsQR.js). Nichts geht
// an fremde Dienste; andere QR-Codes werden ignoriert.
const QR_SCAN_INTERVAL_MS = 250;
const SNAP_QR_INTERVAL_MS = 800;
const QR_SCAN_MAX_EDGE = 720;

// ----- Reine Hilfen (test/qr-scan.test.js) -----
// Was ist das fuer ein Code? { kind: 'invite' | 'transfer' | 'router' | 'foreign-invite', ... } oder null.
function classifyOpenGridCode(text, origin = window.location.origin) {
    const value = String(text || '').trim();
    if (!value || value.length > 2000) return null;
    if (/^opengrid:\/\//i.test(value)) {
        try {
            const url = new URL(value);
            const target = url.searchParams.get('url');
            return target ? { kind: 'router', url: target, link: value } : null;
        } catch {
            return null;
        }
    }
    if (/^https?:\/\//i.test(value)) {
        let url;
        try {
            url = new URL(value);
        } catch {
            return null;
        }
        const fragment = url.hash.replace(/^#/, '');
        if (url.pathname === '/invite' && fragment) {
            if (url.origin !== origin) return { kind: 'foreign-invite', host: url.host };
            return typeof parseInvite === 'function' && parseInvite(fragment) ? { kind: 'invite', fragment } : null;
        }
        if (url.pathname === '/transfer' && fragment && url.origin === origin) return { kind: 'transfer', code: fragment };
        return null;
    }
    // Nur der Code (z. B. aus einer Nachricht kopiert).
    const fragment = value.replace(/^#/, '');
    return typeof parseInvite === 'function' && parseInvite(fragment) ? { kind: 'invite', fragment } : null;
}

// ----- Erkennen -----
function loadJsQr() {
    if (typeof window.jsQR === 'function') return Promise.resolve(window.jsQR);
    if (state.jsQrLoading) return state.jsQrLoading;
    state.jsQrLoading = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = '/vendor/jsqr/jsQR.js';
        script.onload = () => (typeof window.jsQR === 'function' ? resolve(window.jsQR) : reject(new Error('jsQR missing')));
        script.onerror = () => {
            state.jsQrLoading = null;
            reject(new Error('Could not load jsQR'));
        };
        document.body.append(script);
    });
    return state.jsQrLoading;
}

async function barcodeDetector() {
    if (state.qrDetector !== undefined) return state.qrDetector;
    state.qrDetector = null;
    try {
        if ('BarcodeDetector' in window && (await window.BarcodeDetector.getSupportedFormats()).includes('qr_code')) {
            state.qrDetector = new window.BarcodeDetector({ formats: ['qr_code'] });
        }
    } catch {
        state.qrDetector = null;
    }
    return state.qrDetector;
}

// Text aller QR-Codes im Bild (Video oder Canvas); leer, wenn keiner da ist.
async function decodeQrCodes(source) {
    const width = source.videoWidth || source.width;
    const height = source.videoHeight || source.height;
    if (!width || !height) return [];
    const detector = await barcodeDetector();
    if (detector) {
        try {
            return (await detector.detect(source)).map(code => code.rawValue).filter(Boolean);
        } catch {
            // Faellt auf jsQR zurueck.
        }
    }
    const decode = await loadJsQr();
    const scale = Math.min(1, QR_SCAN_MAX_EDGE / Math.max(width, height));
    const canvas = state.qrScanCanvas || (state.qrScanCanvas = document.createElement('canvas'));
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    const result = decode(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: 'attemptBoth' });
    return result?.data ? [result.data] : [];
}

async function findOpenGridCode(source) {
    for (const text of await decodeQrCodes(source)) {
        const code = classifyOpenGridCode(text);
        if (code) return code;
    }
    return null;
}

// ----- Oeffnen -----
async function openOpenGridCode(code) {
    if (!code) {
        showToast(t('scan.notOpenGrid'), 'warning');
        return false;
    }
    if (code.kind === 'invite') {
        await acceptInvite(code.fragment);
        return true;
    }
    if (code.kind === 'foreign-invite') {
        showToast(t('scan.otherRouter', { host: code.host }), 'warning');
        return false;
    }
    if (code.kind === 'transfer') {
        // Umzug/Koppeln gilt fuer ein neues Geraet: hier ist schon ein Profil eingerichtet.
        showToast(t('scan.transferOnNewDevice'), 'info');
        return false;
    }
    if (code.kind === 'router') {
        // In der Android-App wechselt der Link den Router (die App fragt nach); im Browser nur ein Hinweis.
        if (typeof isNativeApp === 'function' && isNativeApp()) window.location.href = code.link;
        else showToast(t('scan.routerAddress', { url: code.url }), 'info');
        return true;
    }
    return false;
}

// Eingefuegter Code bzw. Link (Einladen-Karte).
async function openPastedInvite() {
    const input = document.getElementById('invite-paste-input');
    const code = classifyOpenGridCode(input?.value);
    if (await openOpenGridCode(code) && input) input.value = '';
}

// ----- Scanner (Einladen-Karte) -----
async function openQrScanner() {
    const content = openMediaModal(t('scan.title'));
    const box = document.createElement('div');
    box.className = 'space-y-3';
    const video = document.createElement('video');
    video.id = 'qr-scan-video';
    video.className = 'w-full max-h-[60vh] rounded-xl bg-black object-cover';
    video.setAttribute('playsinline', '');
    video.muted = true;
    const hint = document.createElement('p');
    hint.id = 'qr-scan-hint';
    hint.className = 'text-sm text-slate-400';
    hint.textContent = t('scan.hint');
    box.append(video, hint);
    content.appendChild(box);
    let stream = null;
    let stopped = false;
    let timer = null;
    const stop = () => {
        stopped = true;
        clearTimeout(timer);
        stream?.getTracks().forEach(track => track.stop());
        video.srcObject = null;
    };
    state.mediaModalCleanup = stop;
    try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    } catch (error) {
        hint.textContent = error?.name === 'NotAllowedError' ? t('scan.cameraDenied') : t('scan.noCamera');
        return;
    }
    if (stopped) {
        stream.getTracks().forEach(track => track.stop());
        return;
    }
    video.srcObject = stream;
    await video.play().catch(() => {});
    let warned = false;
    const tick = async () => {
        if (stopped) return;
        try {
            const texts = await decodeQrCodes(video);
            const code = texts.map(text => classifyOpenGridCode(text)).find(Boolean);
            if (code) {
                stop();
                closeMediaModal();
                setTimeout(() => openOpenGridCode(code).catch(logBackgroundError('openQrScanner')), 0);
                return;
            }
            if (texts.length && !warned) {
                warned = true;
                hint.textContent = t('scan.notOpenGrid');
            }
        } catch (error) {
            logDebug(`QR scan failed: ${error.message}`);
        }
        timer = setTimeout(tick, QR_SCAN_INTERVAL_MS);
    };
    tick();
}

// ----- Snap-Kamera: OpenGrid-Codes im Bild erkennen -----
function startSnapQrWatch() {
    stopSnapQrWatch();
    const video = document.getElementById('snap-video-preview');
    if (!video) return;
    const check = async () => {
        state.snapQrTimer = null;
        const modal = document.getElementById('snap-capture-modal');
        if (!state.mediaStream || modal?.classList.contains('hidden')) return;
        if (!(typeof hasSnapDraft === 'function' && hasSnapDraft())) {
            const code = await findOpenGridCode(video).catch(() => null);
            showSnapQrChip(code);
        }
        state.snapQrTimer = setTimeout(check, SNAP_QR_INTERVAL_MS);
    };
    state.snapQrTimer = setTimeout(check, SNAP_QR_INTERVAL_MS);
}

function stopSnapQrWatch() {
    clearTimeout(state.snapQrTimer);
    state.snapQrTimer = null;
    showSnapQrChip(null);
}

function showSnapQrChip(code) {
    const chip = document.getElementById('snap-qr-chip');
    if (!chip) return;
    state.snapQrCode = code;
    chip.classList.toggle('hidden', !code);
    if (!code) return;
    const label = chip.querySelector('[data-snap-qr-label]');
    if (label) {
        label.textContent = code.kind === 'invite' ? t('scan.openInvite')
            : code.kind === 'router' ? t('scan.openRouter')
                : code.kind === 'transfer' ? t('scan.transferCode') : t('scan.foreignInvite');
    }
}

function openSnapQrCode() {
    const code = state.snapQrCode;
    if (!code) return;
    if (typeof closeSnapModal === 'function') closeSnapModal();
    setTimeout(() => openOpenGridCode(code).catch(logBackgroundError('openSnapQrCode')), 0);
}
