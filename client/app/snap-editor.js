// ================= SNAP-EDITOR =================
// Nach der Aufnahme: zeichnen, Text und Emojis auf das Bild legen. Beim Senden wird alles in ein
// einziges JPEG "geflacht" (flattenSnapDraft) und erst dann mit Wasserzeichen kodiert (encodeSnap),
// der Empfaenger bekommt also keine Ebenen oder Metadaten.
const SNAP_EDIT_COLORS = ['#ffffff', '#111111', '#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#ec4899'];
const SNAP_EDIT_EMOJIS = ['😂', '😍', '🔥', '❤️', '😎', '🥳', '😮', '👍', '🌈', '✨', '💋', '🎉'];
const SNAP_TEXT_SIZE = 0.07;
const SNAP_EMOJI_SIZE = 0.14;
const SNAP_STROKE_WIDTH = 0.012;

const snapEditor = {
    base: null,
    tool: null,
    color: SNAP_EDIT_COLORS[0],
    strokes: [],
    items: [],
    history: [],
    activeStroke: null,
    drag: null,
    lastItemTap: null
};

// Rohbild ohne Wasserzeichen in voller Aufloesung (max. ORIGINAL_MAX_EDGE, fuer "Original");
// Snaps und Vorschauen verkleinert encodeSnap beim Senden.
function captureSnapBase(source, width, height, mirror = false) {
    const scale = Math.min(1, ORIGINAL_MAX_EDGE / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d');
    if (mirror) {
        context.translate(canvas.width, 0);
        context.scale(-1, 1);
    }
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas;
}

function openSnapEditor(base) {
    snapEditor.base = base;
    snapEditor.tool = null;
    snapEditor.strokes = [];
    snapEditor.items = [];
    snapEditor.history = [];
    const baseCanvas = document.getElementById('snap-edit-base');
    const drawCanvas = document.getElementById('snap-edit-draw');
    baseCanvas.width = drawCanvas.width = base.width;
    baseCanvas.height = drawCanvas.height = base.height;
    baseCanvas.getContext('2d').drawImage(base, 0, 0);
    drawCanvas.getContext('2d').clearRect(0, 0, base.width, base.height);
    document.getElementById('snap-edit-layers').replaceChildren();
    document.getElementById('snap-editor').classList.remove('hidden');
    document.getElementById('snap-edit-tools').classList.remove('hidden');
    document.getElementById('snap-live-tools').classList.add('hidden');
    renderSnapColorRow();
    renderSnapEmojiRow();
    updateSnapToolButtons();
    fitSnapEditorStage();
}

function closeSnapEditor() {
    snapEditor.base = null;
    snapEditor.strokes = [];
    snapEditor.items = [];
    snapEditor.history = [];
    snapEditor.tool = null;
    ['snap-edit-base', 'snap-edit-draw'].forEach(id => {
        const canvas = document.getElementById(id);
        if (canvas) canvas.width = canvas.height = 0;
    });
    document.getElementById('snap-edit-layers')?.replaceChildren();
    document.getElementById('snap-editor')?.classList.add('hidden');
    document.getElementById('snap-edit-tools')?.classList.add('hidden');
    document.getElementById('snap-text-entry')?.classList.add('hidden');
    document.getElementById('snap-emoji-row')?.classList.add('hidden');
    document.getElementById('snap-live-tools')?.classList.remove('hidden');
}

function hasSnapDraft() {
    return Boolean(snapEditor.base);
}

// Buehne im Seitenverhaeltnis des Bildes, so gross wie moeglich (object-contain).
function fitSnapEditorStage() {
    const stage = document.getElementById('snap-editor-stage');
    const container = document.getElementById('snap-editor');
    if (!stage || !snapEditor.base || container.classList.contains('hidden')) return;
    const ratio = snapEditor.base.width / snapEditor.base.height;
    const width = Math.min(container.clientWidth, container.clientHeight * ratio);
    stage.style.width = `${Math.round(width)}px`;
    stage.style.height = `${Math.round(width / ratio)}px`;
}

function renderSnapColorRow() {
    const row = document.getElementById('snap-color-row');
    row.replaceChildren(...SNAP_EDIT_COLORS.map(color => {
        const swatch = document.createElement('button');
        swatch.type = 'button';
        swatch.className = `w-7 h-7 rounded-full border-2 ${color === snapEditor.color ? 'border-white scale-110' : 'border-white/30'}`;
        swatch.style.backgroundColor = color;
        swatch.setAttribute('role', 'radio');
        swatch.setAttribute('aria-checked', String(color === snapEditor.color));
        swatch.setAttribute('aria-label', t('snaps.colour', { color }));
        swatch.onclick = () => {
            snapEditor.color = color;
            renderSnapColorRow();
        };
        return swatch;
    }));
}

function renderSnapEmojiRow() {
    const row = document.getElementById('snap-emoji-row');
    row.replaceChildren(...SNAP_EDIT_EMOJIS.map(emoji => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'w-10 h-10 text-2xl rounded-lg hover:bg-white/10';
        button.textContent = emoji;
        button.onclick = () => {
            addSnapItem({ kind: 'emoji', text: emoji, size: SNAP_EMOJI_SIZE, color: '#ffffff' });
            row.classList.add('hidden');
        };
        return button;
    }));
}

function updateSnapToolButtons() {
    const draw = document.getElementById('snap-tool-draw');
    const active = snapEditor.tool === 'draw';
    draw.setAttribute('aria-pressed', String(active));
    draw.classList.toggle('bg-brand-600', active);
    draw.classList.toggle('bg-black/50', !active);
    document.getElementById('snap-edit-draw').style.pointerEvents = active ? 'auto' : 'none';
}

function setSnapEditTool(tool) {
    snapEditor.tool = snapEditor.tool === tool ? null : tool;
    updateSnapToolButtons();
}

function toggleSnapEmojiPicker() {
    document.getElementById('snap-text-entry').classList.add('hidden');
    document.getElementById('snap-emoji-row').classList.toggle('hidden');
}

function startSnapText() {
    document.getElementById('snap-emoji-row').classList.add('hidden');
    const entry = document.getElementById('snap-text-entry');
    entry.classList.remove('hidden');
    const input = document.getElementById('snap-text-input');
    input.value = '';
    input.focus();
}

function commitSnapText() {
    const input = document.getElementById('snap-text-input');
    const text = input.value.trim().substring(0, 80);
    document.getElementById('snap-text-entry').classList.add('hidden');
    input.blur();
    if (text) addSnapItem({ kind: 'text', text, size: SNAP_TEXT_SIZE, color: snapEditor.color });
}

// ----- Text- und Emoji-Ebenen (Position relativ 0..1, Groesse relativ zur Bildbreite) -----
function addSnapItem(item) {
    const entry = { id: window.crypto.randomUUID(), x: 0.5, y: 0.5, ...item };
    snapEditor.items.push(entry);
    snapEditor.history.push({ type: 'item', id: entry.id });
    renderSnapItems();
}

function renderSnapItems() {
    const layers = document.getElementById('snap-edit-layers');
    const stageWidth = document.getElementById('snap-editor-stage').clientWidth || 1;
    layers.replaceChildren(...snapEditor.items.map(item => {
        const element = document.createElement('div');
        element.className = 'snap-edit-item absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap font-bold pointer-events-auto cursor-move';
        element.dataset.itemId = item.id;
        element.textContent = item.text;
        element.style.left = `${item.x * 100}%`;
        element.style.top = `${item.y * 100}%`;
        element.style.fontSize = `${item.size * stageWidth}px`;
        element.style.color = item.color;
        element.style.textShadow = item.kind === 'text' ? '0 1px 3px rgba(0,0,0,0.8)' : '';
        element.addEventListener('pointerdown', event => startSnapItemDrag(event, item));
        return element;
    }));
}

function startSnapItemDrag(event, item) {
    event.preventDefault();
    event.stopPropagation();
    const now = Date.now();
    // Doppelt tippen entfernt die Ebene.
    if (snapEditor.lastItemTap?.id === item.id && now - snapEditor.lastItemTap.at < 300) {
        snapEditor.items = snapEditor.items.filter(entry => entry.id !== item.id);
        snapEditor.lastItemTap = null;
        renderSnapItems();
        return;
    }
    snapEditor.lastItemTap = { id: item.id, at: now };
    snapEditor.drag = { item, pointerId: event.pointerId };
    event.currentTarget.setPointerCapture?.(event.pointerId);
}

function moveSnapItem(event) {
    const drag = snapEditor.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const rect = document.getElementById('snap-editor-stage').getBoundingClientRect();
    drag.item.x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    drag.item.y = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
    const element = document.querySelector(`#snap-edit-layers [data-item-id="${drag.item.id}"]`);
    if (element) {
        element.style.left = `${drag.item.x * 100}%`;
        element.style.top = `${drag.item.y * 100}%`;
    }
}

function endSnapItemDrag(event) {
    if (snapEditor.drag?.pointerId === event.pointerId) snapEditor.drag = null;
}

// ----- Zeichnen -----
function canvasPoint(canvas, event) {
    const rect = canvas.getBoundingClientRect();
    return {
        x: ((event.clientX - rect.left) / rect.width) * canvas.width,
        y: ((event.clientY - rect.top) / rect.height) * canvas.height
    };
}

function drawSnapStroke(context, stroke) {
    if (!stroke.points.length) return;
    context.strokeStyle = stroke.color;
    context.fillStyle = stroke.color;
    context.lineWidth = stroke.width;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.beginPath();
    context.moveTo(stroke.points[0].x, stroke.points[0].y);
    if (stroke.points.length === 1) {
        context.arc(stroke.points[0].x, stroke.points[0].y, stroke.width / 2, 0, Math.PI * 2);
        context.fill();
        return;
    }
    stroke.points.slice(1).forEach(point => context.lineTo(point.x, point.y));
    context.stroke();
}

function redrawSnapStrokes() {
    const canvas = document.getElementById('snap-edit-draw');
    const context = canvas.getContext('2d');
    context.clearRect(0, 0, canvas.width, canvas.height);
    snapEditor.strokes.forEach(stroke => drawSnapStroke(context, stroke));
}

function startSnapStroke(event) {
    if (snapEditor.tool !== 'draw') return;
    const canvas = event.currentTarget;
    canvas.setPointerCapture?.(event.pointerId);
    snapEditor.activeStroke = {
        pointerId: event.pointerId,
        color: snapEditor.color,
        width: Math.max(2, canvas.width * SNAP_STROKE_WIDTH),
        points: [canvasPoint(canvas, event)]
    };
    snapEditor.strokes.push(snapEditor.activeStroke);
    snapEditor.history.push({ type: 'stroke' });
    redrawSnapStrokes();
}

function continueSnapStroke(event) {
    const stroke = snapEditor.activeStroke;
    if (!stroke || stroke.pointerId !== event.pointerId) return;
    const canvas = event.currentTarget;
    const point = canvasPoint(canvas, event);
    const context = canvas.getContext('2d');
    const last = stroke.points.at(-1);
    stroke.points.push(point);
    context.strokeStyle = stroke.color;
    context.lineWidth = stroke.width;
    context.lineCap = 'round';
    context.beginPath();
    context.moveTo(last.x, last.y);
    context.lineTo(point.x, point.y);
    context.stroke();
}

function endSnapStroke(event) {
    if (snapEditor.activeStroke?.pointerId === event.pointerId) snapEditor.activeStroke = null;
}

function undoSnapEdit() {
    const last = snapEditor.history.pop();
    if (!last) return;
    if (last.type === 'stroke') {
        snapEditor.strokes.pop();
        redrawSnapStrokes();
    } else {
        snapEditor.items = snapEditor.items.filter(item => item.id !== last.id);
        renderSnapItems();
    }
}

// ----- Flatten -----
// Ein Canvas in Bildgroesse: Bild, Zeichnung, dann Text/Emojis.
function flattenSnapDraft() {
    const base = snapEditor.base;
    if (!base) return null;
    const canvas = document.createElement('canvas');
    canvas.width = base.width;
    canvas.height = base.height;
    const context = canvas.getContext('2d');
    context.drawImage(base, 0, 0);
    snapEditor.strokes.forEach(stroke => drawSnapStroke(context, stroke));
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    snapEditor.items.forEach(item => {
        context.font = `bold ${Math.round(item.size * canvas.width)}px system-ui, sans-serif`;
        if (item.kind === 'text') {
            context.shadowColor = 'rgba(0, 0, 0, 0.8)';
            context.shadowBlur = Math.round(canvas.width * 0.006);
        } else {
            context.shadowBlur = 0;
        }
        context.fillStyle = item.color;
        context.fillText(item.text, item.x * canvas.width, item.y * canvas.height);
    });
    return canvas;
}

function initSnapEditor() {
    const draw = document.getElementById('snap-edit-draw');
    if (!draw) return;
    draw.style.pointerEvents = 'none';
    draw.addEventListener('pointerdown', startSnapStroke);
    draw.addEventListener('pointermove', continueSnapStroke);
    draw.addEventListener('pointerup', endSnapStroke);
    draw.addEventListener('pointercancel', endSnapStroke);
    document.addEventListener('pointermove', moveSnapItem);
    document.addEventListener('pointerup', endSnapItemDrag);
    document.addEventListener('pointercancel', endSnapItemDrag);
    window.addEventListener('resize', () => {
        fitSnapEditorStage();
        if (hasSnapDraft()) renderSnapItems();
    });
}
