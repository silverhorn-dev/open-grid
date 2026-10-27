// ================= BILDER PER CANVAS =================
// Albumbilder, Snaps und Chat-Bilder werden in einen <canvas> gezeichnet statt als <img> mit
// Data-URL: im DOM steht keine Bilddatei, "Bild speichern unter" und Ziehen gehen nicht.
// Kein Kopierschutz gegen Screenshots oder manipulierte Clients (siehe
// tasks/feature-request-secure-image-rendering.md).
const secureImageSources = new WeakMap();
const secureImageDrawTokens = new WeakMap();

function dataUrlToBlob(dataUrl) {
    const comma = dataUrl.indexOf(',');
    const mime = dataUrl.slice(5, dataUrl.indexOf(';'));
    return new Blob([base64ToBytes(dataUrl.slice(comma + 1).replace(/\s/g, ''))], { type: mime });
}

// Zeichnet ein Bild (Data-URL oder Blob) in den Canvas. Aeltere, noch laufende Aufrufe fuer denselben
// Canvas verwerfen ihr Ergebnis.
async function drawSecureImage(canvas, source) {
    const token = (secureImageDrawTokens.get(canvas) || 0) + 1;
    secureImageDrawTokens.set(canvas, token);
    if (!source) {
        clearSecureCanvas(canvas, false);
        return false;
    }
    const blob = typeof source === 'string' ? (isSafeInlineImage(source) ? dataUrlToBlob(source) : null) : source;
    if (!blob) return false;
    const bitmap = await createImageBitmap(blob);
    try {
        if (secureImageDrawTokens.get(canvas) !== token) return false;
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        return true;
    } finally {
        bitmap.close?.();
    }
}

function clearSecureCanvas(canvas, invalidate = true) {
    if (!canvas) return;
    if (invalidate) secureImageDrawTokens.set(canvas, (secureImageDrawTokens.get(canvas) || 0) + 1);
    canvas.width = 0;
    canvas.height = 0;
    secureImageSources.delete(canvas);
}

// size ({ w, h }, wenn bekannt): der Canvas bekommt sofort die richtigen Proportionen und haelt den
// Platz frei, bevor das Bild gezeichnet ist (sonst springt der Inhalt darunter). Ohne Groesse haelt
// ein 4:3-Platzhalter den Platz, bis das Bild da ist.
// Beim Neuzeichnen des Chats die schon gezeichneten Canvas weiterverwenden statt neue, zuerst leere
// anzulegen (sonst flackern Bilder und Video-Vorschauen bei jedem Update, z. B. waehrend ein Video
// uebertragen wird). Schluessel: Art + Nachrichten-ID; nur bei gleicher Quelle.
let reusableSecureImages = new Map();

function collectReusableSecureImages(container) {
    reusableSecureImages = new Map();
    container?.querySelectorAll('canvas[data-reuse-key]').forEach(canvas => reusableSecureImages.set(canvas.dataset.reuseKey, canvas));
}

function releaseReusableSecureImages() {
    reusableSecureImages = new Map();
}

function createSecureImage(dataUrl, className, size = null, { reuseKey = null } = {}) {
    const reusable = reuseKey ? reusableSecureImages.get(reuseKey) : null;
    if (reusable && secureImageSources.get(reusable) === dataUrl && reusable.width) {
        reusableSecureImages.delete(reuseKey);
        reusable.className = `secure-image ${className || ''}`.trim();
        reusable.onclick = null;
        return reusable;
    }
    const canvas = document.createElement('canvas');
    if (reuseKey) canvas.dataset.reuseKey = reuseKey;
    canvas.className = `secure-image ${className || ''}`.trim();
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', t('common.image'));
    canvas.setAttribute('data-no-context-menu', '');
    if (isValidImageSize(size)) {
        canvas.width = size.w;
        canvas.height = size.h;
    } else {
        canvas.style.aspectRatio = '4 / 3';
    }
    secureImageSources.set(canvas, dataUrl);
    drawSecureImage(canvas, dataUrl)
        .then(() => { canvas.style.aspectRatio = ''; })
        .catch(logBackgroundError('createSecureImage'));
    return canvas;
}

// Groesse eines Bildes (fuer neue Nachrichten, damit Empfaenger den Platz vorher kennen).
async function measureImage(dataUrl) {
    try {
        const bitmap = await createImageBitmap(dataUrlToBlob(dataUrl));
        const size = { w: bitmap.width, h: bitmap.height };
        bitmap.close?.();
        return size;
    } catch {
        return undefined;
    }
}

// Die Quelle bleibt nur im Arbeitsspeicher (fuer den Bildbetrachter), nicht im DOM.
function secureImageSource(element) {
    return secureImageSources.get(element) || null;
}

// Speichern nur, wo es erlaubt ist (Chat-Bilder im Chat-/Freunde-Modus): aus dem Canvas als JPEG.
// Teilen ueber das System (Web Share API) als Alternative zum Download; nur wo Dateien teilbar sind
// (typisch: installierte App auf dem Handy).
function canShareFiles() {
    try {
        return typeof navigator.share === 'function'
            && navigator.canShare?.({ files: [new File([new Uint8Array(1)], 'test.jpg', { type: 'image/jpeg' })] }) === true;
    } catch {
        return false;
    }
}

async function shareCanvasImage(canvas, fileName) {
    if (!canvas?.width) return false;
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    if (!blob) return false;
    const file = new File([blob], fileName, { type: 'image/jpeg' });
    if (!navigator.canShare?.({ files: [file] })) return false;
    try {
        await navigator.share({ files: [file] });
        return true;
    } catch (error) {
        // Abbrechen im Teilen-Menue ist kein Fehler.
        if (error?.name === 'AbortError') return false;
        throw error;
    }
}

function downloadCanvasImage(canvas, fileName) {
    if (!canvas?.width) return;
    canvas.toBlob(blob => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'image/jpeg', 0.92);
}
