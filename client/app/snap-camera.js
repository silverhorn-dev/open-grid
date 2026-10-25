// ================= SNAP-KAMERA: LICHT, ZOOM, GESTEN =================
// Snap oder Bild: seitlich wischen oder der Knopf am rechten Rand schaltet um. "Bild" wird als normales,
// dauerhaftes Bild im Chat gesendet (kein Einmal-Snap, keine Secure-Snap-Regeln).
const SNAP_SWIPE_MODE = 80;

function setSnapSendMode(mode) {
    state.snapSendMode = mode === 'image' ? 'image' : 'snap';
    const image = state.snapSendMode === 'image';
    document.getElementById('snap-mode-pill').textContent = image ? 'Bild' : 'Snap';
    document.getElementById('snap-mode-switch-label').textContent = image ? 'Als Snap senden' : 'Als Bild senden';
    const switchButton = document.getElementById('snap-mode-switch');
    switchButton.querySelector('i').className = `fa-solid ${image ? 'fa-chevron-left' : 'fa-chevron-right'}`;
    // Status-Fotos kennen den Unterschied nicht.
    const forStatus = state.snapTarget === 'status';
    switchButton.classList.toggle('hidden', forStatus);
    // Im Editor zeigt der Senden-Knopf den Modus; die Anzeige oben wuerde die Werkzeuge verdecken.
    document.getElementById('snap-mode-pill').classList.toggle('hidden', forStatus || hasSnapDraft());
    if (typeof updateSnapReviewOptions === 'function') updateSnapReviewOptions();
}

function toggleSnapSendMode() {
    hapticTick();
    setSnapSendMode(state.snapSendMode === 'image' ? 'snap' : 'image');
}

// Gesten (feature-request-gestures.md G10/G11), jeweils mit Knopf als Alternative:
//   - nach unten wischen = Kamera schliessen
//   - am Ausloeser nach oben wischen = Bild aus der Galerie waehlen
//   - doppelt auf das Vorschaubild tippen = Front-/Rueckkamera wechseln
//   - mit zwei Fingern ziehen = Zoom (wenn die Kamera es unterstuetzt)
const SNAP_SWIPE_CLOSE = 110;
const SNAP_SWIPE_GALLERY = 60;
const SNAP_DOUBLE_TAP_MS = 300;

const snapCamera = {
    torch: false,
    zoom: null,
    pointers: new Map(),
    pinch: null,
    swipe: null,
    lastTap: 0
};

function snapVideoTrack() {
    return state.mediaStream?.getVideoTracks?.()[0] || null;
}

// Nach dem Kamerastart: Licht-Knopf nur, wenn die Kamera eine Lampe hat; Zoom-Bereich merken.
function updateSnapCameraCapabilities() {
    const track = snapVideoTrack();
    const capabilities = track?.getCapabilities?.() || {};
    snapCamera.torch = false;
    const torchButton = document.getElementById('snap-torch-btn');
    torchButton.classList.toggle('hidden', !capabilities.torch);
    torchButton.classList.toggle('flex', Boolean(capabilities.torch));
    torchButton.setAttribute('aria-pressed', 'false');
    snapCamera.zoom = capabilities.zoom && capabilities.zoom.max > capabilities.zoom.min
        ? { min: capabilities.zoom.min, max: capabilities.zoom.max, value: track.getSettings?.().zoom ?? capabilities.zoom.min }
        : null;
}

async function toggleSnapTorch() {
    const track = snapVideoTrack();
    if (!track) return;
    const next = !snapCamera.torch;
    try {
        await track.applyConstraints({ advanced: [{ torch: next }] });
        snapCamera.torch = next;
        const button = document.getElementById('snap-torch-btn');
        button.setAttribute('aria-pressed', String(next));
        button.classList.toggle('bg-amber-500', next);
        button.classList.toggle('bg-black/50', !next);
    } catch (error) {
        logDebug(`Torch failed: ${error.message}`);
    }
}

async function setSnapZoom(value) {
    const track = snapVideoTrack();
    const zoom = snapCamera.zoom;
    if (!track || !zoom) return;
    const clamped = Math.min(zoom.max, Math.max(zoom.min, value));
    zoom.value = clamped;
    const label = document.getElementById('snap-zoom-label');
    label.textContent = `${clamped.toFixed(1)}x`;
    label.classList.remove('hidden');
    clearTimeout(snapCamera.zoomLabelTimer);
    snapCamera.zoomLabelTimer = setTimeout(() => label.classList.add('hidden'), 800);
    await track.applyConstraints({ advanced: [{ zoom: clamped }] }).catch(error => logDebug(`Zoom failed: ${error.message}`));
}

// ----- Gesten auf dem Vorschaubild -----
function handleSnapStageDown(event) {
    snapCamera.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (snapCamera.pointers.size === 2) {
        const [first, second] = [...snapCamera.pointers.values()];
        snapCamera.pinch = snapCamera.zoom
            ? { distance: Math.hypot(first.x - second.x, first.y - second.y), zoom: snapCamera.zoom.value }
            : null;
        snapCamera.swipe = null;
        return;
    }
    snapCamera.swipe = { startX: event.clientX, startY: event.clientY, deltaY: 0 };
}

function handleSnapStageMove(event) {
    if (!snapCamera.pointers.has(event.pointerId)) return;
    snapCamera.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (snapCamera.pinch && snapCamera.pointers.size === 2) {
        const [first, second] = [...snapCamera.pointers.values()];
        const distance = Math.hypot(first.x - second.x, first.y - second.y);
        const range = snapCamera.zoom.max - snapCamera.zoom.min;
        setSnapZoom(snapCamera.pinch.zoom + ((distance - snapCamera.pinch.distance) / 200) * range * 0.5);
        return;
    }
    const swipe = snapCamera.swipe;
    if (!swipe) return;
    swipe.deltaY = event.clientY - swipe.startY;
    swipe.deltaX = event.clientX - swipe.startX;
    if (swipe.deltaY > 0 && Math.abs(swipe.deltaY) > Math.abs(swipe.deltaX)) {
        document.getElementById('snap-camera-stage').style.transform = `translate3d(0, ${swipe.deltaY}px, 0)`;
    }
}

function handleSnapStageUp(event) {
    snapCamera.pointers.delete(event.pointerId);
    if (snapCamera.pointers.size) return;
    const swipe = snapCamera.swipe;
    snapCamera.swipe = null;
    const wasPinch = Boolean(snapCamera.pinch);
    snapCamera.pinch = null;
    const stage = document.getElementById('snap-camera-stage');
    stage.style.transition = prefersReducedMotion() ? 'none' : 'transform 200ms ease-out';
    stage.style.transform = '';
    setTimeout(() => { stage.style.transition = ''; }, 220);
    if (wasPinch || !swipe) return;
    if (swipe.deltaY > SNAP_SWIPE_CLOSE && Math.abs(swipe.deltaY) > Math.abs(swipe.deltaX || 0)) {
        closeSnapModal();
        return;
    }
    // Seitlich wischen: Snap <-> Bild.
    if (Math.abs(swipe.deltaX || 0) > SNAP_SWIPE_MODE && Math.abs(swipe.deltaX) > Math.abs(swipe.deltaY) * 1.5) {
        if (state.snapTarget !== 'status') toggleSnapSendMode();
        return;
    }
    // Kurzer Tipp ohne Bewegung: zweimal kurz hintereinander = Kamera wechseln.
    if (Math.hypot(swipe.deltaX || 0, swipe.deltaY) < GESTURE_LOCK_DISTANCE) {
        const now = Date.now();
        if (now - snapCamera.lastTap < SNAP_DOUBLE_TAP_MS) {
            snapCamera.lastTap = 0;
            hapticTick();
            switchSnapCamera();
        } else {
            snapCamera.lastTap = now;
        }
    }
}

// ----- Am Ausloeser hochwischen = Galerie -----
function attachSnapGallerySwipe(area) {
    let start = null;
    area.addEventListener('pointerdown', event => {
        start = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    });
    area.addEventListener('pointerup', event => {
        if (!start || start.pointerId !== event.pointerId) return;
        const deltaY = start.y - event.clientY;
        const deltaX = Math.abs(event.clientX - start.x);
        start = null;
        if (deltaY > SNAP_SWIPE_GALLERY && deltaY > deltaX) {
            hapticTick();
            document.getElementById('snap-file-input').click();
        }
    });
    area.addEventListener('pointercancel', () => {
        start = null;
    });
}

function initSnapCamera() {
    const stage = document.getElementById('snap-camera-stage');
    if (stage) {
        stage.addEventListener('pointerdown', handleSnapStageDown);
        stage.addEventListener('pointermove', handleSnapStageMove);
        stage.addEventListener('pointerup', handleSnapStageUp);
        stage.addEventListener('pointercancel', handleSnapStageUp);
    }
    const controls = document.getElementById('snap-live-controls');
    if (controls) attachSnapGallerySwipe(controls);
}
