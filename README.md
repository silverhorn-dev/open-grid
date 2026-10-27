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
| `client/delivery.client.js` | Chat-Sync, Sende-Queue und Pfad C (Zwischenspeicher) |
| `client/sw.js` | Service Worker fuer Push-Empfang im Hintergrund |
| `index.html` | HTML-Markup der App-Shell |
| `client/app/*.js` | UI-Logik: Konfiguration, IndexedDB, Profil, Chat, Alben, Schwarm-Abruf (`swarm.js`), Einstellungen, Push, Start |
| `client/styles.css` | Eigene Styles neben Tailwind |

Cloudflare KV, Durable Objects, Worker Metadata und Wrangler werden nicht mehr
verwendet.

## Docker

```powershell
docker compose up -d --build
```

Standardmaessig ist OpenGrid auf `http://localhost:3000` erreichbar. SQLite
liegt im benannten Volume `open-grid-data` unter `/app/data`.

Alle Einstellungen kommen aus einer `.env` neben `compose.yaml` (Vorlage:
`.env.example`). Der TURN-Server (coturn) ist als Dienst `coturn` in derselben
`compose.yaml` enthalten und startet mit dem Profil `turn`
(`COMPOSE_PROFILES=turn` in der `.env`). OpenGrid und coturn teilen sich
`TURN_SECRET`; `TURN_SERVER` ist zugleich der coturn-Realm (abweichend per
`TURN_REALM`). coturn laeuft im Host-Netzwerk (Port `TURN_PORT`, Standard 3478,
plus UDP-Relay-Ports). Ohne eigenen TURN-Server `COMPOSE_PROFILES` leer lassen.

Umstieg vom frueheren separaten `turn/compose.yml`: alten coturn stoppen
(`docker compose -f turn/compose.yml down`), Inhalt von `turn/.env` in die `.env`
uebernehmen (`TURN_SERVER` ergaenzen), dann `docker compose up -d --build`.

### Sprachen

Die Oberflaeche gibt es auf Deutsch und Englisch (Einstellungen > Allgemein >
Sprache, Standard: Sprache des Geraets, per `CLIENT_DEFAULTS.language`
vorgebbar). Alle Texte stehen unter Schluesseln (`bereich.name`, z. B.
`settings.tab.privacy`) in `i18n/de.properties` und `i18n/en.properties`
(UTF-8, Platzhalter `{name}`). Der Server liest die Dateien beim Start und
liefert pro Sprache `/client/i18n/<sprache>.js`; der Browser laedt nur die
aktive Sprache. Im Code `t('chat.send')`, im Markup `data-i18n="..."` bzw.
`data-i18n-attr="placeholder:..."`. `node scripts/i18n-keys.mjs` meldet
fehlende, ungenutzte Schluessel und abweichende Platzhalter; `test/i18n.test.js`
prueft das bei jedem Testlauf. Profilfelder im eigenen `PROFILE_SCHEMA` koennen
`label` und `default` als Text oder als Objekt pro Sprache angeben, z. B.
`{"de": "Alter", "en": "Age"}`.

### Info-Seite

Eine leicht verstaendliche Erklaerseite fuer alle (Erste Schritte, Funktionen,
Privatsphaere, haeufige Fragen, Selbst betreiben, Neuigkeiten), Deutsch und
Englisch, mit Umschalter "Einfach erklaert" / "Mit Fachbegriffen".

- Inhalt: `info-site/pages/<sprache>/<seite>.md`; Begriffe und Textbausteine:
  `info-site/i18n/<sprache>.properties`. Im Text setzt `${begriff}` einen
  Eintrag ein (verschachtelbar), `begriff.plain` ist die einfache Variante,
  `${ui:schluessel}` holt eine Beschriftung aus der App.
- Ohne weitere Einstellung liegt sie unter `/info`. Mit `INFO_HOST`
  (z. B. `info.og.example.org`) zeigt dieser Host sie unter `/`; DNS bzw. den
  Cloudflare-Tunnel fuer die Subdomain auf denselben Container zeigen lassen.
  `APP_URL` ist dann das Ziel von "Zur App".
- `test/info-site.test.js` prueft, dass alle Seiten in beiden Sprachen und
  beiden Varianten vollstaendig aufgeloest werden.

### Automatisches Deployment (Jenkins)

Das `Jenkinsfile` baut bei jedem Push auf `main`: Syntax-Check und Unit-Tests
(`Dockerfile.test`), E2E-Tests (`scripts/e2e.sh`), danach
`docker compose up -d --build` und Warten auf den Healthcheck. Die angezeigte
Version ist `Build <Commit-Anzahl> (<Hash>)`.

- Der Jenkins-Agent laeuft als Container auf demselben Host und nutzt den
  Docker-Daemon des Hosts ueber den eingehaengten Socket
  (`-v /var/run/docker.sock:/var/run/docker.sock`). Workspace-Pfade gibt es auf
  dem Host nicht, deshalb keine Bind-Mounts: Tests und E2E kopieren die Dateien
  in die Container. Der Agent-Nutzer braucht Zugriff auf den Socket
  (`--group-add <GID der docker-Gruppe>`).
- Fehlt auf dem Jenkins-Agent die Docker-CLI, laedt `scripts/ci-env.sh` sie
  samt Compose- und Buildx-Plugin einmalig nach `<workspace>@tools` (statische
  Binaries von docker.com/GitHub, braucht `curl` oder `wget`).
- Konfiguration pro Multibranch-Pipeline, ohne `.env`-Datei: normale Werte
  (`TURN_SERVER`, `COMPOSE_PROFILES`, `INFO_HOST`, `APP_URL`, `VAPID_SUBJECT`,
  `CLIENT_DEFAULTS`, ...) als Folder Properties des Jobs (Plugin "Folder
  Properties"), das Geheimnis `TURN_SECRET` als Credential
  `open-grid-turn-secret` (Secret text) im Credential-Store des Jobs. Compose
  liest die Werte direkt aus der Umgebung. VAPID-Schluessel sind optional; wer
  schon feste Schluessel hatte, uebernimmt sie, sonst muessten sich Geraete fuer
  Push neu anmelden. Uebergangsweise wird ein vorhandenes Credential
  `open-grid-env` (Secret file mit der `.env`) bevorzugt.
- `COMPOSE_PROJECT_NAME` ist `open-grid`, damit das bestehende Projekt samt
  Volume weiterverwendet wird (pruefen mit `docker compose ls`).
- Ausloeser: GitHub-Webhook (`/github-webhook/`), sonst Abfrage alle 5 Minuten.
  Parameter `SKIP_E2E` nur fuer Notfaelle.
- Sicherheit: wer den Docker-Socket hat, hat Root auf dem Host. Der Agent
  sollte nur vertrauenswuerdige Jobs (eigene Repos, keine fremden Pull Requests)
  bauen.

### Konfiguration

| Variable | Standard | Beschreibung |
|---|---|---|
| `OPEN_GRID_PORT` | `3000` | Auf dem Host veroeffentlichter Port |
| `BUILD_VERSION` | `self-hosted` | Im UI angezeigte Build-Version |
| `BUILD_TIMESTAMP` | Startzeit | Im UI angezeigter Build-Zeitpunkt |
| `PROFILE_SCHEMA` | eingebautes Schema | Optionales JSON-Array fuer Profilfelder |
| `PROFILE_SCHEMAS` | – | Optionales JSON-Objekt mit einem Schema pro App-Modus, z. B. `{"chat": [...]}`; ohne Angabe nutzt "Nur Chat" Name + Status. Labels als Text oder je Sprache (`{"de": "Alter", "en": "Age"}`). `PROFILE_SCHEMA` reicht `compose.yaml` aus der `.env` durch, `PROFILE_SCHEMAS` steht direkt in `compose.yaml` |
| `INFO_HOST` | – | Eigene Subdomain fuer die Info-Seite (sonst `/info`) |
| `APP_URL` | – | Adresse der App fuer "Zur App" auf der Info-Seite |
| `TURN_SERVER` | `turn.deine-domain.de` | Hostname des coturn-Servers |
| `TURN_SECRET` | – | Muss exakt dem `static-auth-secret` des coturn entsprechen |
| `TURN_PORT` | `3478` | Port fuer die UDP- und TCP-Relays |
| `TURN_TLS_PORT` | – | Optional, aktiviert zusaetzlich eine `turns:`-URL |
| `STUN_SERVER` | eigener TURN-Server | STUN-Server (`host:port`) oder `none`. Ohne Angabe dient der eigene coturn auch als STUN; erst ohne TURN wird der oeffentliche Google-STUN genutzt |
| `PUSH_HOST_ALLOWLIST` | – | Zusaetzliche erlaubte Push-Hosts, kommagetrennt (z. B. ein eigener UnifiedPush-/ntfy-Server). Standard: Google, Mozilla, Apple, Microsoft |
| `CLIENT_DEFAULTS` | - | JSON mit Standardwerten fuer Client-Einstellungen, solange ein Nutzer nichts Eigenes gespeichert hat. Erlaubt: `language` (`auto`/`de`/`en`, Sprache fuer alle ohne eigene Wahl), `chatSwitchEnabled`, `chatSwitchStyle` (`bar`/`arrows`/`swipe`), `pullUpAction` (`reload`/`next`/`switcher`/`snap`/`album`), `listSwitchEnabled`, `listSwitchBehavior` (`mode`/`view`), `statusDirectOnly`, `traceWatermark`, `mediaDownload` (`friends`/`all`: wer Chat-Bilder und Videos speichern darf, Standard `friends`), `snapSaveable` (Startwert des "speicherbar"-Schalters im Snap-Editor, Standard `true`), `secureSnaps`, `snapNextGesture` (`doubletap`/`swipe`/`swipeup`), `snapExpiry` (Ablauf von Einmal-Snaps nach der ersten Ansicht: `15m`/`30m`/`60m`/`off`, ohne Angabe `30m`), `ownSnapKeep` (wie lange der Absender seine Snaps behaelt, nachdem der Empfaenger alle Ansichten verbraucht hat: `now`/`15m`/`1h`/`24h`, Standard `1h`), `albumKeyEpochMinutes` (0/15/60/180/1440/10080), `albumKeyEpochsAhead` (1-3). Unbekanntes wird ignoriert. Beispiel: `{"pullUpAction":"switcher","statusDirectOnly":true}` |
| `RATE_LIMIT_SCALE` | `1` | Faktor fuer alle Rate-Limits (1 bis 100), nur fuer Tests mit vielen Clients hinter einer IP (die E2E-Tests nutzen 20) |
| `CREDENTIAL_RETENTION_DAYS` | `180` | Nach so vielen Tagen ohne Registrierung werden Zugangsdaten, Push-Abo, eigene Chat-Kontrollen und wartende Nachrichten eines Peers geloescht (mindestens 7) |
| `TRUST_PROXY` | private Netze | Welchen Proxies `X-Forwarded-For` geglaubt wird: `true`, `false`, Anzahl Hops oder Adressen/Netze. Standard: Loopback und private Netze |
| `LAN_MODE` | `false` | `true` = Club-/LAN-Betrieb: keine STUN/TURN-Server, nur Verbindungen im selben Netz |
| `VAPID_SUBJECT` | `mailto:admin@localhost` | Kontaktadresse fuer Push-Dienste (`mailto:` oder `https:`); Apple lehnt den Standardwert ab |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | generiert | Optional feste VAPID-Schluessel (base64url); sonst einmalig erzeugt und in SQLite gespeichert |
| `APP_MODES` | alle | Erlaubte App-Modi, kommagetrennt: `discovery`, `chat`, `friends`, `event`. Z. B. `chat` fuer einen reinen Chat-Server. Sind nur Modi eines Bereichs erlaubt (Entdecken: `discovery`/`event`, Social: `chat`/`friends`), entfaellt die Bereichswahl beim Onboarding |
| `DEFAULT_APP_MODE` | erster erlaubter | Vorauswahl fuer neue Nutzer |
| `MEDIA_KEY_EPOCH_MINUTES` | `5` | Laenge einer Schluessel-Epoche fuer Alben und View-once-Snaps (1 bis 10080). 5 ist ein Testwert, im echten Betrieb `180` (3 Stunden). Album-Besitzer koennen pro Album eine eigene Laenge waehlen |

Ohne gesetztes `TURN_SECRET` liefert `/api/ice-config` nur einen STUN-Server,
es entstehen also keine Relay-Kandidaten. Stimmt das Secret nicht mit dem
`static-auth-secret` des coturn ueberein, antwortet der TURN-Server mit `401`
und die Verbindung faellt ebenfalls auf STUN zurueck.

TURN laesst sich unabhaengig vom Browser pruefen, am einfachsten im laufenden
Container (nutzt dessen `TURN_SERVER`, `TURN_PORT` und `TURN_SECRET`):

```sh
docker compose exec open-grid node scripts/turn-check.mjs
```

Lokal mit Node geht auch `npm run turn:check -- turn.example.org 3478 <secret>`.

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

## Club-/LAN-Betrieb

Fuer Events (Club, Pride, Festival) kann OpenGrid vollstaendig im lokalen WLAN
laufen, ohne Internet:

- Server auf einem Laptop oder Raspberry Pi im selben WLAN starten, mit
  `LAN_MODE=true` (und z. B. `APP_MODES=event`). Der Server verteilt dann keine
  STUN/TURN-Server, die Clients verbinden sich nur ueber lokale (host/mDNS)
  Kandidaten direkt im WLAN.
- **HTTPS ist Pflicht**: Ohne sicheren Kontext gibt es im Browser weder
  `crypto.subtle` noch Service Worker. Ein reines `http://192.168.x.x`
  funktioniert also nicht. Moeglich sind ein Reverse Proxy mit lokaler CA
  (z. B. Caddy `tls internal`, das CA-Zertifikat muss auf den Geraeten
  vertraut sein) oder eine echte Domain, deren DNS auf die lokale IP zeigt
  (Zertifikat per DNS-01-Challenge).
- Einzelne Nutzer koennen auch ohne `LAN_MODE` in den Einstellungen "Nur
  lokales Netz" waehlen: dann gehen keine Anfragen an STUN/TURN-Server raus.
- Ein Mesh ganz ohne Server ist in einer PWA nicht moeglich: Browser bieten
  keine lokale Geraetesuche, das Signaling braucht immer einen erreichbaren
  Server. Der lokale Server uebernimmt diese Rolle.

## Lokale Entwicklung

Node.js 22 oder neuer wird benoetigt.

```powershell
npm.cmd install
npm.cmd start
```

`npm start` und `npm test` kompilieren vorher automatisch das Tailwind-CSS
(`npm run build:css` -> `client/tailwind.css`, nicht eingecheckt). Neue
Tailwind-Klassen in `index.html` oder `client/**/*.js` brauchen einen neuen
Build. Die App laedt zur Laufzeit nichts von externen CDNs und funktioniert
nach dem ersten Aufruf auch offline.

Tests:

```powershell
npm.cmd test
npm.cmd run check
npm.cmd run audit:prod
```

End-to-End-Tests (`e2e/*.e2e.cjs`: Chat loeschen/blockieren auf Desktop,
iPhone-Emulation und mit offline Partner; Album-Weitergabe ueber einen
anderen Betrachter; Snap-Kamera mit Fake-Kamera, Gesten und Editor) laufen
komplett in Docker, lokal ist kein Node noetig:

```sh
sh scripts/e2e.sh   # oder: npm run test:e2e
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
  nach maximal 72 Stunden ab. Pro Empfaenger gelten hoechstens 500 Nachrichten
  bzw. 20 MB, pro Absender und Empfaenger 200 Nachrichten.
- Logs enthalten weder Query-Strings (Geohash, Peer-IDs, Event-Hashes) noch
  IP-Adressen.
- Peers, die sich `CREDENTIAL_RETENTION_DAYS` (Standard 180) Tage nicht
  registriert haben, werden mit Zugangsdaten, Push-Abo, eigenen
  Chat-Kontrollen und wartenden Nachrichten geloescht.
- Im Browser liegen Profile, Medien und Alben (inkl. Albumgeheimnis)
  verschluesselt; die App bittet um dauerhaften Speicher und zeigt die Belegung
  in den Einstellungen.
- Chat-Loeschungen speichern einen Cutoff in `chat_controls`, damit alte
  Operationen den geloeschten Verlauf nicht wiederherstellen.
- Blockierungen bleiben serverseitig bestehen, entfernen wartende Nachrichten
  der Peer-Kombination und verhindern neue Queue-Zustellungen.
- Vollstaendige Profile, Klartext-Chats, private Alben und private Schluessel
  verbleiben im Browser. Alben gehen nur per P2P an freigegebene Peers.
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
