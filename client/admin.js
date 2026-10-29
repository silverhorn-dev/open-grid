// ================= ADMIN-PANEL (Board T25, server/admin.js) =================
// Eigene Seite /admin. Login per Passkey (WebAuthn); der erste Passkey entsteht ueber den einmaligen
// Setup-Link aus dem Server-Log (#setup=<token>). Auslastung als kleine Liniendiagramme, eins je Wert
// (keine zweite Achse), mit Fadenkreuz beim Zeigen, Warnungen mit Symbol + Text und einer Tabellenansicht.
const ADMIN_REFRESH_MS = 10000;
const adminState = { tab: 'load', range: '1h', series: null, timer: null, setupToken: null };

// ----- Hilfen -----
async function adminApi(path, { method = 'GET', body } = {}) {
    const response = await fetch(`/api/admin/${path}`, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'x-opengrid-admin': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(data.reason || data.error || `HTTP ${response.status}`);
        error.status = response.status;
        throw error;
    }
    return data;
}

const fromBase64Url = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')), char => char.charCodeAt(0)).buffer;
const toBase64Url = buffer => btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function creationOptions(options) {
    return {
        ...options,
        challenge: fromBase64Url(options.challenge),
        user: { ...options.user, id: fromBase64Url(options.user.id) },
        excludeCredentials: (options.excludeCredentials || []).map(entry => ({ ...entry, id: fromBase64Url(entry.id) }))
    };
}

function requestOptions(options) {
    return {
        ...options,
        challenge: fromBase64Url(options.challenge),
        allowCredentials: (options.allowCredentials || []).map(entry => ({ ...entry, id: fromBase64Url(entry.id) }))
    };
}

function credentialJson(credential) {
    const response = credential.response;
    const json = {
        id: credential.id,
        rawId: toBase64Url(credential.rawId),
        type: credential.type,
        authenticatorAttachment: credential.authenticatorAttachment || undefined,
        clientExtensionResults: credential.getClientExtensionResults?.() || {},
        response: { clientDataJSON: toBase64Url(response.clientDataJSON) }
    };
    if (response.attestationObject) {
        json.response.attestationObject = toBase64Url(response.attestationObject);
        json.response.transports = response.getTransports?.() || [];
    } else {
        json.response.authenticatorData = toBase64Url(response.authenticatorData);
        json.response.signature = toBase64Url(response.signature);
        if (response.userHandle) json.response.userHandle = toBase64Url(response.userHandle);
    }
    return json;
}

function showOnly(id) {
    for (const section of ['admin-login', 'admin-panel']) document.getElementById(section)?.classList.toggle('hidden', section !== id);
    document.getElementById('admin-logout')?.classList.toggle('hidden', id !== 'admin-panel');
}

function loginError(message) {
    const element = document.getElementById('admin-login-error');
    if (!element) return;
    element.textContent = message || '';
    element.classList.toggle('hidden', !message);
}

// ----- Anmelden / ersten Passkey anlegen -----
async function adminStart() {
    const hash = new URLSearchParams(location.hash.slice(1));
    adminState.setupToken = hash.get('setup');
    if (adminState.setupToken) history.replaceState(null, '', location.pathname);
    let session = { loggedIn: false, setupPending: false };
    try {
        session = await adminApi('session');
    } catch (error) {
        loginError(error.message);
    }
    if (session.loggedIn) return openPanel();
    const setupMode = Boolean(adminState.setupToken && session.setupPending);
    document.getElementById('admin-login-title').textContent = setupMode ? t('admin.setupTitle') : t('admin.loginTitle');
    document.getElementById('admin-login-text').textContent = setupMode ? t('admin.setupText') : (session.setupPending ? t('admin.setupPending') : t('admin.loginText'));
    document.getElementById('admin-passkey-name').classList.toggle('hidden', !setupMode);
    document.getElementById('admin-login-btn').textContent = setupMode ? t('admin.setupButton') : t('admin.loginButton');
    document.getElementById('admin-login-btn').dataset.mode = setupMode ? 'setup' : 'login';
    showOnly('admin-login');
}

async function adminLogin() {
    loginError('');
    if (!window.PublicKeyCredential) return loginError(t('admin.noPasskeySupport'));
    const mode = document.getElementById('admin-login-btn').dataset.mode;
    try {
        if (mode === 'setup') {
            await registerPasskey({ setupToken: adminState.setupToken, name: document.getElementById('admin-passkey-name').value });
            adminState.setupToken = null;
        } else {
            const options = await adminApi('login/options', { method: 'POST', body: {} });
            const credential = await navigator.credentials.get({ publicKey: requestOptions(options) });
            await adminApi('login', { method: 'POST', body: { challenge: options.challenge, response: credentialJson(credential) } });
        }
        await openPanel();
    } catch (error) {
        loginError(error.name === 'NotAllowedError' ? t('admin.passkeyCancelled') : t('admin.loginFailed', { reason: error.message }));
    }
}

async function registerPasskey({ setupToken, name }) {
    const options = await adminApi('passkeys/options', { method: 'POST', body: setupToken ? { setupToken } : {} });
    const credential = await navigator.credentials.create({ publicKey: creationOptions(options) });
    await adminApi('passkeys', { method: 'POST', body: { challenge: options.challenge, response: credentialJson(credential), name } });
}

async function adminLogout() {
    await adminApi('logout', { method: 'POST', body: {} }).catch(() => {});
    clearInterval(adminState.timer);
    location.reload();
}

// ----- Panel -----
async function openPanel() {
    showOnly('admin-panel');
    selectTab(adminState.tab);
    clearInterval(adminState.timer);
    adminState.timer = setInterval(() => {
        if (document.visibilityState === 'visible') refreshTab().catch(() => {});
    }, ADMIN_REFRESH_MS);
}

function selectTab(tab) {
    adminState.tab = tab;
    document.querySelectorAll('[data-admin-tab]').forEach(button => {
        const active = button.dataset.adminTab === tab;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-selected', String(active));
    });
    document.querySelectorAll('[data-admin-view]').forEach(view => view.classList.toggle('hidden', view.dataset.adminView !== tab));
    refreshTab().catch(handlePanelError);
}

function handlePanelError(error) {
    if (error.status === 401) return adminStart();
    const alerts = document.getElementById('admin-alerts');
    if (alerts) alerts.textContent = t('admin.loadFailed', { reason: error.message });
}

async function refreshTab() {
    if (adminState.tab === 'load') return refreshLoad();
    if (adminState.tab === 'status') return refreshStatus();
    if (adminState.tab === 'passkeys') return refreshPasskeys();
}

// ----- Auslastung -----
const MB = 1024 * 1024;
const GB = 1024 * MB;
const formatBytes = value => value == null ? '–' : value === 0 ? '0' : value >= GB ? `${formatNumber(value / GB, 1)} GB` : value >= MB ? `${formatNumber(value / MB)} MB` : `${formatNumber(value / 1024)} KB`;
const formatNumber = (value, digits = 0) => value == null ? '–' : Number(value).toLocaleString(i18nLocale(), { maximumFractionDigits: digits, minimumFractionDigits: digits });

// status(value) -> null | 'warning' | 'critical'. Grenzen bewusst grob; das Panel soll aufmerksam machen, nicht alarmieren.
const ADMIN_METRICS = [
    { key: 'cpu', label: () => t('admin.metricCpu'), format: value => `${formatNumber(value, 1)} %`, status: value => value >= 85 ? 'critical' : value >= 60 ? 'warning' : null, max: 100 },
    { key: 'systemMemory', label: () => t('admin.metricSystemMemory'), format: value => `${formatNumber(value, 1)} %`, status: value => value >= 92 ? 'critical' : value >= 80 ? 'warning' : null, max: 100 },
    { key: 'memory', bytes: true, label: () => t('admin.metricMemory'), format: formatBytes },
    { key: 'eventLoopMs', label: () => t('admin.metricEventLoop'), format: value => `${formatNumber(value, 1)} ms`, status: value => value >= 500 ? 'critical' : value >= 100 ? 'warning' : null },
    { key: 'peersOnline', integer: true, label: () => t('admin.metricPeersOnline'), format: value => formatNumber(value) },
    { key: 'sockets', integer: true, label: () => t('admin.metricSockets'), format: value => formatNumber(value) },
    { key: 'requestsPerSecond', label: () => t('admin.metricRequests'), format: value => `${formatNumber(value, 2)}/s` },
    { key: 'errorsPerSecond', label: () => t('admin.metricErrors'), format: value => `${formatNumber(value, 2)}/s`, status: value => value >= 1 ? 'critical' : value > 0 ? 'warning' : null },
    { key: 'responseMs', label: () => t('admin.metricResponse'), format: value => `${formatNumber(value, 1)} ms`, status: value => value >= 1000 ? 'critical' : value >= 300 ? 'warning' : null },
    { key: 'queueMessages', integer: true, label: () => t('admin.metricQueue'), format: value => formatNumber(value) },
    { key: 'diskFreeBytes', bytes: true, label: () => t('admin.metricDiskFree'), format: formatBytes, status: value => value == null ? null : value < GB ? 'critical' : value < 5 * GB ? 'warning' : null },
    { key: 'databaseBytes', bytes: true, label: () => t('admin.metricDatabase'), format: formatBytes }
];
const STATUS_ICONS = { warning: 'fa-triangle-exclamation', critical: 'fa-circle-exclamation' };

async function refreshLoad() {
    adminState.series = await adminApi(`metrics?range=${adminState.range}`);
    renderLoad();
}

function renderLoad() {
    const points = adminState.series?.points || [];
    const latest = points.at(-1) || {};
    const charts = document.getElementById('admin-charts');
    const alerts = document.getElementById('admin-alerts');
    const table = document.getElementById('admin-load-table');
    if (!charts || !alerts || !table) return;
    document.getElementById('admin-load-updated').textContent = points.length
        ? t('admin.updatedAt', { time: new Date(latest.at).toLocaleTimeString(i18nLocale()) })
        : t('admin.noData');

    alerts.replaceChildren(...ADMIN_METRICS.map(metric => ({ metric, level: metric.status?.(latest[metric.key]) }))
        .filter(entry => entry.level)
        .map(({ metric, level }) => {
            const item = document.createElement('p');
            item.className = `admin-alert is-${level}`;
            const icon = document.createElement('i');
            icon.className = `fa-solid ${STATUS_ICONS[level]}`;
            icon.setAttribute('aria-hidden', 'true');
            item.append(icon, ` ${level === 'critical' ? t('admin.critical') : t('admin.warning')}: ${metric.label()} ${metric.format(latest[metric.key])}`);
            return item;
        }));

    const cards = ADMIN_METRICS.map(metric => chartCard(metric, points));
    charts.replaceChildren(...cards);
    cards.forEach((card, index) => card.append(chartSvg(ADMIN_METRICS[index], points, Math.max(200, card.clientWidth - 24))));
    table.replaceChildren(...ADMIN_METRICS.map(metric => {
        const values = points.map(point => point[metric.key]).filter(value => typeof value === 'number');
        const row = document.createElement('tr');
        const cells = [metric.label(), metric.format(latest[metric.key]),
            values.length ? metric.format(values.reduce((sum, value) => sum + value, 0) / values.length) : '–',
            values.length ? metric.format(Math.max(...values)) : '–'];
        row.replaceChildren(...cells.map((text, index) => {
            const cell = document.createElement(index === 0 ? 'th' : 'td');
            cell.textContent = text;
            return cell;
        }));
        return row;
    }));
}

const SVG = 'http://www.w3.org/2000/svg';
function svgElement(name, attributes = {}) {
    const element = document.createElementNS(SVG, name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
    return element;
}

// Obere Achsengrenze: 1, 2 oder 5 mal Zehnerpotenz (oder die feste Obergrenze, z. B. 100 %). Bytes in
// ganzen KB/MB/GB, ganze Zahlen mindestens 2 (damit die Mitte eine ganze Zahl bleibt).
function niceStep(value) {
    if (!(value > 0)) return 1;
    const power = 10 ** Math.floor(Math.log10(value));
    return [1, 2, 5, 10].map(step => step * power).find(step => step >= value);
}

function niceMax(value, metric) {
    if (metric.max) return metric.max;
    if (metric.bytes) {
        const unit = value >= GB ? GB : value >= MB ? MB : 1024;
        return niceStep(value / unit) * unit;
    }
    if (metric.integer) {
        const step = niceStep(Math.ceil(value));
        return Math.max(2, step % 2 ? step * 2 : step);
    }
    return niceStep(value);
}

function chartCard(metric, points) {
    const card = document.createElement('article');
    card.className = 'admin-chart';
    const latest = points.at(-1)?.[metric.key];
    const level = metric.status?.(latest);
    const title = document.createElement('h3');
    title.className = 'admin-chart-title';
    title.textContent = metric.label();
    const value = document.createElement('p');
    value.className = `admin-chart-value${level ? ` is-${level}` : ''}`;
    value.textContent = metric.format(latest);
    if (level) {
        const icon = document.createElement('i');
        icon.className = `fa-solid ${STATUS_ICONS[level]} admin-chart-status`;
        icon.setAttribute('aria-label', level === 'critical' ? t('admin.critical') : t('admin.warning'));
        value.append(' ', icon);
    }
    card.append(title, value);
    return card;
}

// In echter Pixelbreite zeichnen (Schrift und Linien bleiben scharf und lesbar).
function chartSvg(metric, points, width) {
    const height = 104;
    const pad = { left: 58, right: 8, top: 8, bottom: 20 };
    const values = points.map(point => point[metric.key]);
    const numeric = values.filter(value => typeof value === 'number');
    const top = niceMax(Math.max(0, ...numeric), metric);
    const x = index => pad.left + (points.length > 1 ? index / (points.length - 1) : 0.5) * (width - pad.left - pad.right);
    const y = value => pad.top + (1 - value / top) * (height - pad.top - pad.bottom);
    const svg = svgElement('svg', { viewBox: `0 0 ${width} ${height}`, width, height, class: 'admin-chart-svg', role: 'img', 'aria-label': `${metric.label()}: ${metric.format(numeric.at(-1))}` });
    // Zurueckhaltendes Raster: 0, Mitte, oben.
    for (const fraction of [0, 0.5, 1]) {
        const lineY = y(top * fraction);
        svg.append(svgElement('line', { x1: pad.left, x2: width - pad.right, y1: lineY, y2: lineY, class: 'admin-grid' }));
        const label = svgElement('text', { x: pad.left - 6, y: lineY + 4, class: 'admin-axis', 'text-anchor': 'end' });
        label.textContent = metric.format(top * fraction);
        svg.append(label);
    }
    if (points.length) {
        // Anfang und Ende; bei nur einer Messung eine Beschriftung.
        const labels = points.length > 1 ? [[0, 'start'], [points.length - 1, 'end']] : [[0, 'middle']];
        for (const [index, anchor] of labels) {
            const label = svgElement('text', { x: x(index), y: height - 4, class: 'admin-axis', 'text-anchor': anchor });
            label.textContent = new Date(points[index].at).toLocaleTimeString(i18nLocale(), { hour: '2-digit', minute: '2-digit' });
            svg.append(label);
        }
    }
    // Linie; Luecken (keine Messung) unterbrechen sie.
    let path = '';
    values.forEach((value, index) => {
        if (typeof value !== 'number') return;
        path += `${index && typeof values[index - 1] === 'number' ? 'L' : 'M'}${x(index).toFixed(1)},${y(value).toFixed(1)}`;
    });
    if (path) svg.append(svgElement('path', { d: path, class: 'admin-line' }));
    const lastIndex = values.map(value => typeof value === 'number').lastIndexOf(true);
    if (lastIndex >= 0) svg.append(svgElement('circle', { cx: x(lastIndex), cy: y(values[lastIndex]), r: 4, class: 'admin-dot' }));

    // Fadenkreuz + Tooltip (Maus und Finger); die Trefferflaeche ist die ganze Zeichenflaeche.
    const cross = svgElement('line', { y1: pad.top, y2: height - pad.bottom, class: 'admin-cross hidden' });
    const marker = svgElement('circle', { r: 4, class: 'admin-dot hidden' });
    const hit = svgElement('rect', { x: pad.left, y: 0, width: width - pad.left - pad.right, height, class: 'admin-hit' });
    svg.append(cross, marker, hit);
    const tooltip = document.getElementById('admin-tooltip');
    const hide = () => {
        cross.classList.add('hidden');
        marker.classList.add('hidden');
        tooltip?.classList.add('hidden');
    };
    hit.addEventListener('pointermove', event => {
        if (!points.length) return;
        const box = svg.getBoundingClientRect();
        const relative = ((event.clientX - box.left) / box.width) * width;
        const index = Math.max(0, Math.min(points.length - 1, Math.round(((relative - pad.left) / (width - pad.left - pad.right)) * (points.length - 1))));
        const value = values[index];
        cross.setAttribute('x1', x(index));
        cross.setAttribute('x2', x(index));
        cross.classList.remove('hidden');
        if (typeof value === 'number') {
            marker.setAttribute('cx', x(index));
            marker.setAttribute('cy', y(value));
            marker.classList.remove('hidden');
        } else {
            marker.classList.add('hidden');
        }
        if (tooltip) {
            tooltip.textContent = `${new Date(points[index].at).toLocaleTimeString(i18nLocale())} · ${metric.label()}: ${metric.format(value)}`;
            tooltip.style.left = `${Math.min(window.innerWidth - 220, event.clientX + 12)}px`;
            tooltip.style.top = `${event.clientY + window.scrollY - 36}px`;
            tooltip.classList.remove('hidden');
        }
    });
    hit.addEventListener('pointerleave', hide);
    hit.addEventListener('pointercancel', hide);
    return svg;
}

// ----- Status -----
async function refreshStatus() {
    const status = await adminApi('status');
    const list = document.getElementById('admin-status');
    if (!list) return;
    const uptime = status.system?.uptimeSeconds || 0;
    const entries = [
        [t('admin.statusVersion'), `${status.version} · ${status.built}`],
        [t('admin.statusUptime'), t('admin.uptimeValue', { hours: Math.floor(uptime / 3600), minutes: Math.floor((uptime % 3600) / 60) })],
        [t('admin.statusSystem'), `Node ${status.system?.node} · ${status.system?.cores} CPU · ${formatBytes(status.system?.totalMemory)}`],
        [t('admin.statusPeers'), t('admin.peersValue', { registered: status.peers.registered, online: status.peers.online, sockets: status.peers.sockets })],
        [t('admin.statusPush'), formatNumber(status.pushSubscriptions)],
        [t('admin.statusQueue'), `${formatNumber(status.queue.count)} · ${formatBytes(status.queue.bytes)}`],
        [t('admin.statusNudity'), status.nudity.model === 'off' ? t('admin.off') : `${status.nudity.model} · ${status.nudity.threshold} · ${status.nudity.classes.join(', ')}`],
        [t('admin.statusSafety'), `AGE_CHECK=${status.safety.ageCheck}${status.safety.ageProvider ? ` (${status.safety.ageProvider})` : ''} · EMAIL_CHECK=${status.safety.emailCheck} · ABUSE_LOG_DAYS=${status.safety.abuseLogDays}`],
        [t('admin.statusAgeTrust'), status.ageTrust
            ? t('admin.ageTrustValue', { imported: status.ageTrust.imported.length, manual: status.ageTrust.manual, next: status.ageTrust.nextUpdate || '–' })
            : t('admin.off')]
    ];
    list.replaceChildren(...entries.flatMap(([term, value]) => {
        const dt = document.createElement('dt');
        dt.textContent = term;
        const dd = document.createElement('dd');
        dd.textContent = value;
        return [dt, dd];
    }));
}

// ----- Passkeys -----
async function refreshPasskeys() {
    const { passkeys } = await adminApi('passkeys');
    const list = document.getElementById('admin-passkey-list');
    if (!list) return;
    list.replaceChildren(...passkeys.map(passkey => {
        const item = document.createElement('li');
        item.className = 'admin-list-item';
        const label = document.createElement('span');
        const used = passkey.lastUsedAt ? new Date(passkey.lastUsedAt).toLocaleString(i18nLocale()) : t('admin.never');
        label.textContent = `${passkey.name || t('admin.unnamedPasskey')} · ${t('admin.lastUsed', { time: used })}`;
        const remove = document.createElement('button');
        remove.className = 'btn-secondary';
        remove.textContent = t('admin.remove');
        remove.disabled = passkeys.length <= 1;
        remove.dataset.adminAction = 'remove-passkey';
        remove.dataset.passkeyId = passkey.id;
        item.append(label, remove);
        return item;
    }));
}

async function addPasskey() {
    try {
        await registerPasskey({ name: document.getElementById('admin-new-passkey-name').value });
        document.getElementById('admin-new-passkey-name').value = '';
        await refreshPasskeys();
    } catch (error) {
        window.alert(error.name === 'NotAllowedError' ? t('admin.passkeyCancelled') : t('admin.loginFailed', { reason: error.message }));
    }
}

async function removePasskey(id) {
    if (!window.confirm(t('admin.confirmRemovePasskey'))) return;
    await adminApi(`passkeys/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(error => window.alert(error.message));
    await refreshPasskeys();
}

// ----- Ereignisse (keine Inline-Handler, CSP) -----
document.addEventListener('click', event => {
    const target = event.target.closest('[data-admin-action], [data-admin-tab], [data-admin-range]');
    if (!target) return;
    if (target.dataset.adminTab) return selectTab(target.dataset.adminTab);
    if (target.dataset.adminRange) {
        adminState.range = target.dataset.adminRange;
        document.querySelectorAll('[data-admin-range]').forEach(button => button.classList.toggle('is-active', button === target));
        return refreshLoad().catch(handlePanelError);
    }
    const action = target.dataset.adminAction;
    if (action === 'login') adminLogin();
    else if (action === 'logout') adminLogout();
    else if (action === 'add-passkey') addPasskey();
    else if (action === 'remove-passkey') removePasskey(target.dataset.passkeyId);
});
window.addEventListener('resize', () => adminState.tab === 'load' && renderLoad());
document.addEventListener('DOMContentLoaded', adminStart);
