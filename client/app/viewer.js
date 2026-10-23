// ================= BILDBETRACHTER =================
// Vollbild-Viewer fuer Snaps, Album- und Galeriebilder: Wischen zum Blaettern,
// Pinch/Doppeltipp/Mausrad zum Zoomen, Ziehen zum Verschieben, nach unten wischen zum Schliessen.
// Drei Slides (vorher/aktuell/naechstes) liegen in einer Spur; beim Wischen wird nur die Spur
// verschoben. Alle Stil-Updates laufen gebuendelt ueber requestAnimationFrame.
const VIEWER_MAX_SCALE = 5;
const VIEWER_DOUBLE_TAP_SCALE = 2.5;
const VIEWER_SWIPE_THRESHOLD = 0.18; // Anteil der Breite
const VIEWER_SWIPE_VELOCITY = 0.4; // px/ms, schnelles Wischen reicht auch bei kurzer Strecke
const VIEWER_CLOSE_THRESHOLD = 110;
const VIEWER_SLIDE_MS = 260;

const viewer = {
    images: [],
    index: 0,
    scale: 1,
    x: 0,
    y: 0,
    trackOffset: 0,
    closeOffset: 0,
    pointers: new Map(),
    gesture: null,
    lastTap: 0,
    frame: 0,
    animating: false,
    size: { width: 0, height: 0, imageWidth: 0, imageHeight: 0 }
};

function viewerElement(id) {
    return document.getElementById(id);
}

function openImageViewer(images, startIndex = 0) {
    const safeImages = images.filter(isSafeInlineImage);
    if (!safeImages.length) return;
    viewer.images = safeImages;
    viewer.index = Math.min(Math.max(startIndex, 0), safeImages.length - 1);
    const element = viewerElement('image-viewer');
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
    viewerElement('image-viewer').classList.add('hidden');
    ['image-viewer-image', 'image-viewer-prev-image', 'image-viewer-next-image'].forEach(id => viewerElement(id).removeAttribute('src'));
    viewer.images = [];
    viewer.pointers.clear();
    viewer.gesture = null;
    viewer.animating = false;
}

function isImageViewerOpen() {
    return !viewerElement('image-viewer').classList.contains('hidden');
}

function setSlideImage(id, dataUrl) {
    const image = viewerElement(id);
    if (dataUrl) image.src = dataUrl;
    else image.removeAttribute('src');
}

function showViewerImage() {
    viewer.scale = 1;
    viewer.x = 0;
    viewer.y = 0;
    viewer.trackOffset = 0;
    viewer.closeOffset = 0;
    setSlideImage('image-viewer-prev-image', viewer.images[viewer.index - 1]);
    setSlideImage('image-viewer-image', viewer.images[viewer.index]);
    setSlideImage('image-viewer-next-image', viewer.images[viewer.index + 1]);
    const multiple = viewer.images.length > 1;
    viewerElement('image-viewer-counter').textContent = multiple ? `${viewer.index + 1} / ${viewer.images.length}` : '';
    viewerElement('image-viewer-prev').classList.toggle('invisible', !multiple || viewer.index === 0);
    viewerElement('image-viewer-next').classList.toggle('invisible', !multiple || viewer.index === viewer.images.length - 1);
    renderViewer(false);
}

// Schreibt den aktuellen Zustand in den DOM, hoechstens einmal pro Frame.
function scheduleViewerRender() {
    if (viewer.frame) return;
    viewer.frame = requestAnimationFrame(() => {
        viewer.frame = 0;
        renderViewer(false);
    });
}

function renderViewer(animate) {
    const track = viewerElement('image-viewer-track');
    const image = viewerElement('image-viewer-image');
    const transition = animate ? `transform ${VIEWER_SLIDE_MS}ms cubic-bezier(0.22, 0.61, 0.36, 1)` : 'none';
    track.style.transition = transition;
    image.style.transition = transition;
    track.style.transform = `translate3d(calc(-33.3333% + ${viewer.trackOffset}px), 0, 0)`;
    image.style.transform = `translate3d(${viewer.x}px, ${viewer.y + viewer.closeOffset}px, 0) scale(${viewer.scale})`;
    viewerElement('image-viewer').style.backgroundColor = viewer.closeOffset > 0
        ? `rgba(0, 0, 0, ${Math.max(0.3, 1 - viewer.closeOffset / 400)})`
        : '';
}

// Faehrt die Spur zum Nachbarbild und tauscht danach die Slides ohne Animation.
function stepImageViewer(direction) {
    if (viewer.animating) return;
    const next = viewer.index + direction;
    if (next < 0 || next >= viewer.images.length) {
        viewer.trackOffset = 0;
        renderViewer(true);
        return;
    }
    viewer.animating = true;
    viewer.scale = 1;
    viewer.x = 0;
    viewer.y = 0;
    viewer.trackOffset = -direction * viewerElement('image-viewer-stage').clientWidth;
    renderViewer(true);
    setTimeout(() => {
        viewer.index = next;
        viewer.animating = false;
        showViewerImage();
    }, VIEWER_SLIDE_MS);
}

function measureViewer() {
    const stage = viewerElement('image-viewer-stage');
    const image = viewerElement('image-viewer-image');
    viewer.size = {
        width: stage.clientWidth,
        height: stage.clientHeight,
        imageWidth: image.clientWidth,
        imageHeight: image.clientHeight
    };
}

// Verschiebung so begrenzen, dass das gezoomte Bild den Rahmen nicht verlaesst.
function clampViewerPan() {
    const { imageWidth, imageHeight } = viewer.size;
    const maxX = Math.max(0, (imageWidth * viewer.scale - imageWidth) / 2);
    const maxY = Math.max(0, (imageHeight * viewer.scale - imageHeight) / 2);
    viewer.x = Math.min(maxX, Math.max(-maxX, viewer.x));
    viewer.y = Math.min(maxY, Math.max(-maxY, viewer.y));
}

function zoomViewerAt(nextScale, clientX, clientY) {
    const stage = viewerElement('image-viewer-stage').getBoundingClientRect();
    const scale = Math.min(VIEWER_MAX_SCALE, Math.max(1, nextScale));
    // Punkt unter dem Finger/Mauszeiger bleibt beim Zoomen an Ort und Stelle.
    const offsetX = clientX - (stage.left + stage.width / 2) - viewer.x;
    const offsetY = clientY - (stage.top + stage.height / 2) - viewer.y;
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

function startDragGesture(x, y) {
    viewer.gesture = { type: 'drag', startX: x, startY: y, x: viewer.x, y: viewer.y, axis: null, moved: false, startedAt: performance.now() };
}

function handleViewerPointerDown(event) {
    if (event.target.closest('button') || viewer.animating) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    viewer.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (viewer.pointers.size === 1) {
        measureViewer();
        startDragGesture(event.clientX, event.clientY);
    } else if (viewer.pointers.size === 2) {
        viewer.trackOffset = 0;
        viewer.closeOffset = 0;
        viewer.gesture = { type: 'pinch', distance: pointerDistance(), scale: viewer.scale };
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
        scheduleViewerRender();
        return;
    }
    if (gesture.type !== 'drag') return;
    const deltaX = event.clientX - gesture.startX;
    const deltaY = event.clientY - gesture.startY;
    if (!gesture.moved && Math.hypot(deltaX, deltaY) > 6) gesture.moved = true;
    if (!gesture.moved) return;

    if (viewer.scale > 1) {
        viewer.x = gesture.x + deltaX;
        viewer.y = gesture.y + deltaY;
        clampViewerPan();
    } else {
        // Achse einmal festlegen, damit Blaettern und Schliessen sich nicht mischen.
        gesture.axis = gesture.axis || (Math.abs(deltaX) >= Math.abs(deltaY) ? 'x' : 'y');
        if (gesture.axis === 'x') {
            const atEdge = (deltaX > 0 && viewer.index === 0) || (deltaX < 0 && viewer.index === viewer.images.length - 1);
            viewer.trackOffset = atEdge ? deltaX * 0.3 : deltaX;
        } else {
            viewer.closeOffset = Math.max(0, deltaY);
        }
    }
    scheduleViewerRender();
}

function handleViewerPointerUp(event) {
    if (!viewer.pointers.has(event.pointerId)) return;
    viewer.pointers.delete(event.pointerId);
    const gesture = viewer.gesture;
    if (gesture?.type === 'pinch') {
        // Nach dem Pinch mit dem verbleibenden Finger weiter verschieben.
        const remaining = [...viewer.pointers.values()][0];
        if (remaining) {
            startDragGesture(remaining.x, remaining.y);
            viewer.gesture.moved = true;
        } else {
            viewer.gesture = null;
        }
        if (viewer.scale <= 1.02) {
            viewer.scale = 1;
            viewer.x = 0;
            viewer.y = 0;
            renderViewer(true);
        }
        return;
    }
    viewer.gesture = null;
    if (gesture?.type !== 'drag') return;
    if (!gesture.moved) {
        handleViewerTap(event);
        return;
    }
    if (viewer.scale > 1) return;
    const deltaX = event.clientX - gesture.startX;
    const deltaY = event.clientY - gesture.startY;
    const elapsed = Math.max(1, performance.now() - gesture.startedAt);
    if (gesture.axis === 'y') {
        if (deltaY > VIEWER_CLOSE_THRESHOLD || deltaY / elapsed > VIEWER_SWIPE_VELOCITY * 2) {
            closeImageViewer();
            return;
        }
        viewer.closeOffset = 0;
        renderViewer(true);
        return;
    }
    const farEnough = Math.abs(deltaX) > viewer.size.width * VIEWER_SWIPE_THRESHOLD;
    const fastEnough = Math.abs(deltaX) / elapsed > VIEWER_SWIPE_VELOCITY;
    if (farEnough || fastEnough) {
        stepImageViewer(deltaX < 0 ? 1 : -1);
    } else {
        viewer.trackOffset = 0;
        renderViewer(true);
    }
}

function handleViewerTap(event) {
    const now = Date.now();
    if (now - viewer.lastTap < 300) {
        viewer.lastTap = 0;
        measureViewer();
        zoomViewerAt(viewer.scale > 1 ? 1 : VIEWER_DOUBLE_TAP_SCALE, event.clientX, event.clientY);
        renderViewer(true);
        return;
    }
    viewer.lastTap = now;
}

function handleViewerWheel(event) {
    event.preventDefault();
    measureViewer();
    zoomViewerAt(viewer.scale * (event.deltaY < 0 ? 1.15 : 1 / 1.15), event.clientX, event.clientY);
    scheduleViewerRender();
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
    const stage = viewerElement('image-viewer-stage');
    if (!stage) return;
    stage.addEventListener('pointerdown', handleViewerPointerDown);
    stage.addEventListener('pointermove', handleViewerPointerMove);
    stage.addEventListener('pointerup', handleViewerPointerUp);
    stage.addEventListener('pointercancel', handleViewerPointerUp);
    stage.addEventListener('wheel', handleViewerWheel, { passive: false });
    document.addEventListener('keydown', handleViewerKeydown, true);
}
