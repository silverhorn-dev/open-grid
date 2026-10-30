// ================= LIVE-KONFIGURATION (Admin-Panel, Board T25) =================
// Einstellungen, die ohne Neustart wirken. Startwert = Umgebungsvariable; ein im Panel gesetzter Wert
// liegt in der Datenbank (admin_settings) und gewinnt, auch nach einem Neustart. "Zuruecksetzen" loescht
// ihn wieder (dann gilt die Umgebungsvariable). Jeder Eintrag: { env, apply(value), options?() };
// apply wirft bei ungueltigen Werten (das Panel bekommt den Grund, nichts wird gespeichert).
// Optional: prepare(input) normalisiert die Eingabe vor apply (z. B. Geheimnis behalten), encode/decode
// wandeln zwischen Wert und gespeicherter Form (z. B. Geheimnis verschluesselt), view(value) ist die
// Anzeige im Panel (Geheimnisse nur als "gesetzt").
export function createLiveConfig({ store, entries, log, now = Date.now }) {
    const current = {};

    function applyValue(key, value) {
        entries[key].apply(value);
        current[key] = value;
    }

    // Start: gespeicherte Werte, ungueltige (z. B. nach einem Update) fallen auf die Umgebungsvariable zurueck.
    const saved = store.admin.settings();
    for (const [key, entry] of Object.entries(entries)) {
        if (key in saved) {
            try {
                applyValue(key, entry.decode ? entry.decode(saved[key].value) : saved[key].value);
                continue;
            } catch (error) {
                log.warn(`Live setting ${key} from the admin panel is invalid (${error.message}); using the environment value.`);
            }
        }
        current[key] = entry.env ?? null;
    }

    return {
        list() {
            const stored = store.admin.settings();
            const view = (entry, value) => (entry.view ? entry.view(value ?? null) : value);
            return Object.fromEntries(Object.entries(entries).map(([key, entry]) => [key, {
                value: view(entry, current[key]),
                env: view(entry, entry.env ?? null),
                source: key in stored ? 'panel' : 'env',
                updatedAt: stored[key]?.updatedAt ?? null,
                ...(entry.options ? { options: entry.options() } : {})
            }]));
        },
        set(key, value) {
            if (!entries[key]) throw new Error(`Unknown setting ${key}`);
            const entry = entries[key];
            const prepared = entry.prepare ? entry.prepare(value) : value;
            applyValue(key, prepared);
            store.admin.saveSetting(key, entry.encode ? entry.encode(prepared) : prepared, now());
            log.info(`Admin panel: ${key} changed.`);
        },
        reset(key) {
            if (!entries[key]) throw new Error(`Unknown setting ${key}`);
            entries[key].apply(entries[key].env ?? null);
            current[key] = entries[key].env ?? null;
            store.admin.deleteSetting(key);
            log.info(`Admin panel: ${key} reset to the environment value.`);
        }
    };
}
