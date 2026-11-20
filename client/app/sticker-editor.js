// ================= STICKER SELBST MACHEN (Board T39 S2) =================
// Bild waehlen -> automatisch freistellen (U^2-Net-p im Worker, Modell erst beim ersten Mal vom Router) -> mit dem
// Finger nachbessern (Radierer / Wiederherstellen, Pinselgroesse) -> 18+ (nur Erwachsene) -> speichern unter "Eigene".
// Gearbeitet wird auf zwei Canvas gleicher Groesse: Bild und Maske (Deckkraft = behalten). Alles bleibt auf dem Geraet.
const STICKER_WORK_EDGE = 1024;
const STICKER_CROP_PADDING = 8;
const stickerEditor = { source: null, mask: null, view: null, tool: 'erase', brush: 28, adult: false, drawing: null };
let stickerWorker = null;
let stickerWorkerRequests = 0;

function stickerCutoutConfig() {
    return state.appConfig?.stickers?.cutout || null;
}

function openStickerCreator() {
    return new Promise(resolve => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/png,image/jpeg,image/webp';
        input.onchange = () => {
            const file = input.files?.[0];
            if (file) openStickerEditor(file).then(resolve, error => {
                logDebug(`Sticker editor: ${error.message}`);
                showToast(t('stickers.imageUnreadable'), 'error');
                resolve();
            });
            else resolve();
        };
        input.click();
    });
}

async function loadStickerSource(file) {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, STICKER_WORK_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    return canvas;
}

async function openStickerEditor(file) {
    const source = await loadStickerSource(file);
    const mask = document.createElement('canvas');
    mask.width = source.width;
    mask.height = source.height;
    const maskContext = mask.getContext('2d');
    maskContext.fillStyle = '#fff';
    maskContext.fillRect(0, 0, mask.width, mask.height);
    Object.assign(stickerEditor, { source, mask, tool: 'erase', adult: false, drawing: null });

    const content = openMediaModal(t('stickers.createTitle'));
    const box = document.createElement('div');
    box.id = 'sticker-editor';
    box.className = 'space-y-3';
    const view = document.createElement('canvas');
    view.id = 'sticker-editor-canvas';
    view.className = 'sticker-editor-canvas sticker-tile w-full touch-none';
    view.width = source.width;
    view.height = source.height;
    stickerEditor.view = view;
    attachStickerBrush(view);

    const row = (...children) => {
        const element = document.createElement('div');
        element.className = 'flex flex-wrap items-center gap-2';
        element.append(...children);
        return element;
    };
    const button = (id, icon, label, onClick, className = 'btn-secondary') => {
        const element = document.createElement('button');
        element.type = 'button';
        element.id = id;
        element.className = className;
        element.innerHTML = `<i class="fa-solid ${icon}"></i>`;
        element.append(document.createTextNode(` ${label}`));
        element.onclick = onClick;
        return element;
    };
    const status = document.createElement('p');
    status.id = 'sticker-editor-status';
    status.className = 'text-xs text-slate-400';
    const auto = button('sticker-auto-btn', 'fa-wand-magic-sparkles', t('stickers.autoCutout'), () => runStickerCutout(status).catch(logBackgroundError('runStickerCutout')));
    auto.classList.toggle('hidden', !stickerCutoutConfig());
    const erase = button('sticker-erase-btn', 'fa-eraser', t('stickers.erase'), () => setStickerTool('erase'));
    const restore = button('sticker-restore-btn', 'fa-paintbrush', t('stickers.restore'), () => setStickerTool('restore'));
    const size = document.createElement('input');
    size.type = 'range';
    size.id = 'sticker-brush-size';
    size.min = '6';
    size.max = '90';
    size.value = String(stickerEditor.brush);
    size.setAttribute('aria-label', t('stickers.brushSize'));
    size.oninput = () => { stickerEditor.brush = Number(size.value); };
    const adultLabel = document.createElement('label');
    adultLabel.className = 'flex items-center gap-2 text-sm text-slate-300';
    const adult = document.createElement('input');
    adult.type = 'checkbox';
    adult.id = 'sticker-adult-toggle';
    adult.className = 'switch';
    adult.setAttribute('role', 'switch');
    adult.onchange = () => { stickerEditor.adult = adult.checked; };
    adultLabel.append(adult, document.createTextNode(t('stickers.adultToggle')));
    adultLabel.classList.toggle('hidden', typeof iAmMinor === 'function' && iAmMinor());
    const save = button('sticker-save-btn', 'fa-check', t('stickers.save'), () => saveStickerFromEditor().catch(logBackgroundError('saveStickerFromEditor')), 'btn-primary');
    box.append(view, row(auto, erase, restore), row(size), status, adultLabel, save);
    content.appendChild(box);
    setStickerTool('erase');
    renderStickerEditor();
    // Gleich automatisch freistellen, wenn der Router das Modell anbietet.
    if (stickerCutoutConfig()) runStickerCutout(status).catch(logBackgroundError('runStickerCutout'));
}

function setStickerTool(tool) {
    stickerEditor.tool = tool;
    document.getElementById('sticker-erase-btn')?.setAttribute('aria-pressed', String(tool === 'erase'));
    document.getElementById('sticker-restore-btn')?.setAttribute('aria-pressed', String(tool === 'restore'));
}

// Bild mit Maske: Deckkraft der Maske = Deckkraft des Bilds.
function composeStickerCanvas(target = null) {
    const { source, mask } = stickerEditor;
    const canvas = target || document.createElement('canvas');
    canvas.width = source.width;
    canvas.height = source.height;
    const context = canvas.getContext('2d');
    context.globalCompositeOperation = 'source-over';
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, 0, 0);
    context.globalCompositeOperation = 'destination-in';
    context.drawImage(mask, 0, 0);
    context.globalCompositeOperation = 'source-over';
    return canvas;
}

function renderStickerEditor() {
    if (stickerEditor.view) composeStickerCanvas(stickerEditor.view);
}

function attachStickerBrush(view) {
    const point = event => {
        const box = view.getBoundingClientRect();
        return [(event.clientX - box.left) * (view.width / (box.width || 1)), (event.clientY - box.top) * (view.height / (box.height || 1))];
    };
    const paint = (from, to) => {
        const context = stickerEditor.mask.getContext('2d');
        const scale = view.width / (view.getBoundingClientRect().width || view.width);
        context.globalCompositeOperation = stickerEditor.tool === 'erase' ? 'destination-out' : 'source-over';
        context.strokeStyle = '#fff';
        context.lineCap = 'round';
        context.lineWidth = stickerEditor.brush * scale;
        context.beginPath();
        context.moveTo(from[0], from[1]);
        context.lineTo(to[0], to[1]);
        context.stroke();
        context.globalCompositeOperation = 'source-over';
        renderStickerEditor();
    };
    view.addEventListener('pointerdown', event => {
        view.setPointerCapture?.(event.pointerId);
        const at = point(event);
        stickerEditor.drawing = { pointerId: event.pointerId, last: at };
        paint(at, at);
    });
    view.addEventListener('pointermove', event => {
        const drawing = stickerEditor.drawing;
        if (!drawing || drawing.pointerId !== event.pointerId) return;
        const at = point(event);
        paint(drawing.last, at);
        drawing.last = at;
    });
    const end = () => { stickerEditor.drawing = null; };
    view.addEventListener('pointerup', end);
    view.addEventListener('pointercancel', end);
}

function runStickerWorker(canvas) {
    const config = stickerCutoutConfig();
    if (!stickerWorker) stickerWorker = new Worker(`/client/app/sticker-worker.js?v=${encodeURIComponent(config.modelUrl)}`);
    const id = ++stickerWorkerRequests;
    return createImageBitmap(canvas).then(bitmap => new Promise((resolve, reject) => {
        const onMessage = event => {
            if (event.data?.id !== id) return;
            stickerWorker.removeEventListener('message', onMessage);
            if (event.data.error) reject(new Error(event.data.error));
            else resolve(event.data);
        };
        stickerWorker.addEventListener('message', onMessage);
        stickerWorker.postMessage({ id, config: { library: config.library, runtimeUrl: config.runtimeUrl, modelUrl: config.modelUrl }, bitmap }, [bitmap]);
    }));
}

// Maske des Modells (320 x 320) weich auf die Bildgroesse: unter 0,25 weg, ueber 0,6 voll, dazwischen anteilig.
function applyCutoutMask(values, size) {
    const small = document.createElement('canvas');
    small.width = size;
    small.height = size;
    const context = small.getContext('2d');
    const pixels = context.createImageData(size, size);
    for (let index = 0; index < values.length; index++) {
        const alpha = Math.max(0, Math.min(1, (values[index] - 0.25) / 0.35));
        pixels.data[index * 4] = 255;
        pixels.data[index * 4 + 1] = 255;
        pixels.data[index * 4 + 2] = 255;
        pixels.data[index * 4 + 3] = Math.round(alpha * 255);
    }
    context.putImageData(pixels, 0, 0);
    const mask = stickerEditor.mask.getContext('2d');
    mask.clearRect(0, 0, stickerEditor.mask.width, stickerEditor.mask.height);
    mask.imageSmoothingEnabled = true;
    mask.drawImage(small, 0, 0, stickerEditor.mask.width, stickerEditor.mask.height);
}

async function runStickerCutout(status) {
    if (!stickerCutoutConfig() || !stickerEditor.source) return;
    status.textContent = t('stickers.cutoutWorking', { size: stickerCutoutConfig().sizeMb || '?' });
    try {
        const { mask, size } = await runStickerWorker(stickerEditor.source);
        applyCutoutMask(mask, size);
        renderStickerEditor();
        status.textContent = t('stickers.cutoutDone');
    } catch (error) {
        logDebug(`Sticker cutout failed: ${error.message}`);
        status.textContent = t('stickers.cutoutFailed');
    }
}

// Auf den sichtbaren Teil zuschneiden (Deckkraft > 0), mit etwas Rand.
function cropToContent(canvas) {
    const context = canvas.getContext('2d');
    const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (data[(y * width + x) * 4 + 3] > 8) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
    }
    if (maxX < 0) return null;
    const left = Math.max(0, minX - STICKER_CROP_PADDING);
    const top = Math.max(0, minY - STICKER_CROP_PADDING);
    const right = Math.min(width, maxX + 1 + STICKER_CROP_PADDING);
    const bottom = Math.min(height, maxY + 1 + STICKER_CROP_PADDING);
    const cropped = document.createElement('canvas');
    cropped.width = right - left;
    cropped.height = bottom - top;
    cropped.getContext('2d').drawImage(canvas, left, top, cropped.width, cropped.height, 0, 0, cropped.width, cropped.height);
    return cropped;
}

async function saveStickerFromEditor() {
    const cropped = cropToContent(composeStickerCanvas());
    if (!cropped) {
        showToast(t('stickers.nothingLeft'), 'warning');
        return null;
    }
    const sticker = await encodeSticker(cropped, { adult: stickerEditor.adult && !(typeof iAmMinor === 'function' && iAmMinor()) });
    if (!sticker) {
        showToast(t('stickers.tooLarge'), 'error');
        return null;
    }
    await addOwnSticker(sticker);
    showToast(t('stickers.saved'), 'success');
    closeMediaModal();
    // Zurueck in die Auswahl (Reiter "Eigene"), wenn ein Chat offen ist.
    if (state.activeChatPeerId) setTimeout(() => openStickerPicker().then(() => document.querySelector('[data-sticker-tab="own"]')?.click()).catch(() => {}), 0);
    return sticker;
}
