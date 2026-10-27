// ================= SNAP-EDITOR =================
// Nach der Aufnahme: zeichnen, Text und Emojis auf das Bild legen. Beim Senden wird alles in ein
// einziges JPEG "geflacht" (flattenSnapDraft) und erst dann mit Wasserzeichen kodiert (encodeSnap),
// der Empfaenger bekommt also keine Ebenen oder Metadaten.
const SNAP_EDIT_COLORS = ['#ffffff', '#111111', '#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#ec4899'];
const SNAP_EDIT_EMOJIS = ['😂', '😍', '🔥', '❤️', '😎', '🥳', '😮', '👍', '🌈', '✨', '💋', '🎉'];
const SNAP_TEXT_SIZE = 0.07;
const SNAP_EMOJI_SIZE = 0.14;
const SNAP_STROKE_WIDTH = 0.012;
// Gesten (Wunsch 2026-10-27): Element = ein Finger darauf verschiebt, ein zweiter Finger irgendwo
// skaliert und dreht; Hintergrund = zwei Finger auf dem Bild zoomen, drehen und verschieben das Foto.
// Drehung rastet bei 0/90/180/270 Grad ein. Am PC: Mausrad beim Ziehen skaliert, mit Shift dreht es.
const SNAP_ITEM_SCALE_RANGE = [0.3, 6];
const SNAP_BACKGROUND_SCALE_RANGE = [0.5, 5];
const SNAP_ROTATION_SNAP = (6 * Math.PI) / 180;
// Textarten (nur Schriften, die das Geraet ohnehin hat; keine Webfonts von aussen).
const SNAP_TEXT_STYLES = {
    classic: { family: 'system-ui, sans-serif', weight: '700', style: 'normal' },
    serif: { family: 'Georgia, "Times New Roman", serif', weight: '700', style: 'italic' },
    mono: { family: 'ui-monospace, "SFMono-Regular", "Courier New", monospace', weight: '700', style: 'normal' },
    hand: { family: '"Segoe Print", "Bradley Hand", "Comic Sans MS", cursive', weight: '400', style: 'normal' },
    neon: { family: 'system-ui, sans-serif', weight: '800', style: 'normal', glow: true }
};
const SNAP_TEXT_STYLE_ORDER = Object.keys(SNAP_TEXT_STYLES);
// Texthintergrund: keiner, abgedunkelt, voll in der Textfarbe (Text dann schwarz oder weiss).
const SNAP_TEXT_BACKGROUNDS = ['none', 'shade', 'solid'];
// Filter fuer das Foto (Pixel-Operationen, gehen also auch ohne canvas.filter, z. B. auf iOS).
const SNAP_FILTERS = ['original', 'bw', 'vivid', 'red'];

const snapEditor = {
    base: null,
    tool: null,
    color: SNAP_EDIT_COLORS[0],
    strokes: [],
    items: [],
    history: [],
    activeStroke: null,
    lastItemTap: null,
    // Text, der gerade nachbearbeitet wird (Tipp auf eine Text-Ebene), und der verzoegerte Tipp
    // (ein zweiter Tipp innerhalb 300 ms loescht stattdessen).
    editingItemId: null,
    pendingTextEdit: null,
    // Foto unter Zeichnung und Ebenen: Zoom, Drehung (rad), Verschiebung relativ zur Bildgroesse.
    background: { scale: 1, rotation: 0, x: 0, y: 0 },
    filter: 'original',
    filteredBase: null,
    textStyle: 'classic',
    textBackground: 'none',
    gesture: { pointers: new Map(), mode: null, item: null, itemPointerId: null, offset: null, start: null, swipe: null, snapped: false }
};

const clampTo = ([min, max], value) => Math.min(max, Math.max(min, value));

// Winkel nahe einem Vielfachen von 90 Grad rasten ein.
function snapEditorRotation(angle) {
    const quarter = Math.PI / 2;
    const nearest = Math.round(angle / quarter) * quarter;
    return Math.abs(angle - nearest) < SNAP_ROTATION_SNAP ? nearest : angle;
}

function noteRotationSnap(angle) {
    const snapped = angle === snapEditorRotation(angle) && Math.abs(angle % (Math.PI / 2)) < 1e-9;
    if (snapped && !snapEditor.gesture.snapped) hapticTick();
    snapEditor.gesture.snapped = snapped;
}

function pointerPair(pointers) {
    const [first, second] = [...pointers.values()];
    return {
        distance: Math.hypot(second.x - first.x, second.y - first.y) || 1,
        angle: Math.atan2(second.y - first.y, second.x - first.x),
        mid: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 }
    };
}

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
    snapEditor.background = { scale: 1, rotation: 0, x: 0, y: 0 };
    snapEditor.filter = 'original';
    snapEditor.filteredBase = null;
    snapEditor.editingItemId = null;
    clearTimeout(snapEditor.pendingTextEdit);
    resetSnapEditorGesture();
    const baseCanvas = document.getElementById('snap-edit-base');
    const drawCanvas = document.getElementById('snap-edit-draw');
    baseCanvas.width = drawCanvas.width = base.width;
    baseCanvas.height = drawCanvas.height = base.height;
    redrawSnapBackground();
    drawCanvas.getContext('2d').clearRect(0, 0, base.width, base.height);
    document.getElementById('snap-edit-layers').replaceChildren();
    document.getElementById('snap-editor').classList.remove('hidden');
    document.getElementById('snap-edit-tools').classList.remove('hidden');
    document.getElementById('snap-live-tools').classList.add('hidden');
    renderSnapColorRow();
    renderSnapEmojiRow();
    renderSnapFilterRow();
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

const SNAP_ITEM_TRANSFORM_KEYS = ['x', 'y', 'scale', 'rotation'];
const SNAP_ITEM_TEXT_KEYS = ['text', 'font', 'background', 'color'];
const pickKeys = (source, keys) => Object.fromEntries(keys.map(key => [key, source[key]]));
const sameKeys = (left, right, keys) => keys.every(key => left[key] === right[key]);

function resetSnapEditorGesture() {
    snapEditor.gesture = { pointers: new Map(), mode: null, item: null, itemPointerId: null, offset: null, start: null, swipe: null, snapped: false };
}

// Foto mit seiner Transformation; ausserhalb schwarz (wie beim Senden).
function drawSnapBackground(context, width, height) {
    const { scale, rotation, x, y } = snapEditor.background;
    context.save();
    context.fillStyle = '#000000';
    context.fillRect(0, 0, width, height);
    context.translate(width / 2 + x * width, height / 2 + y * height);
    context.rotate(rotation);
    context.scale(scale, scale);
    context.drawImage(snapEditor.filteredBase || snapEditor.base, -width / 2, -height / 2, width, height);
    context.restore();
}

// ----- Filter -----
function applySnapFilterPixels(data, filter) {
    for (let index = 0; index < data.length; index += 4) {
        let red = data[index];
        let green = data[index + 1];
        let blue = data[index + 2];
        const light = 0.299 * red + 0.587 * green + 0.114 * blue;
        if (filter === 'bw') {
            red = green = blue = light;
        } else if (filter === 'vivid') {
            // Mehr Saettigung und etwas Kontrast.
            red = (light + (red - light) * 1.6 - 128) * 1.1 + 128;
            green = (light + (green - light) * 1.6 - 128) * 1.1 + 128;
            blue = (light + (blue - light) * 1.6 - 128) * 1.1 + 128;
        } else if (filter === 'red') {
            red = red * 1.15 + 24;
            green *= 0.88;
            blue *= 0.82;
        }
        data[index] = Math.min(255, Math.max(0, red));
        data[index + 1] = Math.min(255, Math.max(0, green));
        data[index + 2] = Math.min(255, Math.max(0, blue));
    }
    return data;
}

function setSnapFilter(filter, { record = true } = {}) {
    if (!SNAP_FILTERS.includes(filter) || !snapEditor.base) return;
    if (record && filter !== snapEditor.filter) snapEditor.history.push({ type: 'filter', before: snapEditor.filter });
    snapEditor.filter = filter;
    if (filter === 'original') {
        snapEditor.filteredBase = null;
    } else {
        // Einmal pro Filterwahl rechnen, nicht bei jedem Neuzeichnen (Zoomen bleibt fluessig).
        const canvas = document.createElement('canvas');
        canvas.width = snapEditor.base.width;
        canvas.height = snapEditor.base.height;
        const context = canvas.getContext('2d');
        context.drawImage(snapEditor.base, 0, 0);
        const image = context.getImageData(0, 0, canvas.width, canvas.height);
        applySnapFilterPixels(image.data, filter);
        context.putImageData(image, 0, 0);
        snapEditor.filteredBase = canvas;
    }
    redrawSnapBackground();
    renderSnapFilterRow();
}

function renderSnapFilterRow() {
    const row = document.getElementById('snap-filter-row');
    if (!row) return;
    const labels = { original: t('snaps.filterOriginal'), bw: t('snaps.filterBw'), vivid: t('snaps.filterVivid'), red: t('snaps.filterRed') };
    row.replaceChildren(...SNAP_FILTERS.map(filter => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.dataset.filter = filter;
        const active = filter === snapEditor.filter;
        chip.className = `shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold border ${active ? 'bg-white text-black border-white' : 'bg-black/50 text-white border-white/30'}`;
        chip.setAttribute('role', 'radio');
        chip.setAttribute('aria-checked', String(active));
        chip.textContent = labels[filter];
        chip.onclick = () => setSnapFilter(filter);
        return chip;
    }));
}

function redrawSnapBackground() {
    const canvas = document.getElementById('snap-edit-base');
    if (!canvas || !snapEditor.base) return;
    drawSnapBackground(canvas.getContext('2d'), canvas.width, canvas.height);
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
    // Erster Sticker: die aktuelle Uhrzeit (verschieb-, skalier- und drehbar wie jede Ebene).
    const time = document.createElement('button');
    time.type = 'button';
    time.dataset.timeSticker = 'true';
    time.className = 'h-10 px-2 rounded-lg hover:bg-white/10 text-white text-sm font-bold font-mono';
    time.setAttribute('aria-label', t('snaps.timeSticker'));
    time.textContent = formatClockTime(Date.now());
    time.onclick = () => {
        addSnapItem({ kind: 'text', text: formatClockTime(Date.now()), size: SNAP_TEXT_SIZE, color: '#ffffff', font: 'mono', background: 'shade' });
        row.classList.add('hidden');
    };
    row.replaceChildren(time, ...SNAP_EDIT_EMOJIS.map(emoji => {
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

function renderSnapTextOptions() {
    const style = SNAP_TEXT_STYLES[snapEditor.textStyle];
    const styleButton = document.getElementById('snap-text-style-btn');
    if (styleButton) {
        styleButton.style.fontFamily = style.family;
        styleButton.style.fontStyle = style.style;
        styleButton.style.textShadow = style.glow ? '0 0 6px #ffffff' : '';
    }
    const input = document.getElementById('snap-text-input');
    if (input) {
        input.style.fontFamily = style.family;
        input.style.fontStyle = style.style;
    }
    const icon = document.querySelector('#snap-text-background-btn i');
    if (icon) icon.className = { none: 'fa-regular fa-square', shade: 'fa-solid fa-square text-white/50', solid: 'fa-solid fa-square' }[snapEditor.textBackground];
}

function cycleSnapTextStyle() {
    const index = SNAP_TEXT_STYLE_ORDER.indexOf(snapEditor.textStyle);
    snapEditor.textStyle = SNAP_TEXT_STYLE_ORDER[(index + 1) % SNAP_TEXT_STYLE_ORDER.length];
    renderSnapTextOptions();
    document.getElementById('snap-text-input')?.focus();
}

function cycleSnapTextBackground() {
    const index = SNAP_TEXT_BACKGROUNDS.indexOf(snapEditor.textBackground);
    snapEditor.textBackground = SNAP_TEXT_BACKGROUNDS[(index + 1) % SNAP_TEXT_BACKGROUNDS.length];
    renderSnapTextOptions();
    document.getElementById('snap-text-input')?.focus();
}

// Kontrastfarbe fuer Text auf vollem Hintergrund.
function contrastTextColor(hex) {
    const value = parseInt(String(hex).replace('#', ''), 16);
    const light = 0.299 * ((value >> 16) & 255) + 0.587 * ((value >> 8) & 255) + 0.114 * (value & 255);
    return light > 150 ? '#111111' : '#ffffff';
}

function snapItemColors(item) {
    if (item.kind !== 'text' || item.background === 'solid') {
        return item.kind === 'text' ? { text: contrastTextColor(item.color), box: item.color } : { text: item.color, box: null };
    }
    return { text: item.color, box: item.background === 'shade' ? 'rgba(0, 0, 0, 0.55)' : null };
}

// itemId: vorhandenen Text nachbearbeiten (Text, Art, Hintergrund, Farbe vorbelegt).
function startSnapText(itemId = null) {
    const item = typeof itemId === 'string' ? snapEditor.items.find(entry => entry.id === itemId && entry.kind === 'text') : null;
    snapEditor.editingItemId = item?.id || null;
    if (item) {
        snapEditor.textStyle = SNAP_TEXT_STYLES[item.font] ? item.font : 'classic';
        snapEditor.textBackground = SNAP_TEXT_BACKGROUNDS.includes(item.background) ? item.background : 'none';
        snapEditor.color = item.color;
        renderSnapColorRow();
    }
    renderSnapTextOptions();
    document.getElementById('snap-emoji-row').classList.add('hidden');
    const entry = document.getElementById('snap-text-entry');
    entry.classList.remove('hidden');
    const input = document.getElementById('snap-text-input');
    input.value = item ? item.text : '';
    input.focus();
}

function commitSnapText() {
    const input = document.getElementById('snap-text-input');
    const text = input.value.trim().substring(0, 80);
    document.getElementById('snap-text-entry').classList.add('hidden');
    input.blur();
    const editing = snapEditor.items.find(entry => entry.id === snapEditor.editingItemId);
    snapEditor.editingItemId = null;
    const changes = { text, font: snapEditor.textStyle, background: snapEditor.textBackground, color: snapEditor.color };
    if (editing) {
        // Leer bestaetigt: Text bleibt, nur Art/Hintergrund/Farbe aendern sich.
        if (!text) changes.text = editing.text;
        if (sameKeys(editing, changes, SNAP_ITEM_TEXT_KEYS)) return;
        snapEditor.history.push({ type: 'item-edit', id: editing.id, before: pickKeys(editing, SNAP_ITEM_TEXT_KEYS) });
        Object.assign(editing, changes);
        renderSnapItems();
        return;
    }
    if (text) addSnapItem({ kind: 'text', size: SNAP_TEXT_SIZE, ...changes });
}

// ----- Text- und Emoji-Ebenen (Position relativ 0..1, Groesse relativ zur Bildbreite) -----
function addSnapItem(item) {
    const entry = { id: window.crypto.randomUUID(), x: 0.5, y: 0.5, scale: 1, rotation: 0, ...item };
    snapEditor.items.push(entry);
    snapEditor.history.push({ type: 'item', id: entry.id });
    renderSnapItems();
}

function renderSnapItems() {
    const layers = document.getElementById('snap-edit-layers');
    const stageWidth = document.getElementById('snap-editor-stage').clientWidth || 1;
    layers.replaceChildren(...snapEditor.items.map(item => {
        const element = document.createElement('div');
        element.className = 'snap-edit-item absolute whitespace-nowrap font-bold pointer-events-auto cursor-move touch-none';
        element.dataset.itemId = item.id;
        element.textContent = item.text;
        element.style.fontSize = `${item.size * stageWidth}px`;
        const colors = snapItemColors(item);
        element.style.color = colors.text;
        if (item.kind === 'text') {
            const style = SNAP_TEXT_STYLES[item.font] || SNAP_TEXT_STYLES.classic;
            element.style.fontFamily = style.family;
            element.style.fontWeight = style.weight;
            element.style.fontStyle = style.style;
            element.style.textShadow = style.glow ? `0 0 0.15em ${item.color}, 0 0 0.4em ${item.color}` : colors.box ? '' : '0 1px 3px rgba(0,0,0,0.8)';
            if (colors.box) {
                element.style.backgroundColor = colors.box;
                element.style.padding = '0.1em 0.35em';
                element.style.borderRadius = '0.25em';
            }
        }
        positionSnapItemElement(element, item);
        return element;
    }));
}

function positionSnapItemElement(element, item) {
    element.style.left = `${item.x * 100}%`;
    element.style.top = `${item.y * 100}%`;
    element.style.transform = `translate(-50%, -50%) rotate(${item.rotation || 0}rad) scale(${item.scale || 1})`;
}

function updateSnapItemElement(item) {
    const element = document.querySelector(`#snap-edit-layers [data-item-id="${item.id}"]`);
    if (element) positionSnapItemElement(element, item);
}

function snapStageRect() {
    return document.getElementById('snap-editor-stage').getBoundingClientRect();
}

// ----- Gesten im Editor -----
function handleSnapEditorDown(event) {
    if (!hasSnapDraft()) return;
    const gesture = snapEditor.gesture;
    const itemElement = event.target.closest?.('[data-item-id]');
    // Zeichnen hat Vorrang auf dem Bild (Zeichen-Canvas nimmt die Ereignisse selbst).
    if (snapEditor.tool === 'draw' && !itemElement && !gesture.mode) return;
    gesture.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    event.currentTarget.setPointerCapture?.(event.pointerId);
    if (gesture.pointers.size === 1) {
        if (itemElement) {
            const item = snapEditor.items.find(entry => entry.id === itemElement.dataset.itemId);
            if (!item) return;
            const now = Date.now();
            clearTimeout(snapEditor.pendingTextEdit);
            // Doppelt tippen entfernt die Ebene (rueckgaengig machbar).
            if (snapEditor.lastItemTap?.id === item.id && now - snapEditor.lastItemTap.at < 300) {
                const index = snapEditor.items.indexOf(item);
                snapEditor.items = snapEditor.items.filter(entry => entry.id !== item.id);
                snapEditor.history.push({ type: 'item-delete', item, index });
                snapEditor.lastItemTap = null;
                resetSnapEditorGesture();
                renderSnapItems();
                return;
            }
            snapEditor.lastItemTap = { id: item.id, at: now };
            const rect = snapStageRect();
            Object.assign(gesture, {
                mode: 'item',
                item,
                itemBefore: pickKeys(item, SNAP_ITEM_TRANSFORM_KEYS),
                down: { x: event.clientX, y: event.clientY, at: now, twoFingers: false },
                itemPointerId: event.pointerId,
                offset: { x: event.clientX - (rect.left + item.x * rect.width), y: event.clientY - (rect.top + item.y * rect.height) }
            });
        } else {
            Object.assign(gesture, { mode: 'background', swipe: { startX: event.clientX, startY: event.clientY } });
        }
        return;
    }
    if (gesture.pointers.size !== 2) return;
    const pair = pointerPair(gesture.pointers);
    if (gesture.mode === 'item') {
        // Zweiter Finger irgendwo: skalieren und drehen.
        gesture.start = { ...pair, scale: gesture.item.scale || 1, rotation: gesture.item.rotation || 0 };
        if (gesture.down) gesture.down.twoFingers = true;
    } else if (gesture.mode === 'background' && !itemElement) {
        gesture.mode = 'background-pinch';
        gesture.swipe = null;
        gesture.start = { ...pair, background: { ...snapEditor.background } };
        gesture.backgroundBefore = { ...snapEditor.background };
    }
}

function handleSnapEditorMove(event) {
    const gesture = snapEditor.gesture;
    if (!gesture.pointers.has(event.pointerId)) return;
    gesture.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const rect = snapStageRect();
    if (gesture.mode === 'item') {
        const item = gesture.item;
        if (gesture.start && gesture.pointers.size >= 2) {
            const pair = pointerPair(gesture.pointers);
            item.scale = clampTo(SNAP_ITEM_SCALE_RANGE, gesture.start.scale * (pair.distance / gesture.start.distance));
            item.rotation = snapEditorRotation(gesture.start.rotation + pair.angle - gesture.start.angle);
            noteRotationSnap(item.rotation);
        }
        const finger = gesture.pointers.get(gesture.itemPointerId);
        if (finger) {
            item.x = clampTo([0, 1], (finger.x - gesture.offset.x - rect.left) / rect.width);
            item.y = clampTo([0, 1], (finger.y - gesture.offset.y - rect.top) / rect.height);
        }
        updateSnapItemElement(item);
    } else if (gesture.mode === 'background-pinch' && gesture.pointers.size >= 2) {
        const pair = pointerPair(gesture.pointers);
        const start = gesture.start;
        snapEditor.background = {
            scale: clampTo(SNAP_BACKGROUND_SCALE_RANGE, start.background.scale * (pair.distance / start.distance)),
            rotation: snapEditorRotation(start.background.rotation + pair.angle - start.angle),
            x: start.background.x + (pair.mid.x - start.mid.x) / rect.width,
            y: start.background.y + (pair.mid.y - start.mid.y) / rect.height
        };
        noteRotationSnap(snapEditor.background.rotation);
        redrawSnapBackground();
    }
}

function handleSnapEditorUp(event) {
    const gesture = snapEditor.gesture;
    if (!gesture.pointers.has(event.pointerId)) return;
    const point = gesture.pointers.get(event.pointerId);
    gesture.pointers.delete(event.pointerId);
    if (gesture.mode === 'background' && gesture.swipe && event.type === 'pointerup') {
        // Ein Finger auf dem Bild seitlich: Snap <-> Bild (wie in der Kamera).
        const deltaX = point.x - gesture.swipe.startX;
        const deltaY = point.y - gesture.swipe.startY;
        if (Math.abs(deltaX) > SNAP_SWIPE_MODE && Math.abs(deltaX) > Math.abs(deltaY) * 1.5 && state.snapTarget !== 'status') toggleSnapSendMode();
    }
    if (gesture.mode === 'item') {
        // Element-Finger weg: Geste vorbei. Nur der zweite Finger weg: weiter verschieben, neu ansetzen.
        if (event.pointerId !== gesture.itemPointerId) {
            gesture.start = null;
            return;
        }
        finishSnapItemGesture(gesture, point, event.type === 'pointerup');
        resetSnapEditorGesture();
        return;
    }
    if (gesture.mode === 'background-pinch') recordSnapBackgroundChange(gesture.backgroundBefore);
    // Nach dem Zoomen bleibt ein Finger liegen: keine weitere Geste bis zum Loslassen.
    if (gesture.mode === 'background-pinch' && gesture.pointers.size) {
        gesture.mode = 'done';
        return;
    }
    if (!gesture.pointers.size) resetSnapEditorGesture();
}

// Ende einer Geste auf einer Ebene: Aenderung merken (rueckgaengig) oder, bei einem ruhigen kurzen
// Tipp auf Text, nach 300 ms die Nachbearbeitung oeffnen (ein zweiter Tipp loescht stattdessen).
function finishSnapItemGesture(gesture, point, released) {
    const item = gesture.item;
    if (!item) return;
    if (!sameKeys(item, gesture.itemBefore, SNAP_ITEM_TRANSFORM_KEYS)) {
        snapEditor.history.push({ type: 'item-transform', id: item.id, before: gesture.itemBefore });
        return;
    }
    const down = gesture.down;
    const tapped = released && down && !down.twoFingers && Math.hypot(point.x - down.x, point.y - down.y) < 10 && Date.now() - down.at < 400;
    if (tapped && item.kind === 'text') {
        clearTimeout(snapEditor.pendingTextEdit);
        snapEditor.pendingTextEdit = setTimeout(() => {
            snapEditor.pendingTextEdit = null;
            if (snapEditor.items.includes(item)) startSnapText(item.id);
        }, 300);
    }
}

function recordSnapBackgroundChange(before) {
    if (!before || sameKeys(before, snapEditor.background, ['scale', 'rotation', 'x', 'y'])) return;
    snapEditor.history.push({ type: 'background', before });
}

// Mausrad: beim Ziehen eines Elements skalieren (Shift = drehen), sonst das Foto zoomen.
function handleSnapEditorWheel(event) {
    if (!hasSnapDraft()) return;
    event.preventDefault();
    const gesture = snapEditor.gesture;
    if (gesture.mode === 'item' && gesture.item) {
        const item = gesture.item;
        if (event.shiftKey) {
            item.rotation = snapEditorRotation((item.rotation || 0) + event.deltaY * 0.003);
            noteRotationSnap(item.rotation);
        } else {
            item.scale = clampTo(SNAP_ITEM_SCALE_RANGE, (item.scale || 1) * Math.exp(-event.deltaY * 0.0015));
        }
        updateSnapItemElement(item);
        return;
    }
    if (snapEditor.tool === 'draw') return;
    // Eine Folge von Rad-Schritten ist ein Schritt fuers Rueckgaengigmachen.
    const last = snapEditor.history.at(-1);
    const now = Date.now();
    if (last?.type === 'background' && last.wheel && now - last.at < 600) last.at = now;
    else snapEditor.history.push({ type: 'background', before: { ...snapEditor.background }, wheel: true, at: now });
    const background = snapEditor.background;
    if (event.shiftKey) {
        background.rotation = snapEditorRotation(background.rotation + event.deltaY * 0.003);
        noteRotationSnap(background.rotation);
    } else {
        background.scale = clampTo(SNAP_BACKGROUND_SCALE_RANGE, background.scale * Math.exp(-event.deltaY * 0.0015));
    }
    redrawSnapBackground();
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
    } else if (last.type === 'background') {
        snapEditor.background = { ...last.before };
        redrawSnapBackground();
    } else if (last.type === 'filter') {
        setSnapFilter(last.before, { record: false });
    } else if (last.type === 'item-transform' || last.type === 'item-edit') {
        const item = snapEditor.items.find(entry => entry.id === last.id);
        if (item) Object.assign(item, last.before);
        renderSnapItems();
    } else if (last.type === 'item-delete') {
        snapEditor.items.splice(Math.min(last.index, snapEditor.items.length), 0, last.item);
        renderSnapItems();
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
    drawSnapBackground(context, canvas.width, canvas.height);
    snapEditor.strokes.forEach(stroke => drawSnapStroke(context, stroke));
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    snapEditor.items.forEach(item => {
        context.save();
        context.translate(item.x * canvas.width, item.y * canvas.height);
        context.rotate(item.rotation || 0);
        const fontSize = Math.round(item.size * (item.scale || 1) * canvas.width);
        const style = item.kind === 'text' ? (SNAP_TEXT_STYLES[item.font] || SNAP_TEXT_STYLES.classic) : SNAP_TEXT_STYLES.classic;
        context.font = `${style.style} ${style.weight} ${fontSize}px ${style.family}`;
        const colors = snapItemColors(item);
        if (colors.box) {
            // Kasten wie in der Vorschau: 0,1em oben/unten, 0,35em seitlich, abgerundet.
            const width = context.measureText(item.text).width + fontSize * 0.7;
            const height = fontSize * 1.35;
            context.fillStyle = colors.box;
            context.beginPath();
            if (typeof context.roundRect === 'function') context.roundRect(-width / 2, -height / 2, width, height, fontSize * 0.25);
            else context.rect(-width / 2, -height / 2, width, height);
            context.fill();
        }
        if (item.kind === 'text' && style.glow) {
            context.shadowColor = item.color;
            context.shadowBlur = fontSize * 0.4;
        } else if (item.kind === 'text' && !colors.box) {
            context.shadowColor = 'rgba(0, 0, 0, 0.8)';
            context.shadowBlur = Math.round(canvas.width * 0.006);
        } else {
            context.shadowBlur = 0;
        }
        context.fillStyle = colors.text;
        context.fillText(item.text, 0, 0);
        context.restore();
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
    const editor = document.getElementById('snap-editor');
    editor.classList.add('touch-none');
    editor.addEventListener('pointerdown', handleSnapEditorDown);
    editor.addEventListener('pointermove', handleSnapEditorMove);
    editor.addEventListener('pointerup', handleSnapEditorUp);
    editor.addEventListener('pointercancel', handleSnapEditorUp);
    editor.addEventListener('wheel', handleSnapEditorWheel, { passive: false });
    window.addEventListener('resize', () => {
        fitSnapEditorStage();
        if (hasSnapDraft()) renderSnapItems();
    });
}
