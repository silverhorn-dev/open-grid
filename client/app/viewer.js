// ================= BILDBETRACHTER =================
// Vollbild-Viewer fuer Snaps, Album- und Galeriebilder: Wischen zum Blaettern,
// Pinch/Doppeltipp/Mausrad zum Zoomen, Ziehen zum Verschieben, nach unten wischen zum Schliessen.
const VIEWER_MAX_SCALE = 5;
const VIEWER_DOUBLE_TAP_SCALE = 2.5;
const VIEWER_SWIPE_THRESHOLD = 60;
const VIEWER_CLOSE_THRESHOLD = 110;

const viewer = {
    images: [],
    index: 0,
    scale: 1,
    x: 0,
    y: 0,
    pointers: new Map(),
    gesture: null,
    lastTap: 0
};

function openImageViewer(images, startIndex = 0) {
    const safeImages = images.filter(isSafeInlineImage);
    if (!safeImages.length) return;
    viewer.images = safeImages;
    viewer.index = Math.min(Math.max(startIndex, 0), safeImages.length - 1);
    const element = document.getElementById('image-viewer');
    if (element.classList.contains('hidden')) {
        element.classList.remove('hidden');
        pushModalEntry('viewer', hideImageViewer);
    }
    showViewerImage();
}

function closeImageViewer() {
    dismissModalEntry('viewer', hideImageViewer);
}

function hideImageViewer() {
    document.getElementById('image-viewer').classList.add('hidden');
    document.getElementById('image-viewer-image').src = '';
    viewer.images = [];
    viewer.pointers.clear();
    viewer.gesture = null;
}

function isImageViewerOpen() {
    return !document.getElementById('image-viewer').classList.contains('hidden');
}

function showViewerImage() {
    resetViewerTransform();
    document.getElementById('image-viewer-image').src = viewer.images[viewer.index];
    const multiple = viewer.images.length > 1;
    document.getElementById('image-viewer-counter').textContent = multiple ? `${viewer.index + 1} / ${viewer.images.length}` : '';
    document.getElementById('image-viewer-prev').classList.toggle('invisible', !multiple || viewer.index === 0);
    document.getElementById('image-viewer-next').classList.toggle('invisible', !multiple || viewer.index === viewer.images.length - 1);
}

function stepImageViewer(direction) {
    const next = viewer.index + direction;
    if (next < 0 || next >= viewer.images.length) {
        applyViewerTransform(true);
        return;
    }
    viewer.index = next;
    showViewerImage();
}

function resetViewerTransform() {
    viewer.scale = 1;
    viewer.x = 0;
    viewer.y = 0;
    applyViewerTransform(true);
}

// Verschiebung so begrenzen, dass das gezoomte Bild den Rahmen nicht verlaesst.
function clampViewerPan() {
    const image = document.getElementById('image-viewer-image');
    const maxX = Math.max(0, (image.clientWidth * viewer.scale - image.clientWidth) / 2);
    const maxY = Math.max(0, (image.clientHeight * viewer.scale - image.clientHeight) / 2);
    viewer.x = Math.min(maxX, Math.max(-maxX, viewer.x));
    viewer.y = Math.min(maxY, Math.max(-maxY, viewer.y));
}

function applyViewerTransform(animate = false, extraY = 0, extraX = 0) {
    const image = document.getElementById('image-viewer-image');
    image.style.transition = animate ? 'transform 200ms ease-out' : 'none';
    image.style.transform = `translate(${viewer.x + extraX}px, ${viewer.y + extraY}px) scale(${viewer.scale})`;
    const backdrop = document.getElementById('image-viewer');
    backdrop.style.backgroundColor = extraY > 0 ? `rgba(0, 0, 0, ${Math.max(0.3, 1 - extraY / 400)})` : '';
}

function zoomViewerAt(nextScale, clientX, clientY) {
    const image = document.getElementById('image-viewer-image');
    const rect = image.getBoundingClientRect();
    const scale = Math.min(VIEWER_MAX_SCALE, Math.max(1, nextScale));
    // Punkt unter dem Finger/Mauszeiger bleibt beim Zoomen an Ort und Stelle.
    const offsetX = clientX - (rect.left + rect.width / 2);
    const offsetY = clientY - (rect.top + rect.height / 2);
    const ratio = scale / viewer.scale;
    viewer.x -= offsetX * (ratio - 1);
    viewer.y -= offsetY * (ratio - 1);
    viewer.scale = scale;
    if (scale === 1) {
        viewer.x = 0;
        viewer.y = 0;
    }
    clampViewerPan();
}

function pointerDistance() {
    const [first, second] = [...viewer.pointers.values()];
    return Math.hypot(first.x - second.x, first.y - second.y);
}

function pointerCenter() {
    const [first, second] = [...viewer.pointers.values()];
    return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
}

function handleViewerPointerDown(event) {
    if (event.target.closest('button')) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    viewer.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (viewer.pointers.size === 2) {
        viewer.gesture = { type: 'pinch', distance: pointerDistance(), scale: viewer.scale };
    } else if (viewer.pointers.size === 1) {
        viewer.gesture = { type: 'drag', startX: event.clientX, startY: event.clientY, x: viewer.x, y: viewer.y, moved: false };
    }
}

function handleViewerPointerMove(event) {
    if (!viewer.pointers.has(event.pointerId)) return;
    viewer.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const gesture = viewer.gesture;
    if (!gesture) return;
    if (gesture.type === 'pinch' && viewer.pointers.size === 2) {
        const center = pointerCenter();
        zoomViewerAt(gesture.scale * (pointerDistance() / gesture.distance), center.x, center.y);
        applyViewerTransform();
        return;
    }
    if (gesture.type !== 'drag') return;
    const deltaX = event.clientX - gesture.startX;
    const deltaY = event.clientY - gesture.startY;
    if (Math.abs(deltaX) > 5 || Math.abs(deltaY) > 5) gesture.moved = true;
    if (viewer.scale > 1) {
        viewer.x = gesture.x + deltaX;
        viewer.y = gesture.y + deltaY;
        clampViewerPan();
        applyViewerTransform();
    } else if (Math.abs(deltaY) > Math.abs(deltaX) && deltaY > 0) {
        applyViewerTransform(false, deltaY);
    } else {
        applyViewerTransform(false, 0, deltaX);
    }
}

function handleViewerPointerUp(event) {
    if (!viewer.pointers.has(event.pointerId)) return;
    viewer.pointers.delete(event.pointerId);
    const gesture = viewer.gesture;
    if (gesture?.type === 'pinch') {
        // Nach dem Pinch mit dem verbleibenden Finger weiter verschieben.
        const remaining = [...viewer.pointers.values()][0];
        viewer.gesture = remaining
            ? { type: 'drag', startX: remaining.x, startY: remaining.y, x: viewer.x, y: viewer.y, moved: true }
            : null;
        if (viewer.scale <= 1.02) resetViewerTransform();
        return;
    }
    viewer.gesture = null;
    if (gesture?.type !== 'drag') return;
    const deltaX = event.clientX - gesture.startX;
    const deltaY = event.clientY - gesture.startY;
    if (!gesture.moved) {
        handleViewerTap(event);
        return;
    }
    if (viewer.scale > 1) return;
    if (deltaY > VIEWER_CLOSE_THRESHOLD && Math.abs(deltaY) > Math.abs(deltaX)) {
        closeImageViewer();
    } else if (Math.abs(deltaX) > VIEWER_SWIPE_THRESHOLD && Math.abs(deltaX) > Math.abs(deltaY)) {
        stepImageViewer(deltaX < 0 ? 1 : -1);
    } else {
        applyViewerTransform(true);
    }
}

function handleViewerTap(event) {
    const now = Date.now();
    if (now - viewer.lastTap < 300) {
        viewer.lastTap = 0;
        zoomViewerAt(viewer.scale > 1 ? 1 : VIEWER_DOUBLE_TAP_SCALE, event.clientX, event.clientY);
        applyViewerTransform(true);
        return;
    }
    viewer.lastTap = now;
}

function handleViewerWheel(event) {
    event.preventDefault();
    zoomViewerAt(viewer.scale * (event.deltaY < 0 ? 1.15 : 1 / 1.15), event.clientX, event.clientY);
    applyViewerTransform();
}

function handleViewerKeydown(event) {
    if (!isImageViewerOpen()) return;
    if (event.key === 'Escape') closeImageViewer();
    else if (event.key === 'ArrowLeft') stepImageViewer(-1);
    else if (event.key === 'ArrowRight') stepImageViewer(1);
    else return;
    event.stopPropagation();
}

function initImageViewer() {
    const stage = document.getElementById('image-viewer-stage');
    if (!stage) return;
    stage.addEventListener('pointerdown', handleViewerPointerDown);
    stage.addEventListener('pointermove', handleViewerPointerMove);
    stage.addEventListener('pointerup', handleViewerPointerUp);
    stage.addEventListener('pointercancel', handleViewerPointerUp);
    stage.addEventListener('wheel', handleViewerWheel, { passive: false });
    document.addEventListener('keydown', handleViewerKeydown, true);
}
