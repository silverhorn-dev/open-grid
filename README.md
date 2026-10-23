# OpenGrid

OpenGrid ist eine datenschutzorientierte Discovery- und Chat-PWA. Der
self-hosted Server stellt die statische Anwendung bereit und uebernimmt nur
Geohash-Routing, WebRTC-Signaling und eine optionale Queue fuer bereits
verschluesselte Nachrichten. Vollstaendige Profile und Chats werden direkt
zwischen Clients ueber verschluesselte WebRTC DataChannels uebertragen.

## Architektur

- **Browser:** Statische HTML-/JavaScript-PWA, persistente Client-ID,
  IndexedDB-Caches und WebRTC.
- **Fastify:** App-Auslieferung, REST-API und WebSocket-Signaling.
- **SQLite:** Kurzlebige Grid-Registrierungen, Removed-Tombstones und bereits
  clientseitig verschluesselte Queue-Payloads sowie persistente
  Chat-Loesch-/Blockregeln.
- **Reverse Proxy:** TLS-Terminierung und Weiterleitung von HTTP sowie
  WebSocket-Upgrades an den Container.

| Datei | Verantwortung |
|---|---|
| `server/index.js` | Startet den HTTP-Server |
| `server/app.js` | Fastify-Routen, App-Shell und REST-API |
| `server/database.js` | SQLite-Schema, Grid-TTL und Message Queue |
| `server/signaling.js` | WebSocket-Signaling-Relay |
| `server/push.js` | Web Push: VAPID-Signatur und aes128gcm-Verschluesselung |
| `client/crypto.client.js` | Gemeinsame Base64-Helfer fuer Web Crypto |
| `client/grid.client.js` | Discovery, Heartbeats, Grid und Signaling-Verbindung |
| `client/p2p.client.js` | WebRTC, DataChannels, ECDH/AES-GCM und P2P-Protokoll |
| `client/sw.js` | Service Worker fuer Push-Empfang im Hintergrund |
| `index.html` | HTML-Markup der App-Shell |
| `client/app/*.js` | UI-Logik: Konfiguration, IndexedDB, Profil, Chat, Einstellungen, Push, Start |
| `client/styles.css` | Eigene Styles neben Tailwind |

Cloudflare KV, Durable Objects, Worker Metadata und Wrangler werden nicht mehr
verwendet.

## Docker

```powershell
docker compose up -d --build
```

Standardmaessig ist OpenGrid auf `http://localhost:3000` erreichbar. SQLite
liegt im benannten Volume `open-grid-data` unter `/app/data`.

### Konfiguration

| Variable | Standard | Beschreibung |
|---|---|---|
| `OPEN_GRID_PORT` | `3000` | Auf dem Host veroeffentlichter Port |
| `BUILD_VERSION` | `self-hosted` | Im UI angezeigte Build-Version |
| `BUILD_TIMESTAMP` | Startzeit | Im UI angezeigter Build-Zeitpunkt |
| `PROFILE_SCHEMA` | eingebautes Schema | Optionales JSON-Array fuer Profilfelder |
| `TURN_SERVER` | `turn.deine-domain.de` | Hostname des coturn-Servers |
| `TURN_SECRET` | – | Muss exakt dem `static-auth-secret` des coturn entsprechen |
| `TURN_PORT` | `3478` | Port fuer die UDP- und TCP-Relays |
| `TURN_TLS_PORT` | – | Optional, aktiviert zusaetzlich eine `turns:`-URL |
| `VAPID_SUBJECT` | `mailto:admin@localhost` | Kontaktadresse fuer Push-Dienste (`mailto:` oder `https:`); Apple lehnt den Standardwert ab |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | generiert | Optional feste VAPID-Schluessel (base64url); sonst einmalig erzeugt und in SQLite gespeichert |

Ohne gesetztes `TURN_SECRET` liefert `/api/ice-config` nur einen STUN-Server,
es entstehen also keine Relay-Kandidaten. Stimmt das Secret nicht mit dem
`static-auth-secret` des coturn ueberein, antwortet der TURN-Server mit `401`
und die Verbindung faellt ebenfalls auf STUN zurueck.

TURN laesst sich unabhaengig vom Browser pruefen:

```powershell
npm.cmd run turn:check -- turn.example.org 3478 <secret>
```

Das Skript fuehrt einen echten Allocate-Request ueber UDP und TCP aus und meldet
die zugeteilte Relay-Adresse, einen Credential-Fehler (`401`/`403`) oder einen
blockierten Transport (Timeout).

Der Server laedt keine `.env`-Datei selbst. Die Variablen muessen als echte
Prozessvariablen ankommen (via `compose.yaml`, das die `.env` neben der Datei
einliest). Ob das geklappt hat, zeigt der laufende Container:

```powershell
docker compose exec open-grid printenv TURN_SERVER TURN_SECRET
curl -s http://localhost:3000/api/ice-config
```

Enthaelt die Antwort `"turnEnabled": false`, fehlt die Konfiguration im
Serverprozess; der Grund steht im Feld `reason`.

Der Reverse Proxy muss `/ws` mit WebSocket-Upgrade weiterleiten. Alle anderen
Pfade werden als normales HTTP an denselben Container geleitet. Der Container
terminiert selbst kein TLS.

Bei Updates mit persistenten Daten-, Token-, Protokoll- oder
Konfigurationsaenderungen sind die versionsgebundenen Migrationsanweisungen in
`documentation/SPECE.md` verbindlich zu beachten.

## Lokale Entwicklung

Node.js 22 oder neuer wird benoetigt.

```powershell
npm.cmd install
npm.cmd start
```

Tests:

```powershell
npm.cmd test
npm.cmd run check
```

## Datenhaltung

- Grid-Eintraege enthalten nur Peer-ID, eine Geohash-Zelle (Praezision 6,
  ca. 1,2 x 0,6 km), Anzeigename, Thumbnail und das Silent-Flag. Koordinaten
  erreichen den Server nie; Grid-Antworten enthalten nur Entfernungs-Buckets.
- Wer den Geraetestandort nicht freigeben will, kann eine Adresse eingeben.
  Diese fragt der Browser auf Klick direkt bei OpenStreetMap Nominatim ab
  (einzige externe Anfrage mit Standortbezug, opt-in).
- Silent-Modus und lokale Safe Zones blenden das eigene Profil im Grid aus,
  ohne die Erreichbarkeit fuer bestehende Chats zu verlieren.
- Der Cloud-Cache (Pfad C) laesst sich pro Client fuer eigene Nachrichten
  abschalten; eingehende Queue-Nachrichten kommen weiterhin an.
- Peer-Capability-Tokens authentifizieren Queue-, Chat-Control- und
  WebSocket-Zugriffe; serverseitig wird nur ihr SHA-256-Hash gespeichert.
- Grid-Eintraege laufen nach der gewaehlten Sichtbarkeitsdauer (1 bis 60
  Minuten, Standard zehn Minuten) nach dem letzten Heartbeat ab.
- Entfernte Peer-IDs bleiben als Tombstone bis zu 30 Tage erhalten, damit
  Clients veraltete Profil-Caches loeschen koennen.
- Queue-Nachrichten enthalten ausschliesslich Ciphertext und IV und laufen
  nach maximal 72 Stunden ab.
- Chat-Loeschungen speichern einen Cutoff in `chat_controls`, damit alte
  Operationen den geloeschten Verlauf nicht wiederherstellen.
- Blockierungen bleiben serverseitig bestehen, entfernen wartende Nachrichten
  der Peer-Kombination und verhindern neue Queue-Zustellungen.
- Vollstaendige Profile, Klartext-Chats und private Schluessel verbleiben im
  Browser.
- Das eigene Profil liegt in einem separaten IndexedDB-Singleton-Store und
  wird nicht gemeinsam mit fremden Peer-Profilen geladen oder bereinigt.

Pfad C wird automatisch verwendet, wenn eine Chat-Operation nicht direkt per
P2P zugestellt werden kann und der Public Key des Peers aus einer vorherigen
direkten Verbindung bekannt ist. Nach dem Reconnect entschluesselt der
Empfaenger die Operation lokal und entfernt sie erst danach aus SQLite.

Die Chat-Seitenleiste wird aus lokal vorhandenen Nachrichten und Operationen
aufgebaut. Deshalb bleibt ein Offline-Chat sichtbar, auch wenn der Peer gerade
keinen Grid-Eintrag besitzt. Der Grid-Bereich zeigt weiterhin nur aktive
Router-Eintraege.

## Push-Benachrichtigungen

Unter Menue (oben rechts) > Einstellungen kann jeder Nutzer
Push-Benachrichtigungen aktivieren. Danach gilt fuer Pfad C:

- Der Sender verschluesselt die Chat-Operation wie bisher und legt sie in die
  Queue. Bei neuen Nachrichten setzt er `notify: true`.
- Der Server schickt den Ciphertext des Senders per Web Push an den
  Empfaenger. Passt er nicht in einen Push (z. B. Snaps), geht nur ein
  Hinweis mit der Message-ID raus.
- Der Service Worker des Empfaengers entschluesselt die Nachricht lokal,
  speichert sie in IndexedDB, loescht den Queue-Eintrag und zeigt eine
  Benachrichtigung. Standardmaessig ist das nur eine einzige Meldung "Neue
  Nachrichten" ohne Name und Text. Vorschauen mit Name und Text lassen sich in
  den Einstellungen einschalten.
- Schlaegt das fehl, bleibt die Nachricht in der Queue und die App holt sie
  beim naechsten Start.

Ein echter P2P-Handshake im Hintergrund ist nicht moeglich, weil Service
Worker kein `RTCPeerConnection` besitzen. Push-Nachrichten laufen ueber den
Push-Dienst des Browser-Herstellers, enthalten aber nur doppelt
verschluesselte Daten. Auf iOS funktioniert Push nur fuer die installierte PWA.

## Identitaet, P2P und Presence

Jede Browser-Installation besitzt eine persistente `nodeId` in `localStorage`.
Beim Aufbau einer P2P-Verbindung handeln beide Clients per ECDH P-256 einen
AES-256-GCM-Session-Key aus. Profilantworten, Presence-Pings und Chatnachrichten
laufen verschluesselt ueber den DataChannel.

Presence wird beim Oeffnen eines Profils auf dem anfragenden Client berechnet:

- **Online:** passender verschluesselter Pong innerhalb von acht Sekunden
- **Abwesend:** Router-Eintrag vorhanden, aber kein Pong
- **Offline:** keine eigene Netzwerk- oder Signaling-Verbindung
