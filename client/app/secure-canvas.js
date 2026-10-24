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

function createSecureImage(dataUrl, className) {
    const canvas = document.createElement('canvas');
    canvas.className = `secure-image ${className || ''}`.trim();
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Bild');
    canvas.setAttribute('data-no-context-menu', '');
    secureImageSources.set(canvas, dataUrl);
    drawSecureImage(canvas, dataUrl).catch(logBackgroundError('createSecureImage'));
    return canvas;
}

// Die Quelle bleibt nur im Arbeitsspeicher (fuer den Bildbetrachter), nicht im DOM.
function secureImageSource(element) {
    return secureImageSources.get(element) || null;
}

// Speichern nur, wo es erlaubt ist (Chat-Bilder im Chat-/Freunde-Modus): aus dem Canvas als JPEG.
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
