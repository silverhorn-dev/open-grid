// ================= SPEICHERN/TEILEN VON MEDIEN =================
// Der Absender legt fest, wer seine Chat-Bilder und Videos speichern oder teilen darf: nur Freunde
// (Standard) oder alle Chat-Partner. Die Wahl reist als `downloadable` mit der Nachricht; der
// Empfaenger-Client zeigt danach "Speichern"/"Teilen" oder nicht. Alben, Secure Snaps und Einmal-Snaps
// nie. Kein Schutz gegen veraenderte Clients oder Screenshots, nur eine Absprache unter Clients.
const MEDIA_DOWNLOAD_RECORD_ID = 'media-download-settings';
const MEDIA_DOWNLOAD_OPTIONS = ['friends', 'all'];

async function loadMediaDownloadSetting() {
    const stored = await databaseRequest('keys', 'readonly', store => store.get(MEDIA_DOWNLOAD_RECORD_ID)).catch(() => null);
    const routerDefault = clientDefault('mediaDownload', 'friends');
    state.mediaDownload = MEDIA_DOWNLOAD_OPTIONS.includes(stored?.value) ? stored.value
        : MEDIA_DOWNLOAD_OPTIONS.includes(routerDefault) ? routerDefault : 'friends';
    renderMediaDownloadSetting();
}

async function updateMediaDownloadSetting(value) {
    if (!MEDIA_DOWNLOAD_OPTIONS.includes(value)) return;
    state.mediaDownload = value;
    try {
        await putDatabaseRecord('keys', { id: MEDIA_DOWNLOAD_RECORD_ID, value });
    } catch (error) {
        logDebug(`Could not store media download setting: ${error.message}`);
        showToast(t('common.settingCouldNotBeSaved'), 'error');
    }
    renderMediaDownloadSetting();
}

function renderMediaDownloadSetting() {
    const select = document.getElementById('media-download-select');
    if (select) select.value = state.mediaDownload;
}

// Darf diese Nachricht (Bild oder Video) gespeichert/geteilt werden? Eigene immer; fremde nach der
// Wahl des Absenders, ohne Angabe (aeltere Nachrichten) nur unter Freunden.
function canDownloadMedia(message) {
    if (!message || message.secureSnap || message.album || message.snapMode === 'replay') return false;
    if (message.senderId === state.myProfile?.id) return true;
    // 'none': beim Senden als "nicht speicherbar" markiert.
    if (message.downloadable === 'none') return false;
    if (message.downloadable === 'all') return true;
    return typeof isFriend === 'function' && isFriend(message.senderId);
}
