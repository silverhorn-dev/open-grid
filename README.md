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
Version ist `Build <Commit-Anzahl> (<Hash>)`. Andere Branches (Multibranch)
laufen durch dieselben Tests und bauen das echte Image zur Probe
(`open-grid-branch-check:<Build>`, danach geloescht), deployen aber nie.

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
| `CLIENT_DEFAULTS` | - | JSON mit Standardwerten fuer Client-Einstellungen, solange ein Nutzer nichts Eigenes gespeichert hat. Erlaubt: `language` (`auto`/`de`/`en`, Sprache fuer alle ohne eigene Wahl), `chatSwitchEnabled`, `chatSwitchStyle` (`bar`/`arrows`/`swipe`), `notifyMatch`, `notifyFlame`, `notifyAdd`, `notifyDiscovery`, `notifyChat`, `notifyProfileView`, `notifyChatEvents` (Benachrichtigungen je Art, Standard an, Profilbesuch aus), `shareProfileViews` (eigene Profilbesuche melden, Standard `false`), `audience` (Startregel fuer "Wer mich im Grid sieht", z. B. `{"ranges":{"age":{"relative":"same"}}}`), `reloadMode` (`full`/`app`: Runterziehen laedt die ganze Seite oder nur die Daten, Standard `full`), `chatPagesByDay` (Chat nach Tagen statt durchgehend, Standard `false`), `inputSwipeClosesChat` (Eingabeleiste nach rechts wischen schliesst den Chat, Standard `true`), `pullUpAction` (`reload`/`next`/`switcher`/`snap`/`album`), `listSwitchEnabled`, `listSwitchBehavior` (`mode`/`view`), `statusDirectOnly`, `hideDiscoveryHistory` (Flirt-Verlauf im normalen Freundes-Chat ausblenden, Standard `true`), `traceWatermark`, `nudityFilter` (Nacktbild-Filter, Standard aus), `nudityWarnBeforeSend` (vor dem Senden eigener Nacktbilder nachfragen, Standard an), `mediaDownload` (`friends`/`all`: wer Chat-Bilder und Videos speichern darf, Standard `friends`), `snapSaveable` (Startwert des "speicherbar"-Schalters im Snap-Editor, Standard `true`), `secureSnaps`, `snapNextGesture` (`doubletap`/`swipe`/`swipeup`), `snapExpiry` (Ablauf von Einmal-Snaps nach der ersten Ansicht: `15m`/`30m`/`60m`/`off`, ohne Angabe `30m`), `ownSnapKeep` (wie lange der Absender seine Snaps behaelt, nachdem der Empfaenger alle Ansichten verbraucht hat: `now`/`15m`/`1h`/`24h`, Standard `1h`), `albumKeyEpochMinutes` (0/15/60/180/1440/10080), `albumKeyEpochsAhead` (1-3). Unbekanntes wird ignoriert. Beispiel: `{"pullUpAction":"switcher","statusDirectOnly":true}` |
| `NUDITY_MODEL` | `nudenet` | Erkennungsmodell fuer den Nacktbild-Filter, vom Router ausgeliefert: `nudenet` (Standard, im Test das beste, erkennt Koerperteile einzeln), `nsfwjs` (MobileNetV2, ca. 2,6 MB), `nsfwjs-mid` (ca. 4 MB), `nsfwjs-inception` (ca. 21 MB), `bumble` (Bumble Private Detector, ca. 51 MB) oder `off`; NudeNet ca. 12 MB + 15 MB Laufzeit. Alle sind im Docker-Image enthalten (`models/README.md`); fehlt eins (z. B. ohne Docker), gilt `nsfwjs`. Auf der Testseite (Debug-Modus) lassen sich alle installierten vergleichen |
| `NUDITY_THRESHOLD` | je Modell | Ab welchem Wert (0.2 bis 0.95) ein Bild unscharf erscheint; ohne Angabe der Standard des Modells (NudeNet 0.4, sonst 0.7). Hoeher = weniger Fehlalarme, mehr Durchrutscher |
| `NUDITY_CLASSES` | je Modell | Welche Klassen des aktiven Modells zaehlen (Komma-Liste). NSFWJS: `Drawing`, `Hentai`, `Neutral`, `Porn`, `Sexy` (Standard `Porn,Hentai`, mit `Sexy` strenger); NudeNet: Koerperteile wie `MALE_GENITALIA_EXPOSED` (Standard: alle entbloessten Genitalien, Brust, Anus, Po); Bumble: nur `Lewd` |
| `NUDITY_SCAN_REQUIRED` | `off` | Pflicht-Scan (auch live im Admin-Panel): `off` (jeder entscheidet selbst), `minors` (unter 18 kann den Nacktbild-Filter nicht abschalten), `minor-chats` (dazu prueft jeder Empfaenger Bilder von unter 18, markiert in der verschluesselten Nachricht), `everyone` (fuer alle) |
| `NUDITY_MODEL_DIR` | `data/nudity-models` | Eigener Ordner fuer Modelle (neben der Datenbank, im Container also im Daten-Volume); ein Ordner `bumble/` bzw. `nudenet/` darin hat Vorrang vor den mitgelieferten |
| `AUDIENCE_MINIMUM` | - | Mindestwerte fuer "Wer mich im Grid sieht", die der Router in jede Karte in "Entdecken"/"Event" mischt (JSON wie eine Regel, z. B. `{"ranges":{"age":{"min":18}}}`). Wer den Wert nicht angibt, sieht dann niemanden. |
| `RATE_LIMIT_SCALE` | `1` | Faktor fuer alle Rate-Limits (1 bis 100), nur fuer Tests mit vielen Clients hinter einer IP (die E2E-Tests nutzen 20) |
| `CREDENTIAL_RETENTION_DAYS` | `180` | Nach so vielen Tagen ohne Registrierung werden Zugangsdaten, Push-Abo, eigene Chat-Kontrollen und wartende Nachrichten eines Peers geloescht (mindestens 7) |
| `TRUST_PROXY` | private Netze | Welchen Proxies `X-Forwarded-For` geglaubt wird: `true`, `false`, Anzahl Hops oder Adressen/Netze. Standard: Loopback und private Netze |
| `LAN_MODE` | `false` | `true` = Club-/LAN-Betrieb: keine STUN/TURN-Server, nur Verbindungen im selben Netz |
| `VAPID_SUBJECT` | `mailto:admin@localhost` | Kontaktadresse fuer Push-Dienste (`mailto:` oder `https:`); Apple lehnt den Standardwert ab |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | generiert | Optional feste VAPID-Schluessel (base64url); sonst einmalig erzeugt und in SQLite gespeichert |
| `APP_MODES` | alle | Erlaubte App-Modi, kommagetrennt: `discovery`, `chat`, `friends`, `event`. Z. B. `chat` fuer einen reinen Chat-Server. Sind nur Modi eines Bereichs erlaubt (Entdecken: `discovery`/`event`, Social: `chat`/`friends`), entfaellt die Bereichswahl beim Onboarding |
| `DEFAULT_APP_MODE` | erster erlaubter | Vorauswahl fuer neue Nutzer |
| `AGE_CHECK` | `off` | Altersnachweis: `off`, `confirm` (Nutzer bestaetigt "mindestens 18"), `provider` (Nachweis ueber einen Anbieter, siehe `AGE_PROVIDER`). Bis zum Nachweis ist ein Nutzer unsichtbar und bekommt kein Grid |
| `AGE_PROVIDER` | - | Anbieter fuer `AGE_CHECK=provider`: `eudi` (EU-Altersnachweis ueber die Wallet, siehe "Nachweise und Sperren"), `oidc` (beliebiger OpenID-Connect-Pruefdienst, z. B. KJM-anerkannt, siehe `AGE_OIDC_*`) oder `dev` (bestaetigt auf Knopfdruck, nur zum Testen); unbekannt = es gilt `confirm` |
| `AGE_TRUST_CERTS` | - | Fuer `eudi`: Ordner mit PEM-Dateien zusaetzlich anerkannter Aussteller (Aussteller- oder CA-Zertifikate) |
| `AGE_TRUSTED_LIST_URL` | EU-Liste | Fuer `eudi`: automatischer Import der "Age Verification Trusted List" der Kommission (taeglich, nur mit gueltiger Signatur); `off` = kein Import |
| `AGE_TRUSTED_LIST_SIGNER` | Zertifikat der Kommission | SHA-256-Fingerabdruecke (Komma-Liste) erlaubter Unterzeichner der Liste; bei einem Zertifikatswechsel der Kommission hier den neuen eintragen |
| `ADMIN_SETUP_TOKEN` | zufaellig | Setup-Token fuer den ersten Admin-Passkey (sonst steht ein zufaelliger im Log); wirkt nur, solange kein Passkey existiert |
| `AGE_EUDI_TEST` | `true` | Testseite fuer den Wallet-Nachweis im Debug-Modus (`/api/safety/age-test/...`, prueft gegen EU-Test- und echte Liste, speichert nichts); `false` = aus |
| `AGE_OIDC_ISSUER`, `AGE_OIDC_CLIENT_ID`, `AGE_OIDC_CLIENT_SECRET` | - | Fuer `oidc`: Aussteller (https, mit `/.well-known/openid-configuration`), Client-ID und optional Client-Secret (sonst oeffentlicher Client mit PKCE). Im Admin-Panel live aenderbar (Eintrag `AGE_OIDC`, Secret verschluesselt mit `SAFETY_KEY`, nie angezeigt) |
| `AGE_OIDC_SCOPE`, `AGE_OIDC_CLAIM` | `openid`, `age_over_18` | Scopes und der Claim, der "ab 18" sagt (auch verschachtelt, z. B. `age.over_18`); gelesen aus dem ID-Token, sonst vom userinfo-Endpunkt |
| `AGE_OIDC_ADULT_VALUE`, `AGE_OIDC_MINOR_VALUE` | `true`, `false` | JSON-Werte des Claims fuer "ab 18" bzw. "sicher unter 18" (Gruppe unter 18). Andere oder fehlende Werte = abgelehnt; `AGE_OIDC_MINOR_VALUE` leer = nie "unter 18" |
| `AGE_OIDC_REDIRECT_URI` | `APP_URL/age-callback` | Rueckleitung nach dem Dienst; beim Dienst so eintragen |
| `AGE_EUDI_DOCTYPES` | `av,pid,mdl` | Welche Nachweise gelten: `av` (EU-Altersnachweis), `pid` (EU-Personalausweis in der Wallet), `mdl` (ISO-Fuehrerschein, z. B. in Apple/Google Wallet); gelesen wird nur `age_over_18` |
| `EMAIL_CHECK` | `off` | `required`: Nutzer bestaetigen eine E-Mail-Adresse per 6-stelligem Code. Gespeichert wird sie verschluesselt (`SAFETY_KEY`) plus ein HMAC fuer Sperren |
| `EMAIL_TRANSPORT` | `log` | Versand der E-Mail-Codes: `log` (Code im Server-Log, nur zum Testen) oder `smtp` (Mailserver des Betreibers, siehe `SMTP_URL`) |
| `SMTP_URL` | - | Fuer `EMAIL_TRANSPORT=smtp`: `smtp://user:pass@mail.example.org:587` (STARTTLS) oder `smtps://user:pass@mail.example.org:465` (TLS). Der Mailserver erfaehrt nur Adresse und Code. Fuer gute Zustellung SPF/DKIM der Absender-Domain einrichten |
| `SMTP_FROM` | - | Absender, z. B. `OpenGrid <no-reply@example.org>` |
| `SAFETY_KEY` | in SQLite erzeugt | 32 Byte (base64 oder hex) fuer E-Mail-Verschluesselung und HMACs. Im Betrieb setzen, damit Schluessel und Daten getrennt liegen |
| `ABUSE_LOG_DAYS` | `0` | IP-Protokoll fuer Anfragen der Strafverfolgung: Peer-ID, IP und Zeit, so viele Tage (0 = aus, hoechstens 14) |
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

### Nachweise und Sperren

Alters- und E-Mail-Nachweis sowie das IP-Protokoll sind standardmaessig aus
(`AGE_CHECK`, `EMAIL_CHECK`, `ABUSE_LOG_DAYS`). Ist ein Nachweis verlangt,
registriert sich ein neuer Nutzer, bleibt aber unsichtbar und bekommt kein
Grid, bis er ihn erbracht hat. Chats ueber Einladungslinks funktionieren
weiter. Der Router speichert nur den Status, die E-Mail verschluesselt und bei
Anbieter-Nachweisen einen HMAC des Pseudonyms, nie Ausweis- oder
Gesichtsdaten. E-Mail-Codes gehen ueber den eigenen Mailserver
(`EMAIL_TRANSPORT=smtp`, nodemailer ist eine optionale Abhaengigkeit).
KJM-anerkannte Alters-Anbieter folgen, siehe `tasks/board.md` (T2).

Getrennte Altersgruppen: Ist ein Altersnachweis verlangt, sehen sich in
"Entdecken" und "Event" nur Menschen derselben Gruppe. Wer "ueber 18" nachweist,
sieht nur 18+; wer mit der Wallet "unter 18" nachweist, sieht nur unter 18; ohne
Nachweis gibt es kein Entdecken. "Chat & Freunde" ist davon nicht betroffen.

Pruefdienst ueber OpenID Connect (`AGE_CHECK=provider`, `AGE_PROVIDER=oidc`), z. B. ein
KJM-anerkannter Anbieter oder ein eID-Service mit OIDC (Vergleich der Optionen fuer
Deutschland: `documentation/ALTERSNACHWEIS-DEUTSCHLAND.md`):

- Beim Dienst einen Client anlegen, Rueckleitung `APP_URL/age-callback`; Aussteller,
  Client-ID/-Secret und den Claim per `AGE_OIDC_*` oder im Admin-Panel (`AGE_OIDC`) setzen.
- Ablauf: die App leitet zum Dienst (Authorization Code + PKCE), der Dienst zurueck in
  die App, der Router prueft das ID-Token (Signatur, Aussteller, Client, Ablauf, Nonce)
  und liest nur den Alters-Claim. Gespeichert werden nur die Altersgruppe und ein HMAC
  von Aussteller + `sub` (fuer Sperren), keine Tokens, keine Namen.
- "Unter 18" gilt nur, wenn der Dienst es ausdruecklich sagt (`AGE_OIDC_MINOR_VALUE`);
  fehlt der Claim oder ist er unklar, wird der Nachweis abgelehnt.
- Der Dienst sieht nur die Pruefung, nie Profile, Chats oder Standorte.

EU-Altersnachweis ueber die Wallet (`AGE_CHECK=provider`, `AGE_PROVIDER=eudi`):

- Die App fragt ueber die Digital Credentials API des Browsers (Chrome/Edge ab
  141, Safari ab 26) nur `age_over_18` ab; der Nutzer waehlt seine Wallet
  (EU-Altersnachweis-App, EUDI-Wallet, Fuehrerschein in der Wallet). Der Router
  prueft die Antwort (Ausstellersignatur, Bindung an Nonce und `APP_URL`,
  Gueltigkeit) und speichert nur "18+" und einen HMAC des Geraeteschluessels
  (fuer Sperren). Kein externer Dienst, keine Ausweisdaten.
- Anerkannte Aussteller: automatisch aus der EU-Liste
  (`https://trust.tech.ec.europa.eu/lists/age-verification/av-tl.xml`, nur mit
  gueltiger Signatur des bekannten Kommissions-Zertifikats, taeglich erneuert,
  letzte gueltige Fassung im Datenordner) und/oder eigene PEM-Dateien in
  `AGE_TRUST_CERTS`. Stand 10/2026 steht darin nur Daenemark (AltID); Deutschland
  plant eine Wallet ab 2027.
- `APP_URL` setzen: die Wallet-Antwort ist an die Herkunft der Seite gebunden.
- Je nach Land verlangen Wallets eine Registrierung als "Relying Party"; ohne
  sie koennen Anfragen abgelehnt werden. Signierte Anfragen sind noch nicht
  eingebaut.
- Status und sofortiger Import:
  `docker compose exec open-grid node scripts/safety-admin.mjs age-trust`.
- Testen ohne Sperre: im Debug-Modus unter Einstellungen > Privatsphaere
  "Altersnachweis testen (Wallet)". Prueft wie echt, speichert und schaltet aber
  nichts frei, und erkennt zusaetzlich die Test- und Demo-Aussteller der EU-Testliste
  (`acceptance.trust.tech.ec.europa.eu`, eigener gepinnter Test-Unterzeichner).
  Zum Ausprobieren: die Demo-App der EU-Altersverifikation fuer Android
  (`github.com/eu-digital-identity-wallet/av-app-android-wallet-ui/releases`),
  darin "National eID" (Demo-Aussteller). Funktioniert unabhaengig von
  `AGE_CHECK`; abschalten mit `AGE_EUDI_TEST=false`.

Sperren und Auskunft (nur auf richterlichen Beschluss) im Container:

```sh
docker compose exec open-grid node scripts/safety-admin.mjs ban-peer <peerId> [grund]
docker compose exec open-grid node scripts/safety-admin.mjs ban-email <adresse> [grund]
docker compose exec open-grid node scripts/safety-admin.mjs access-log <peerId>
docker compose exec open-grid node scripts/safety-admin.mjs email <peerId>
```

Der Nacktbild-Filter (`CLIENT_DEFAULTS.nudityFilter`) laeuft nur auf dem
Geraet des Empfaengers. Das Erkennungsmodell liefert der Router selbst aus; die
App laedt es erst, wenn der Nutzer den Filter einschaltet. Einstellbar ueber
`NUDITY_MODEL`, `NUDITY_THRESHOLD` und `NUDITY_CLASSES` (siehe Konfiguration).
Im Debug-Modus zeigt Medien > Schutz > "Erkennung testen" die Werte fuer eigene
Bilder (alles lokal), um Modell und Schwelle zu waehlen.

Die mitgelieferten NSFWJS-Modelle erkennen maennliche Nacktheit schlecht
(Trainingsdaten ueberwiegend weiblich). Zwei staerkere Modelle sind im
Docker-Image enthalten und per `NUDITY_MODEL` waehlbar:

| Modell | Lizenz | Groesse | Hinweis |
|---|---|---|---|
| `bumble` (Bumble Private Detector) | Apache-2.0 | ca. 51 MB | fuer ungefragte Nacktbilder in Dating-Apps gebaut; ohne Grafikbeschleunigung langsam |
| `nudenet` (NudeNet 320n) | AGPL-3.0 | ca. 12 MB + 15 MB WASM | erkennt Koerperteile einzeln; AGPL passt zur GPL-3.0 von OpenGrid, bei eigenen Aenderungen den Quelltext anbieten |

Bumble liegt umgewandelt im Repository (`models/bumble`, aus dem Original mit
`scripts/nudity-models/convert-bumble.py`); NudeNet laedt das Docker-Image beim
Bauen aus dem PyPI-Paket `nudenet` 3.4.2 (feste Pruefsumme). Ohne Docker oder fuer
eigene Fassungen: `sh scripts/nudity-models/fetch.sh --dir models nudenet` bzw.
`--volume <docker-volume> nudenet bumble` (Bumble: ca. 600 MB Download, ca. 3 GB
freier Platz, einige Minuten). NudeNet braucht `onnxruntime-web` (optionale Abhaengigkeit);
nur das Worker-Skript des Filters darf dafuer WebAssembly kompilieren
(`'wasm-unsafe-eval'`), die Seite selbst nicht.

## Admin-Panel

Abgeschaltete Teile (Nacktbild-Filter mit `NUDITY_MODEL=off`, Alters-/E-Mail-
Nachweis bei `AGE_CHECK=off` und `EMAIL_CHECK=off`, Wallet-Testseite mit
`AGE_EUDI_TEST=false`) liefert der Router gar nicht aus: weder Code noch
Oberflaeche noch Modell. Wird ein Teil im Panel eingeschaltet, bekommen ihn die
Apps beim naechsten Laden.

Unter `/admin` (eigene Seite, gleiche Sicherheitsregeln wie die App, nicht
indexiert). Anmeldung nur per Passkey (Gesichtserkennung, Fingerabdruck oder
Sicherheitsschluessel), kein Passwort.

- Erster Passkey: Solange keiner existiert, schreibt der Router beim Start
  einen einmaligen Setup-Link ins Log (24 Stunden gueltig), z. B.
  `docker compose logs open-grid | grep "Admin panel"`. Link oeffnen, Passkey
  anlegen, fertig. Fuer automatisiertes Aufsetzen kann `ADMIN_SETUP_TOKEN` den
  Token festlegen (wirkt nur, solange kein Passkey existiert).
- `APP_URL` setzen: Passkeys sind an die Domain gebunden.
- Weitere Passkeys (z. B. Handy und Laptop) im Panel unter "Passkeys"; der
  letzte laesst sich nicht entfernen.
- Auslastung: alle 10 Sekunden CPU, Arbeitsspeicher, Event-Loop-Verzoegerung,
  Peers online, WebSocket-Verbindungen, Anfragen, Serverfehler, Antwortzeit,
  Zwischenspeicher, freier Platz und Datenbankgroesse; letzte Stunde bzw. 24
  Stunden, mit Warnungen (z. B. wenig Platz). Der Verlauf liegt in der
  Datenbank und uebersteht Neustart und Deployment; eine Anmeldung gilt 12
  Stunden, auch ueber einen Neustart hinweg.
- Status: Version, Laufzeit, Peers, Push-Abos, Nacktbild-Modell, Nachweise,
  Alters-Aussteller.
- Zwischenspeicher: Analyse der wartenden Nachrichten (Pfad C) nur aus
  Metadaten, die der Router ohnehin hat: Anzahl, Groesse, Alter, abgelaufene,
  Empfaenger (online, offline oder unbekannt = holt nie ab) und Absender ->
  Empfaenger. Inhalt und Art bleiben verschluesselt und werden nicht erfasst.
  Aufraeumen: abgelaufene, alles fuer einen Empfaenger oder alles.
- Einstellungen: sofort wirksam (ohne Neustart, gespeichert, gewinnt ueber die
  Umgebungsvariable, "Zuruecksetzen" nimmt wieder deren Wert): `AGE_CHECK`,
  `EMAIL_CHECK`, `ABUSE_LOG_DAYS`, `NUDITY_MODEL`, `NUDITY_THRESHOLD`,
  `NUDITY_CLASSES`, `CLIENT_DEFAULTS`, `AUDIENCE_MINIMUM`. Der Rest (Ports,
  Datenbank, TURN, SMTP, `AGE_PROVIDER`, ...) steht zur Ansicht da und braucht
  einen Neustart; Geheimnisse nur als "gesetzt". `AGE_CHECK=provider` geht nur
  mit gesetztem `AGE_PROVIDER`.
- Sperren: Peer-ID oder E-Mail-Adresse sperren (gespeichert nur als HMAC),
  aufheben; eine offene Verbindung des Peers wird getrennt.
- Meldungen: Findet jemand ein weitergegebenes Bild, prueft er es in der App
  ("Wasserzeichen pruefen") und meldet den Treffer. Beim Server kommen nur die
  Peer-ID, die Trefferquote und eine Notiz an, nie das Bild. Das Panel zeigt,
  wie viele verschiedene Personen denselben Peer gemeldet haben; "Peer sperren"
  sperrt mit einem Klick (alle offenen Meldungen zu ihm gelten als erledigt).
  Je Peer hoechstens 10 Meldungen pro Stunde.

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
