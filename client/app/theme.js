// ================= DARSTELLUNG: THEME UND AKZENTFARBE =================
// Wird im <head> geladen, damit Hell/Dunkel und Akzentfarbe ohne Aufflackern greifen.
// Tailwind nutzt fuer `slate` und `brand` CSS-Variablen (tailwind.config.cjs); hier werden sie gesetzt.
// Beides gilt pro Geraet (localStorage), wie Debug-Modus und Schriftgroesse.
const THEME_STORAGE_KEY = 'opengrid-theme';
const ACCENT_STORAGE_KEY = 'opengrid-accent';
const THEME_MODES = ['system', 'light', 'dark'];
// Helligkeit je Farbstufe; daraus entsteht aus einem Farbton die ganze Akzent-Palette.
const ACCENT_LIGHTNESS = { 50: 97, 100: 94, 200: 86, 300: 77, 400: 66, 500: 57, 600: 48, 700: 40, 800: 33, 900: 27, 950: 16 };
const ACCENT_PRESETS = [
    { hue: 350, saturation: 89 },
    { hue: 22, saturation: 92 },
    { hue: 42, saturation: 93 },
    { hue: 155, saturation: 70 },
    { hue: 195, saturation: 85 },
    { hue: 222, saturation: 85 },
    { hue: 262, saturation: 80 },
    { hue: 320, saturation: 78 }
];
const MIN_ACCENT_SATURATION = 25;

function readStoredValue(key) {
    try {
        return window.localStorage.getItem(key);
    } catch {
        return null;
    }
}

function writeStoredValue(key, value) {
    try {
        if (value === null) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, value);
    } catch {
        // Ohne localStorage gilt die Einstellung nur fuer diese Sitzung.
    }
}

function loadThemeMode() {
    const stored = readStoredValue(THEME_STORAGE_KEY);
    return THEME_MODES.includes(stored) ? stored : 'system';
}

function loadAccent() {
    try {
        const accent = JSON.parse(readStoredValue(ACCENT_STORAGE_KEY) || 'null');
        return Number.isFinite(accent?.hue) && Number.isFinite(accent?.saturation) ? accent : null;
    } catch {
        return null;
    }
}

function hslToRgb(hue, saturation, lightness) {
    const s = saturation / 100;
    const l = lightness / 100;
    const k = n => (n + hue / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const channel = n => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
    return [channel(0), channel(8), channel(4)];
}

// Palette als "r g b" je Stufe, passend zu rgb(var(--brand-500) / <alpha-value>).
function accentPalette({ hue, saturation }) {
    return Object.fromEntries(Object.entries(ACCENT_LIGHTNESS)
        .map(([shade, lightness]) => [shade, hslToRgb(hue, saturation, lightness).join(' ')]));
}

function applyAccent(accent) {
    const root = document.documentElement;
    Object.keys(ACCENT_LIGHTNESS).forEach(shade => {
        // Ohne eigene Wahl gelten die Standardwerte aus styles.css.
        if (accent) root.style.setProperty(`--brand-${shade}`, accentPalette(accent)[shade]);
        else root.style.removeProperty(`--brand-${shade}`);
    });
}

function isLightTheme(mode) {
    return mode === 'light' || (mode === 'system' && Boolean(window.matchMedia?.('(prefers-color-scheme: light)').matches));
}

function applyTheme(mode) {
    const light = isLightTheme(mode);
    const root = document.documentElement;
    root.classList.toggle('theme-light', light);
    root.classList.toggle('dark', !light);
    root.style.colorScheme = light ? 'light' : 'dark';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', light ? '#f1f5f9' : '#0f172a');
}

applyTheme(loadThemeMode());
applyAccent(loadAccent());
window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', () => {
    if (loadThemeMode() === 'system') applyTheme('system');
});

// ----- Einstellungen -----
function setThemeMode(mode) {
    if (!THEME_MODES.includes(mode)) return;
    writeStoredValue(THEME_STORAGE_KEY, mode);
    applyTheme(mode);
    renderThemeSettings();
}

function setAccent(accent) {
    writeStoredValue(ACCENT_STORAGE_KEY, accent ? JSON.stringify(accent) : null);
    applyAccent(accent);
    renderThemeSettings();
}

function renderThemeSettings() {
    const mode = loadThemeMode();
    document.querySelectorAll('[data-theme-mode]').forEach(button => {
        const active = button.dataset.themeMode === mode;
        button.classList.toggle('bg-brand-600', active);
        button.classList.toggle('text-white', active);
        button.classList.toggle('text-slate-300', !active);
        button.setAttribute('aria-pressed', String(active));
    });
    positionAccentHandle(loadAccent() || ACCENT_PRESETS[0]);
}

// Rundes Farbrad wie im Zen-Browser: Winkel = Farbton, Abstand zur Mitte = Saettigung.
function positionAccentHandle({ hue, saturation }) {
    const handle = document.getElementById('accent-wheel-handle');
    if (!handle) return;
    const radius = Math.max(0, Math.min(1, saturation / 100));
    const angle = (hue - 90) * Math.PI / 180;
    handle.style.left = `${50 + Math.cos(angle) * radius * 50}%`;
    handle.style.top = `${50 + Math.sin(angle) * radius * 50}%`;
    handle.style.backgroundColor = `rgb(${hslToRgb(hue, saturation, 57).join(' ')})`;
}

function accentFromPointer(wheel, event) {
    const rect = wheel.getBoundingClientRect();
    const deltaX = event.clientX - (rect.left + rect.width / 2);
    const deltaY = event.clientY - (rect.top + rect.height / 2);
    // conic-gradient beginnt oben und laeuft im Uhrzeigersinn.
    const hue = (Math.atan2(deltaX, -deltaY) * 180 / Math.PI + 360) % 360;
    const distance = Math.min(1, Math.hypot(deltaX, deltaY) / (rect.width / 2));
    return { hue: Math.round(hue), saturation: Math.round(Math.max(MIN_ACCENT_SATURATION, distance * 100)) };
}

function initThemeSettings() {
    const wheel = document.getElementById('accent-wheel');
    const presets = document.getElementById('accent-presets');
    if (presets) {
        presets.innerHTML = '';
        ACCENT_PRESETS.forEach(preset => {
            const dot = document.createElement('button');
            dot.type = 'button';
            dot.className = 'w-7 h-7 rounded-full border-2 border-slate-700 hover:scale-110 transition';
            dot.style.backgroundColor = `rgb(${hslToRgb(preset.hue, preset.saturation, 57).join(' ')})`;
            dot.setAttribute('aria-label', `Akzentfarbe ${preset.hue}`);
            dot.onclick = () => setAccent(preset);
            presets.appendChild(dot);
        });
    }
    if (wheel) {
        let dragging = false;
        const update = event => {
            const accent = accentFromPointer(wheel, event);
            applyAccent(accent);
            positionAccentHandle(accent);
            return accent;
        };
        wheel.addEventListener('pointerdown', event => {
            dragging = true;
            wheel.setPointerCapture(event.pointerId);
            update(event);
        });
        wheel.addEventListener('pointermove', event => {
            if (dragging) update(event);
        });
        const finish = event => {
            if (!dragging) return;
            dragging = false;
            setAccent(update(event));
        };
        wheel.addEventListener('pointerup', finish);
        wheel.addEventListener('pointercancel', finish);
    }
    renderThemeSettings();
}
