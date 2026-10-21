# Use Cases & User Stories

## UC-01: Anonyme Standort-Discovery
- **Als** Nutzer
- **möchte ich** andere Profile in einem frei wählbaren Radius sehen,
- **ohne dass** der zentrale Server meinen genauen Verlauf speichert.
- **Acceptance Criteria:**
  - Der Client berechnet einen Geohash (Präzision ~1?2 km) und sendet nur diesen an den Routing-Server.
  - Der Routing-Server antwortet mit einer Liste aktiver Peer-IDs im selben Geohash.
  - Der Client stellt direkte P2P-DataConnections zu den Peers her und fordert deren öffentliche Profilkarte an.

## UC-02: Ephemerer Medienversand (Snap-Style)
- **Als** Nutzer
- **möchte ich** Bilder senden, die nach 1?2 Mal Ansehen unwiderruflich verschwinden,
- **damit** meine Intimsphäre gewahrt bleibt.
- **Acceptance Criteria:**
  - Das Bild wird lokal komprimiert und mit einem symmetrischen Einmalschlüssel (AES-GCM) verschlüsselt.
  - Der Schlüssel wird direkt im P2P-Stream übertragen.
  - Das Empfängergerät speichert das Bild ausschließlich im flüchtigen Arbeitsspeicher (RAM) oder geschützten Temp-Storage.
  - Nach Erreichen des View-Limits (z. B. 2x geöffnet) wird der Key im Empfänger-Client lokal überschrieben und gelöscht.

## UC-03: Permanenter Medien- & Chat-Austausch
- **Als** Nutzer
- **möchte ich** Medien dauerhaft speichern können,
- **ohne** dass Dritte oder der Betrieb der Plattform darauf Zugriff haben.
- **Acceptance Criteria:**
  - Medien werden in verschlüsselte Fragmente zerlegt.
  - Speicherung erfolgt lokal in der browserinternen `IndexedDB` bzw. `Origin Private File System (OPFS)`.
  - Die Entschlüsselung erfolgt dynamisch bei Anzeige ausschließlich durch den privaten Nutzerschlüssel.

## UC-04: Robustheit & Offline-Betrieb
- **Als** Nutzer
- **möchte ich** die App auch im Funkloch oder Flugmodus öffnen können,
- **damit** ich meine gespeicherten Verläufe, geparten Kontakte und Einstellungen jederzeit einsehen kann.
- **Acceptance Criteria:**
  - Die App lädt über den Service Worker vollständig offline aus dem Browser-Cache (App Shell Architecture).
  - Fehlt die Serververbindung zum Signaling Server, schaltet die UI sauber in den `Offline / Reconnecting`-Modus.
  - Lokale Profiländerungen werden lokal in `IndexedDB` zwischengespeichert und beim Re-Connect an den Signaling Server gecallt.

## UC-05: Atomare Background-Updates
- **Als** Nutzer
- **möchte ich** nicht durch unfertige oder abgebrochene Updates eine kaputte App vorfinden,
- **damit** die PWA im Mobilfunknetz maximal stabil bleibt.
- **Acceptance Criteria:**
  - Neue Versionen werden im Hintergrund in einen temporären Staging-Cache heruntergeladen.
  - Erst wenn alle Assets (HTML, JS, WASM, CSS) zu 100 % valide gecached sind UND eine stabile Netzwerkverbindung vorliegt, wird ein `Update Ready`-State gesetzt.
  - Das Update wird ohne Abbruch laufender P2P-Verbindungen erst beim nächsten Neustart oder nach expliziter Bestätigung des Nutzers atomar eingewechselt (`skipWaiting`).