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
| `client/crypto.client.js` | Gemeinsame Base64-Helfer fuer Web Crypto |
| `client/grid.client.js` | Discovery, Heartbeats, Grid und Signaling-Verbindung |
| `client/p2p.client.js` | WebRTC, DataChannels, ECDH/AES-GCM und P2P-Protokoll |
| `index.html` | UI, Profile, Chats und IndexedDB |

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

- Grid-Eintraege enthalten nur Peer-ID, Geohash, Anzeigename und Thumbnail.
- Peer-Capability-Tokens authentifizieren Queue-, Chat-Control- und
  WebSocket-Zugriffe; serverseitig wird nur ihr SHA-256-Hash gespeichert.
- Grid-Eintraege laufen zehn Minuten nach dem letzten Heartbeat ab.
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

## Identitaet, P2P und Presence

Jede Browser-Installation besitzt eine persistente `nodeId` in `localStorage`.
Beim Aufbau einer P2P-Verbindung handeln beide Clients per ECDH P-256 einen
AES-256-GCM-Session-Key aus. Profilantworten, Presence-Pings und Chatnachrichten
laufen verschluesselt ueber den DataChannel.

Presence wird beim Oeffnen eines Profils auf dem anfragenden Client berechnet:

- **Online:** passender verschluesselter Pong innerhalb von acht Sekunden
- **Abwesend:** Router-Eintrag vorhanden, aber kein Pong
- **Offline:** keine eigene Netzwerk- oder Signaling-Verbindung
