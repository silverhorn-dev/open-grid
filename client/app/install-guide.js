// ================= INSTALLATION AUF SAFARI / iOS =================
// Safari loescht allen Speicher einer Webseite (IndexedDB, Service Worker, localStorage), die man einige
// Tage nicht geoeffnet hat (ITP, 7 Tage). Fuer OpenGrid heisst das: Schluessel, Chats und Freunde weg.
// Web-Apps auf dem Home-Bildschirm (iOS/iPadOS) bzw. im Dock (macOS) sind davon ausgenommen, haben aber
// einen eigenen, leeren Speicher. Darum: neue Nutzer im Safari-Tab sehen VOR dem Einrichten eine
// Anleitung; wer schon Daten im Tab hat, bekommt einen Hinweis-Balken (fuer 7 Tage wegklickbar).
const INSTALL_HINT_DISMISS_KEY = 'opengrid-install-hint-dismissed';
const INSTALL_HINT_DISMISS_MS = 7 * 24 * 60 * 60 * 1000;
const installGuide = { resolve: null, skipArmed: false };

// 'ios-safari' | 'ios-other' (Chrome, Firefox, Edge auf iOS: auch WebKit) | 'mac-safari' | null
function installPlatform() {
    const ua = navigator.userAgent || '';
    const iOS = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    if (iOS) return /CriOS|FxiOS|EdgiOS|OPiOS/.test(ua) ? 'ios-other' : 'ios-safari';
    if (/Macintosh/.test(ua) && /Version\/[\d.]+.*Safari\//.test(ua) && !/Chrome|Chromium|Edg\/|Firefox|OPR\//.test(ua)) return 'mac-safari';
    return null;
}

function isInstalledWebApp() {
    return window.matchMedia?.('(display-mode: standalone)').matches === true || navigator.standalone === true;
}

function needsInstallGuide() {
    return Boolean(installPlatform()) && !isInstalledWebApp();
}

// Schritte je Plattform: [Symbol, Text].
function installGuideSteps(platform) {
    if (platform === 'mac-safari') {
        return [['fa-bars', t('install.macStep1')], ['fa-square-plus', t('install.macStep2')], ['fa-rocket', t('install.macStep3')]];
    }
    return [
        ['fa-arrow-up-from-bracket', platform === 'ios-other' ? t('install.iosOtherStep1') : t('install.iosStep1')],
        ['fa-square-plus', t('install.iosStep2')],
        ['fa-toggle-on', t('install.iosStep3')],
        ['fa-rocket', t('install.iosStep4')]
    ];
}

function renderInstallGuide({ existing = false } = {}) {
    const list = document.getElementById('install-guide-steps');
    if (!list) return;
    list.replaceChildren(...installGuideSteps(installPlatform()).map(([icon, label], index) => {
        const item = document.createElement('li');
        item.className = 'flex items-start gap-3 rounded-xl bg-slate-950/50 border border-slate-800 p-3';
        const number = document.createElement('span');
        number.className = 'w-6 h-6 shrink-0 rounded-full bg-brand-600 text-white text-xs font-bold flex items-center justify-center';
        number.textContent = String(index + 1);
        const text = document.createElement('span');
        text.className = 'flex-1 text-sm text-slate-200';
        text.textContent = label;
        const symbol = document.createElement('i');
        symbol.className = `fa-solid ${icon} shrink-0 mt-0.5 text-slate-400`;
        item.append(number, text, symbol);
        return item;
    }));
    document.getElementById('install-guide-existing')?.classList.toggle('hidden', !existing);
    // Einladungslink aus dem Safari-Tab: geht beim Installieren verloren (die App startet auf /grid).
    document.getElementById('install-guide-invite')?.classList.toggle('hidden', !state.pendingInvite);
    document.getElementById('install-guide-done')?.classList.add('hidden');
    document.getElementById('install-guide-done-btn')?.classList.remove('hidden');
    document.getElementById('install-guide-skip-warning')?.classList.add('hidden');
    installGuide.skipArmed = false;
}

// Vor dem Einrichten (main.js): wartet, bis man im Browser weitermacht. Wer installiert, oeffnet die App
// vom Home-Bildschirm; dieser Tab bleibt dann einfach bei der Anleitung stehen.
function maybeShowInstallGuide() {
    if (!needsInstallGuide()) return Promise.resolve();
    renderInstallGuide();
    document.getElementById('install-guide-modal')?.classList.remove('hidden');
    return new Promise(resolve => {
        installGuide.resolve = resolve;
    });
}

// Aus dem Hinweis-Balken (schon eingerichtet): nur informieren, nichts blockiert.
function openInstallGuide() {
    renderInstallGuide({ existing: true });
    document.getElementById('install-guide-modal')?.classList.remove('hidden');
}

function closeInstallGuide() {
    document.getElementById('install-guide-modal')?.classList.add('hidden');
    const resolve = installGuide.resolve;
    installGuide.resolve = null;
    resolve?.();
}

function finishInstallGuide() {
    // Einladung gleich mitnehmen: der Tipp zaehlt als Nutzer-Geste, Kopieren ist erlaubt.
    if (state.pendingInvite) copyPendingInviteLink().catch(() => {});
    // Installieren laesst sich von hier nicht pruefen: nur noch sagen, wo es weitergeht.
    document.getElementById('install-guide-done')?.classList.remove('hidden');
    document.getElementById('install-guide-done-btn')?.classList.add('hidden');
    if (!installGuide.resolve) setTimeout(closeInstallGuide, 2500);
}

// Erst beim zweiten Tippen weiter, nach einer klaren Warnung.
function skipInstallGuide() {
    if (!installGuide.skipArmed) {
        installGuide.skipArmed = true;
        document.getElementById('install-guide-skip-warning')?.classList.remove('hidden');
        return;
    }
    closeInstallGuide();
}

function renderInstallHintBar() {
    const bar = document.getElementById('install-hint-bar');
    if (!bar) return;
    let dismissedAt = 0;
    try {
        dismissedAt = Number(localStorage.getItem(INSTALL_HINT_DISMISS_KEY)) || 0;
    } catch {
        dismissedAt = 0;
    }
    bar.classList.toggle('hidden', !needsInstallGuide() || Date.now() - dismissedAt < INSTALL_HINT_DISMISS_MS);
}

function dismissInstallHint() {
    try {
        localStorage.setItem(INSTALL_HINT_DISMISS_KEY, String(Date.now()));
    } catch {
        // Ohne localStorage kommt der Balken beim naechsten Start wieder.
    }
    document.getElementById('install-hint-bar')?.classList.add('hidden');
}

// ----- Einladung ueber die Installation hinweg -----
function pendingInviteLink() {
    return state.pendingInvite ? `${window.location.origin}/invite${state.pendingInvite.startsWith('#') ? '' : '#'}${state.pendingInvite}` : '';
}

async function copyPendingInviteLink() {
    const link = pendingInviteLink();
    if (!link) return;
    try {
        await navigator.clipboard.writeText(link);
        showToast(t('install.inviteCopied'), 'success');
    } catch {
        showToast(t('common.copyingIsNotPossible'), 'error');
    }
}

function toggleOnboardingInvite() {
    const input = document.getElementById('onboarding-invite-input');
    if (!input) return;
    input.classList.toggle('hidden');
    if (!input.classList.contains('hidden')) input.focus();
}

// Eingefuegter Link (ganz oder nur der Teil nach #) -> Fragment fuer acceptPendingInvite; null = ungueltig.
function onboardingInviteFragment(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    const fragment = text.includes('#') ? text.slice(text.indexOf('#')) : `#${text}`;
    return parseInvite(fragment) ? fragment : null;
}

// Bestehende Tab-Nutzer: Daten per Umzug (transfer.js) in die installierte App mitnehmen.
function openTransferFromInstallGuide() {
    closeInstallGuide();
    openTransferExport();
}
