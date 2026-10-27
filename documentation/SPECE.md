# Technische Spezifikation

## 1. Komponentenstruktur

- `server/app.js` implementiert die HTTP- und REST-Routen.
- `server/database.js` kapselt eine lokale SQLite-Datenbank.
- `server/signaling.js` verwaltet aktive WebSocket-Verbindungen und leitet
  WebRTC-Signaling-Nachrichten weiter.
- `client/grid.client.js` kapselt Discovery, Heartbeats und den
  Signaling-Client.
- `client/p2p.client.js` kapselt WebRTC, DataChannels und das verschluesselte
  P2P-Protokoll; `client/delivery.client.js` Chat-Sync, Sende-Queue und
  Pfad C.
- `client/crypto.client.js` stellt gemeinsame Kodierungsfunktionen fuer
  Web-Crypto-Payloads bereit.
- `index.html` enthaelt nur noch das HTML-Markup der App-Shell.
- `client/app/*.js` enthaelt die UI-Logik als klassische Skripte (globaler
  Scope, Reihenfolge wie in `index.html`): `config.js` (Konfiguration,
  `state`), `storage.js` (IndexedDB, Chat-Operationen), `profile.js`
  (Profil, Medien, Onboarding), `chat.js` (Modal, Chat),
  `chat-tools.js` (Antworten, Reaktionen, Suche, Kontaktleiste), `snaps.js`
  (Snaps, Kamera), `actions.js` (deklarative Aktionen, siehe unten),
  `settings.js` (Debug, Schluessel, Toasts, Tabs, Sichtbarkeit),
  `router.js` (Client-Routen, History), `viewer.js` (Bildbetrachter),
  `albums.js` (Alben, Medienuebersicht), `push.js` (Web Push), `main.js`
  (Start). `client/geohash.client.js` kodiert den eigenen Standort.
- `client/styles.css` und `client/app/tailwind.config.js` enthalten Styles
  und die Tailwind-Konfiguration.
- Der Server liefert nur Dateien aus der festen Liste `clientAssetFiles` in
  `server/app.js` aus; neue Client-Dateien muessen dort eingetragen werden.
- Thema und Akzentfarbe (`client/app/theme.js`, im `<head>` geladen, damit
  nichts aufflackert): `localStorage` `opengrid-theme` (`system`, `light`,
  `dark`) und `opengrid-accent` (`{ hue, saturation }`). Tailwind bezieht
  `slate` und `brand` aus CSS-Variablen (`rgb(var(--slate-500) / <alpha>)`,
  `tailwind.config.cjs`); `:root` enthaelt die dunklen Standardwerte,
  `:root.theme-light` eine angepasste helle slate-Skala (Seite hellgrau,
  Karten weiss, Text dunkel). Die Akzentpalette 50-950 wird aus Farbton und
  Saettigung per HSL berechnet. Einstellung: Farbrad (Winkel = Farbton,
  Abstand zur Mitte = Saettigung) plus Vorgaben, "Standard" setzt zurueck.
- Schriftgroesse im Chat: `localStorage` `opengrid-chat-font-size`
  (`small` 13 px, `normal` 15 px, `large` 17 px, `xlarge` 19 px) setzt die
  CSS-Variable `--chat-font-size`.
- Start (`client/app/main.js`): Nur Datenbank, Speicherverschluesselung,
  eigenes Profil, Identitaetsschluessel und Signaling sind kritisch. Alle
  anderen Schritte laufen ueber `runStartupStep` mit Fallback; Fehler werden
  protokolliert, die App startet trotzdem und meldet "Einige Funktionen
  konnten nicht geladen werden". Hintergrund-Promises loggen Fehler mit Kontext
  (`logBackgroundError`), `unhandledrejection` und `error` landen im Debug-Log.
- Debug-Modus: `CONFIG.DEBUG_MODE` kommt aus `localStorage`
  (`opengrid-debug-mode` = `on`/`off`, Standard aus). Ist er an, traegt
  `<html>` die Klasse `debug-on`. Elemente mit der Klasse `debug-only` sind
  sonst per CSS ausgeblendet. Technische Toasts laufen ueber
  `showDebugToast()` und erscheinen nur im Debug-Modus.
- Navigation: `switchTab()` steuert die Ansichten und markiert alle Knoepfe mit
  passendem `data-tab-btn` (Header-Navigation auf dem Desktop,
  Bottom-Navigation auf Smartphones).
- Verbindungshinweis: `updateConnectivityIndicator` (`settings.js`) zeigt nach
  4 s ohne Netz oder WebSocket die Icons `.offline-indicator` (Kopfzeile,
  Chat-Kopf); ohne `navigator.onLine` sofort.
- Chat-Wechsel (`client/app/chat-switch.js`): im offenen Chat zum vorherigen
  oder naechsten Chat derselben Liste (`visibleChatPeerIds`, Reihenfolge wie
  die Chatliste). Einstellung `keys`/`chat-switch-settings`
  (`{ enabled, style }`, Standard an + `bar`): `bar` = Avatar-Leiste unter der
  Kontaktleiste, `arrows` = Pfeile in der Kontaktleiste, `swipe` = seitlich
  wischen auf der Kontaktleiste (ab 70 px; nicht auf Nachrichten, dort heisst
  wischen "antworten"). Ein Wechsel ersetzt den History-Eintrag.
- Album-Knopf (`chat-tools.js`): in Chats der Liste `social` versteckt;
  600 ms langer Druck auf "Snap" zeigt ihn fuer den aktuellen Chat
  (`state.albumButtonRevealedFor`) und unterdrueckt den Klick auf die Kamera.
- Originalbilder (`client/app/originals.js`): "Als Bild senden" mit
  "Original" schickt die Vorschau wie gewohnt (`snapData`, max. 70 KB, auch
  ueber Pfad C) und `message.original = { size, sha256, mime }`. Das Original
  (JPEG 0.95, max. 4096 px, per Canvas neu kodiert, also ohne EXIF; mit
  Wasserzeichen, wenn eingeschaltet) liegt beim Absender in `media/orig_<id>`.
  Der Empfaenger fragt es nur ueber einen offenen DataChannel an
  (`ORIGINAL_REQUEST { messageId }`), der Absender liefert
  `ORIGINAL_CHUNK { messageId, index, total, data }` (64 KB, max. 240 Stuecke,
  Pause ab 1 MB `bufferedAmount`). Nie ueber Pfad C. Nach dem Zusammensetzen
  prueft der Empfaenger Laenge und SHA-256 und speichert es verschluesselt
  (`originalReady`). Haengt eine Uebertragung, wird nach 60 s neu angefragt
  (bei jedem Verbindungsaufbau).
- Sprachnachrichten (`client/app/voice.js`): Aufnahme per MediaRecorder
  (Opus, ca. 12 kbit/s, max. 15 min). `message.audioData` ist eine Data-URL
  `data:audio/...;base64,` mit den ersten 60 s (max. 160 000 Zeichen),
  `audioDuration` die Gesamtlaenge in Sekunden, optional `transcript` (max.
  2000 Zeichen). Der Anfang geht wie jede Nachricht per P2P oder Pfad C (dafuer
  erlaubt `/api/cache` 256 KB Ciphertext). Ist die Aufnahme laenger, startet
  bei 60 s ein zweiter Recorder; dieser Rest ist eine eigene, abspielbare Datei
  und geht als `original = { size, sha256, mime: 'audio/...' }` (max. 6 MB)
  ueber den Original-Weg, also nur P2P/TURN; `audioSplitAt` ist die Sekunde des
  Wechsels. Der Empfaenger spielt den Anfang sofort; fehlt der Rest am Ende des
  Anfangs, wartet die Wiedergabe, fordert ihn an (baut P2P auf) und spielt
  weiter, sobald er geprueft gespeichert ist (`onVoiceRestReady`). Am Maximum
  stoppt die Aufnahme nur, gesendet wird nie automatisch. Der Text entsteht
  nur, wenn der Browser lokal verschriftlichen kann (`SpeechRecognition` mit
  `processLocally`, vorher `SpeechRecognition.available(...)` = `available`);
  sonst gibt es keinen Text, nie einen Cloud-Dienst. Abspielen ueber eine
  Blob-URL (`media-src blob:`). Zaehlt wie Bilder fuer die
  Chat-Berechtigungen. Bei leerem Eingabefeld ersetzt das Mikrofon den
  Senden-Knopf.
- Videos (`client/app/video.js`): nur P2P/TURN. Die Nachricht traegt ein
  Vorschaubild (`snapData`, JPEG max. 480 px), `video = { duration, w, h }` und
  `original = { size, sha256, mime }` (`video/mp4|webm|quicktime|ogg`, Datei
  max. 25 MB, als Data-URL max. 36 MB). Das Video selbst laeuft ueber denselben
  Weg wie Originalbilder (`ORIGINAL_REQUEST`/`ORIGINAL_CHUNK`, max. 576
  Stuecke), nie ueber Pfad C; Pruefung per SHA-256, Speicherung verschluesselt.
  Bis dahin zeigt die Nachricht "Video kommt bei direkter Verbindung" mit
  Fortschritt. Abspielen im Video-Viewer (`#video-viewer`, gleiche Optik wie der
  Bildbetrachter: Vollbild schwarz, Kopfzeile mit Absender, Zeit und Laenge;
  nach unten wischen, Esc oder Zurueck schliesst) ueber eine Blob-URL, ohne
  Download-Knopf und Bild-in-Bild; die Blob-URL wird beim Schliessen freigegeben.
- Ablauf nach der ersten Ansicht: der Absender legt `snapSettings.expiry` fest
  (Enum `'15m' | '30m' | '60m' | 'off'`, Standard `30m` bzw.
  `CLIENT_DEFAULTS.snapExpiry`), es geht als `message.snapExpiry` mit dem Snap.
  Der Empfaenger merkt sich `firstViewedAt` bei der ersten Ansicht; nach Ablauf
  wird der Snap geloescht und `SNAP_CONSUMED` gesendet (Timer im offenen Chat,
  sonst beim naechsten Oeffnen). Der Empfaenger zeigt keine Restzeit an.
  Snaps ohne Angabe gelten als `30m`.
- Einmal-Snaps: die Ansicht zaehlt beim Oeffnen (`snapViews` sofort
  gespeichert); nach der letzten Ansicht wird beim Schliessen geloescht und
  `SNAP_CONSUMED` gesendet, war die App weg, beim naechsten Oeffnen des Chats
  (`expireUsedReplaySnaps`). Weiter zum naechsten ungesehenen Snap
  (`advanceReplaySnap`, zeitlich der naechste) per `snapSettings.nextGesture`:
  `doubletap`, `swipe` (seitlich > 80 px) oder `swipeup`.
- Galerie-Mehrfachauswahl (max. 20): jedes Bild ohne Editor als eigener Snap,
  Secure Snap, Bild oder Foto-Status (`sendPickedImages`).
- `SNAP_SAVED { messageId }` (Chat-Operation, vom Empfaenger eines Einmal-Snaps
  beim Speichern): der Absender markiert `savedByPeer` und zeigt einen Hinweis.
- Listen-Wechsel (`chat-switch.js`): Knopf neben dem Titel der Chatliste,
  `keys`/`list-switch-settings` `{ enabled, behavior }`: `mode` wechselt den
  App-Modus zur anderen Seite (zuletzt genutzter Modus, `appModeSettings.
  lastSocialMode`/`lastDiscoveryMode`), `view` zeigt nur die andere Liste
  (`state.chatListScopeOverride`, mit "Modus wechseln"; Tab-Wechsel und Neu
  laden setzen zurueck). Die Status-Leiste folgt der angezeigten Liste.
- Standardwerte vom Router: `/api/config` liefert `clientDefaults` (Env
  `CLIENT_DEFAULTS`, serverseitig gegen erlaubte Schluessel und Werte
  geprueft). Die Einstellungs-Loader nehmen sie, solange kein eigener
  Datensatz existiert (`clientDefault(key, fallback)`).
- Start ueber `/chat/<id>` (Neu laden, Push): `showChatLoadingPlaceholder` zeigt
  sofort das Chat-Layout; der Chat wird direkt nach Datenbank und Chatliste
  geoeffnet (Startschritt "Chat oeffnen"), vor Service Worker, Schluesseln und
  Signaling. Die P2P-Verbindung folgt nach `SOCKET_REGISTERED`. Sicherheitsnetz:
  ist der Chat am Ende des Starts nicht offen oder steht noch der Platzhalter,
  wird er erneut geoeffnet.
- Bildgroesse: `MESSAGE_PUT` traegt bei Bildern `imageSize { w, h }`
  (`measureImage` beim Senden); `createSecureImage` setzt die Canvas-Groesse
  sofort, der Platz ist vor dem Zeichnen reserviert. Ohne Groesse (aeltere
  Nachrichten) haelt ein 4:3-Platzhalter den Platz.
- Scrollposition im Chat (`chat.js`): `state.chatPinned` = man ist unten
  (hoechstens 80 px Abstand). Betreten setzt immer unten; Senden ebenfalls,
  ausser man ist mehr als 1,5 Bildschirmhoehen nach oben gescrollt. Ein
  `MutationObserver` zieht nach, solange man unten klebt (Canvas-Bilder werden
  erst nach dem Zeichnen hoch). Neu-Rendern behaelt sonst die Position. Ab
  einer Bildschirmhoehe Abstand erscheint der Knopf "nach unten".
- Smartphone: `fitChatListPanel` begrenzt die Chatliste auf den Platz bis zur
  unteren Navigation, die Liste scrollt in sich. Der Kurzstatus steht in einer
  eigenen Zeile unter dem Namen.
- Nachrichtenfeld `#chat-input` ist ein `<textarea>`; `fitChatInput` (`chat.js`)
  setzt die Hoehe bis `CHAT_INPUT_MAX_LINES` (5), danach scrollt es.
- Snap-Kamera (`snaps.js`, `snap-camera.js`, `snap-editor.js`): Vollbild, alle
  Bedienelemente liegen ueber dem Bild. Licht per
  `applyConstraints({ advanced: [{ torch }] })` und Zoom per `zoom`, nur wenn
  `getCapabilities()` sie meldet. Gesten per Pointer Events auf der Vorschau:
  runter > 110 px = schliessen, seitlich > 80 px = Snap/Bild umschalten
  (`state.snapSendMode`; "Bild" = `MESSAGE_PUT` mit `snapData` ohne
  `snapMode`, dauerhaft, keine Secure-Snap-Regeln), doppelt tippen (< 300 ms) = Kamera wechseln,
  zwei Finger = Zoom; am Ausloeser hoch > 60 px = Galerie. Aufnahme =
  Rohbild ohne Wasserzeichen (max. 1080 px). Der Editor haelt Striche
  (Canvas-Koordinaten) und Text/Emoji-Ebenen (Position 0..1, Groesse relativ
  zur Breite); `flattenSnapDraft` zeichnet alles in einen Canvas, erst danach
  bettet `encodeSnap` das Wasserzeichen ein und komprimiert unter 70 KB.
- Gesten (`client/app/gestures.js`, nur Touch): Nachricht wischen (fremde
  nach rechts, eigene nach links, ab 56 px) = antworten; lange druecken
  (450 ms) = Aktionsleiste; doppelt tippen = Reaktion ❤️; seitlich wischen
  (ab 80 px, nicht in den 24-px-Kantenzonen, nicht in horizontal scrollbaren
  Bereichen oder im offenen Chat) = Tab Grid/Chat/Profil wechseln; Profil- und
  Medienfenster von oben nach unten wischen = schliessen; im Chat am Ende nach
  oben ziehen = einstellbare Aktion (`keys`/`pullup-settings.action`: `reload`
  = Tab neu laden (Standard, ohne Toast), `next` = naechster Chat der Liste,
  `switcher` = Auswahl aller Chats der Liste (`openChatSwitcherSheet`),
  `snap` = Snap-Kamera, `album` = Album teilen). Nachrichten
  nutzen Pointer Events mit `touch-action: pan-y`, alles andere passive Touch
  Events. Die System-Geste "zurueck" und Pull-to-Refresh des Browsers bleiben
  unberuehrt.
- Client-Routen (`client/app/router.js`): `/grid`, `/chat`, `/chat/:peerId`,
  `/profile`, `/settings`, `/cloud`. Der Server liefert fuer alle dieselbe
  App-Shell. `switchTab()` legt per `history.pushState` einen Eintrag an,
  `popstate` stellt Tab und Chat wieder her. `/` und alte Deep Links
  (`/?chat=<id>`) werden beim Start per `replaceState` umgeschrieben.
  Menue, Profil-, Snap-, Medien-Modal und Bildbetrachter bekommen einen
  eigenen History-Eintrag (`state.modal`, `state.modalDepth`). Modals koennen
  gestapelt sein (`state.modalStack`); "Zurueck" schliesst alle Modals oberhalb
  der Tiefe des neuen Eintrags. Navigiert man aus einem Modal
  heraus, ersetzt die neue Route den Modal-Eintrag.

Der Dienst laeuft als einzelner Docker-Container hinter einem TLS
terminierenden Reverse Proxy.

## 2. Identitaet

- Beim ersten Start erzeugt der Browser eine UUID-basierte `nodeId`.
- Die `nodeId` liegt in `localStorage` und bleibt bis zum Loeschen der
  Websitedaten stabil.
- Alle Tabs derselben Origin verwenden dieselbe `nodeId`.
- Jede Laufzeit erzeugt eine separate `registrationId`.
- Private kryptografische Schluessel verlassen den Browser nicht.

## 3. Routing und Grid

SQLite speichert in `peers`:

- Peer-ID
- aktuelle Registration-ID
- Geohash (maximal Praezision 6, ca. 1,2 x 0,6 km)
- Anzeigename
- Thumbnail
- Silent-Flag
- Ablaufzeit

`POST /api/register` akzeptiert zusaetzlich:

| Feld | Typ | Bedeutung |
|---|---|---|
| `silent` | boolean | Peer ist nicht im Grid sichtbar, bleibt aber per Signaling und Pfad C erreichbar |
| `ttlMinutes` | number | Sichtbarkeit nach dem letzten Heartbeat, auf 1 bis 60 Minuten begrenzt (Standard 10) |

Der Geohash muss gueltiges Base32 mit mindestens 6 Zeichen sein; der Router
kuerzt ihn auf 6 Zeichen. Der Client sendet nie Koordinaten an den Router.
Die Zelle stammt aus einer von zwei Quellen:

- Geraetestandort (opt-in): `navigator.geolocation`, lokal zur Zelle kodiert,
  Koordinaten werden verworfen.
- Adresse: auf ausdruecklichen Klick fragt der Browser direkt
  OpenStreetMap Nominatim (`/search?format=jsonv2&limit=1`, ohne Referrer)
  und kodiert das Ergebnis lokal zur Zelle. Der Adresstext bleibt nur als
  lokales Label in `grid-settings.locationLabel`.
 Wechselt ein Peer die Zelle oder in den Silent-Modus, entsteht
ein Tombstone fuer die bisherige Zelle. Ein Silent-Peer loest kein
`PEER_OFFLINE` aus.

Der Client erneuert die Registrierung alle 25 Sekunden. Ohne Heartbeat laeuft
sie nach der gewaehlten TTL ab (Standard zehn Minuten). Eine alte Registration-ID darf eine neuere
Registrierung desselben Peers nicht entfernen.

Die erste Registrierung stellt ein zufaelliges Peer-Capability-Token aus.
Der Browser bewahrt es lokal auf; der Server speichert nur dessen SHA-256-
Hash getrennt vom kurzlebigen Presence-Eintrag. Queue-, Chat-Control- und
WebSocket-Zugriffe muessen dieses Token vorlegen. Signaling-Nachrichten
erhalten serverseitig die authentifizierte Absender-ID.

Das Grid entspricht immer der aktuellen Router-Antwort fuer einen Geohash.
Lokale Cache-Eintraege werden nicht ohne aktiven Router-Eintrag angezeigt.
Explizit entfernte Peers erhalten einen zeitlich begrenzten Tombstone.

### 3.0 App-Modi

Der Betreiber erlaubt Modi per `APP_MODES` (kommagetrennt aus `discovery`,
`chat`, `friends`, `event`; Standard alle) und `DEFAULT_APP_MODE`.
`GET /api/config` liefert `{ modes, defaultMode, profileSchemas }`; der Client merkt sich die
Antwort fuer den Offline-Start (`keys`/`app-config`). Der Nutzer waehlt beim
Onboarding (falls mehrere erlaubt) und in den Einstellungen
(`keys`/`app-mode = { mode, scope, scopeBeforeAll, eventCode, eventHash, eventJoinedAt, modeBeforeEvent }`).

Bereich (`scope`, `client/app/modes.js`): beim Onboarding waehlt der Nutzer
zuerst `discovery` (Nur Entdecken: `discovery` + `event`), `social` (Social:
`chat` + `friends`) oder `all` (Entdecken & Freunde, alle Modi). Fehlt `scope`
(bestehende Nutzer), gilt `all`. Wirksam sind nur Modi aus `APP_MODES` im
Bereich (`state.appConfig.routerModes` -> `state.appConfig.modes`); erlaubt
der Betreiber nur Modi eines Bereichs, gilt dieser und die Frage entfaellt.

- Nur Entdecken: kein Adden, auch nicht nach einem Match (`allowsMatchFriends()`
  ist `false`, das eigene Profil sendet `allowMatchFriends: false`, Anfragen
  bleiben unsichtbar); der gespeicherte Schalterwert bleibt erhalten.
- Social: Freunde-Grid ja, Flamme/Match nein.
- Listen-Wechsel nur bei `all`.
- Einstellungen und Knoepfe mit `data-scope="discovery|social"` erscheinen nur,
  wenn der Bereich enthalten ist, `data-scope="all"` nur bei `all`
  (Klasse `.scope-hidden`).
- Aendern unter Einstellungen > Allgemein > App-Modus > Erweitert (Auswahl
  Bereich, Schalter "Alle Modi anzeigen"; aus = zurueck zu `scopeBeforeAll`).

| Modus | Registrierung | Grid |
|---|---|---|
| `discovery` | `scope: 'public'` | Ringe um die eigene Zelle (3.1) |
| `chat` | `scope: 'public'`, immer `silent` | keins (Grid-Tab ausgeblendet) |
| `friends` | `scope: 'friends'` | `GET /api/grid?scope=friends&peerId=` (Bearer): nur online, gegenseitig abonnierte, nicht blockierte Kontakte (Presence-Abos, 4.1) |
| `event` | `scope: 'event'`, `eventHash` | `GET /api/grid?scope=event&eventHash=`: alle mit demselben Hash |

`POST /api/register` akzeptiert dafuer `scope` (`public`, `friends`, `event`;
nur erlaubte Modi) und bei `event` den `eventHash` (64 Hex-Zeichen). Das
oeffentliche Grid zeigt nur `scope = 'public'`; der Wechsel aus dem
oeffentlichen Grid erzeugt einen Tombstone, und nur oeffentlich sichtbare Peers
loesen `PEER_OFFLINE` aus. Ist `discovery` nicht erlaubt, antwortet das
oeffentliche Grid mit 403.

Der Event-Code wird im Client normalisiert (Grossbuchstaben, einfache
Leerzeichen) und als `SHA-256("og-event:" + code)` gesendet; der Server sieht
den Code nie. Nach 12 Stunden verlaesst der Client das Event automatisch.

**Profil-Schema pro Modus**: `PROFILE_SCHEMAS` (JSON-Objekt, Schluessel =
Modus) ueberschreibt einzelne Modi; ohne Angabe nutzt `chat` ein schlankes
Schema (Anzeigename + Status), alle anderen `PROFILE_SCHEMA`. Die App-Shell
bekommt alle Schemas eingebettet, aktiv ist das des gewaehlten Modus. Das
Profil enthaelt nur Felder des aktiven Schemas (plus `displayName`); fremde
Profile zeigen auch Felder aus anderen Schemas an.

**Profil-Handshake**: Steht nach dem ersten `KEY_HELLO` noch kein Profil des
Peers im Cache (neuer Kontakt per Einladung oder erste Nachricht), fragt der
Client es sofort per `PROFILE_REQUEST` an; Chatliste und Kontaktleiste
uebernehmen Name und Bild, sobald es ankommt.
Kam der neue Chat ohne P2P-Sitzung (erste Nachricht ueber den Router-Cache
oder Push), holt `requestMissingProfile` das Profil aktiv: direkt per
`PROFILE_REQUEST` (startet den P2P-Aufbau), sobald der Peer laut Praesenz online
ist, und zusaetzlich per `SWARM_PROFILE_REQUEST` ueber andere offene Kanaele.
Je Weg hoechstens einmal pro Minute und Peer; ein Klick aufs Profil ist nicht
noetig.

**Einladungslinks** (`chat`, `friends`): `/invite#<peerId>.<fingerprint>`,
Fingerprint = erste 32 Hex-Zeichen von `SHA-256("<crv>:<x>:<y>")` des
ECDSA-Profilschluessels. Der Teil nach `#` erreicht den Server nie. Beim
Oeffnen legt der Client den Kontakt an und merkt sich den Fingerprint
(`keys`/`invite-expect:<peerId>`); beim ersten `KEY_HELLO` muss der
Schluessel passen, sonst wird die Verbindung verworfen (Schutz gegen einen
Server, der eine fremde Identitaet einschleust). Der QR-Code wird lokal mit
`qrcode-generator` (`/vendor/qrcode/qrcode.js`) erzeugt.

### 3.1 Grid in Ringen

`GET /api/grid?geohash=<eigene Zelle>&ring=<0-5>[&live=1]` laedt das Grid
schrittweise ("Mehr laden"). Jeder Ring enthaelt alle vorherigen:

| Ring | Zellen | Abdeckung ca. |
|---|---|---|
| 0 | eigene Zelle (Praezision 6) | 1 km |
| 1 | eigene Zelle + 8 Nachbarn (Praezision 6) | 3 km |
| 2 | Elternzelle (Praezision 5) + 8 Nachbarn | 15 km |
| 3 | Praezision 4 + 8 Nachbarn | 100 km |
| 4 | Praezision 3 + 8 Nachbarn | 450 km |
| 5 | Praezision 2 + 8 Nachbarn | 3000 km |

Der Router berechnet die Nachbarzellen selbst und fragt jede Zelle als
Praefix-Bereich ab (`geohash >= p AND geohash < p || '~'`). Die Antwort ist
nach Entfernung der Zellmittelpunkte sortiert, auf 100 Peers begrenzt und
enthaelt pro Peer nur `id`, `name`, `avatar` und `distanceBucket` - weder
Koordinaten noch Geohash. `hasMore` zeigt an, ob der naechste Ring weitere
Peers enthaelt. `live=1` liefert nur Peers mit aktiver WebSocket-Verbindung.

| `distanceBucket` | Anzeige |
|---|---|
| `lt1` | Sehr nah (< 1 km) |
| `1-5` | In der Naehe |
| `5-20` | In der Stadt |
| `20-100` | 20-100 km |
| `100-300` | 100-300 km |
| `300-500` | 300-500 km |
| `gt500` | > 500 km |

Sind nach einer Antwort weniger als 6 Peers sichtbar und meldet der Router
`hasMore`, laedt der Client automatisch den naechsten Ring, hoechstens bis Ring
3 (manuell per "Mehr laden" bis Ring 5). Ohne weitere Peers ist `hasMore`
falsch, es entsteht keine Schleife.

Alle Peers einer Zelle haben denselben Mittelpunkt. Mehrfache Abfragen von
verschiedenen Orten liefern deshalb hoechstens die Zelle, keine genauere
Position (Schutz gegen Trilateration).

## 4. WebRTC-Signaling und Presence

`GET /api/ice-config` liefert die ICE-Server. STUN: `STUN_SERVER`
(`host:port` oder `none`), sonst der eigene TURN-Server, erst ohne beides
`stun.l.google.com`. Mit `LAN_MODE=true` ist die Liste leer (`lanMode: true`,
auch in `/api/config`): nur host/mDNS-Kandidaten, Verbindungen nur im selben
Netz. Die Einstellung "Nur lokales Netz" (`grid-settings.lanOnly`) bewirkt das
pro Geraet fuer neue Verbindungen. Nach dem Verbindungsaufbau ermittelt der
Client per `getStats()` das gewaehlte Kandidatenpaar (`lan` = host/host,
`relay`, sonst `direct`) und zeigt "im selben WLAN" in der Kontaktleiste.

Der WebSocket-Endpunkt `/ws` vermittelt:

- SDP Offer und Answer
- ICE Candidates
- Offline-Fallback-Meldungen
- `PEER_OFFLINE`-Hinweise

Schliesst die aktive WebSocket-Verbindung eines Peers, sendet der Server
`{ type: 'PEER_OFFLINE', peerId }` an alle verbundenen Peers in derselben
Geohash-Zelle. Die Zelle jedes verbundenen Peers haelt der Server im
Speicher (Index Zelle -> Peers, aktualisiert bei `REGISTER_SOCKET` und
`/api/register`); ein Verbindungsende kostet so O(Peers der Zelle) statt
O(alle Verbindungen). Diese markieren den Peer sofort als offline, brechen eine
laufende Presence-Pruefung ab und verwerfen einen noch nicht verbundenen
WebRTC-Versuch. Eine bestehende P2P-Verbindung bleibt davon unberuehrt.
Ein getrennter P2P-Kanal wird nach 3 Sekunden im Zustand `disconnected`
neu aufgebaut.

Der Server speichert keine Signaling-Nachrichten. Pro Peer-ID ist genau die
neueste WebSocket-Verbindung aktiv.

Ein Offline-Fallback verwirft den unbrauchbaren lokalen Verbindungsversuch.
Sobald der Peer wieder in einer aktuellen Grid-Antwort erscheint, wird eine
offene Chat- oder Nachrichtenverbindung mit einer neuen RTCPeerConnection
aufgebaut.

Jede entschluesselte Nachricht (P2P und Pfad C) wird vor der Verarbeitung von
`client/app/payload-validation.js` geprueft: nur bekannte Typen, erwartete
Feldtypen und Obergrenzen (Text 10 000 Zeichen, Bilder 3 MB, Sync-Listen 50
IDs, Profile 50 Felder, Alben 500 Bilder); rohe DataChannel-Nachrichten ueber
4 MB werden gar nicht erst geparst. Ungueltiges wird verworfen und im
Debug-Log vermerkt.

Nach Aufbau des DataChannels tauschen beide Clients oeffentliche ECDH-P-256-
Schluessel aus und leiten einen AES-256-GCM-Session-Key ab. Beim Oeffnen eines
Profils prueft ein verschluesseltes `PRESENCE_PING`/`PRESENCE_PONG` die
Erreichbarkeit.

### 4.1 Presence fuer Chat-Partner

Zwischenspeicher-Hinweis: legt ein Sender eine Nachricht in den Cache
(`POST /api/cache`) und der Empfaenger ist per WebSocket online, sendet der
Server ihm `{ type: 'CACHE_WAITING' }` (ohne Inhalt, ohne Absender); der Client
ruft den Cache dann sofort ab (`scheduleCacheFetch`, gebuendelt). Zusaetzlich
beim Zurueckkehren in die App. Vorher holte ein online Client ohne Web Push
den Cache erst beim naechsten Verbinden ab.

Schluesselaustausch: `KEY_HELLO` wird beim Oeffnen des Kanals gesendet und alle
4 s wiederholt (hoechstens 4 Mal), solange kein Sitzungsschluessel besteht.
Bekommt eine Seite ein `KEY_HELLO`, obwohl sie schon einen Schluessel hat
(die Gegenseite hat ihn noch nicht), antwortet sie mit ihrem eigenen.

Wachhund fuer Verbindungsversuche (`watchConnectionAttempt`): ohne Antwort auf
das Angebot nach 8 s, mit Antwort aber ohne offenen Kanal nach 20 s wird die
Verbindung abgebaut und neu angeboten (hoechstens 3 Mal in Folge; zurueckgesetzt,
sobald ein Kanal offen ist). Vorher blieb ein verlorenes Angebot fuer immer
"connecting".

Heartbeat (gegen halb offene Verbindungen, z. B. Smartphone im Hintergrund oder
WLAN-Wechsel):

- Server: WebSocket-Ping alle 30 s; wer bis zum naechsten Ping nicht antwortet,
  wird getrennt. Signaling an ihn bekommt dann `PEER_OFFLINE_FALLBACK`.
- Client: `{ type: 'PING', nonce }` alle 25 s (sichtbare App), beim
  Zurueckkehren in die App und beim `online`-Ereignis; der Server antwortet
  `{ type: 'PONG', nonce }`. Ohne Antwort in 5 s baut der Client den Socket neu
  auf (`reconnectSignaling`).
- Nach jedem `SOCKET_REGISTERED` baut der Client P2P-Verbindungen zum offenen
  Chat und zu Peers mit wartenden Nachrichten neu auf; Verbindungen, die noch
  `new`/`connecting` sind, gelten dabei als haengend (ihre Angebote gingen an
  den alten Socket). Das gilt auch fuer Chat-Partner ausserhalb des Grids.

Online-Status von Chat-Partnern haengt nicht vom Grid ab:

- Nach `SOCKET_REGISTERED` sendet der Client
  `{ type: 'PRESENCE_SUBSCRIBE', peerIds }` mit allen nicht blockierten
  Chat-Partnern (max. 500); erneut bei neuem Chat-Partner und nach
  Block-Aenderungen.
- Der Server antwortet mit `{ type: 'PRESENCE_SNAPSHOT', online: [...] }` und
  meldet danach Wechsel als `{ type: 'PRESENCE', peerId, online }`.
- Sichtbar ist der Status nur **gegenseitig**: A sieht B nur, wenn A B und B A
  abonniert hat und keiner den anderen blockiert hat. Einseitige Abos liefern
  nichts.
- Der Silent-Modus spielt keine Rolle (er versteckt nur im Grid).
- Der Server speichert nichts dazu (kein "zuletzt online"); Abos leben nur im
  Speicher der aktiven Verbindung.
- Last: O(k) pro Verbindungsaufbau/-ende (k = Chat-Partner), kein Polling.
- Kommt ein Partner online und warten Nachrichten an ihn oder ist sein Chat
  offen, baut der Client sofort die P2P-Verbindung auf. Das Profil-Modal
  nutzt fuer Chat-Partner diesen Status statt eines P2P-Pings.

| Status | Berechnung auf dem anfragenden Client |
|---|---|
| Online | Passender Pong innerhalb von 4 Sekunden |
| Abwesend | Router-Eintrag vorhanden, aber kein Pong |
| Offline | Eigene Netzwerk- oder Signaling-Verbindung fehlt oder `PEER_OFFLINE` empfangen |

Ueber den verschluesselten DataChannel meldet ein Client mit
`CHAT_FOCUS { open: boolean }`, ob der Chat mit dem Gegenueber gerade sichtbar
ist (aktiver Chat, Chat-Tab offen, Seite sichtbar). Die Meldung wird nie
gequeued oder ueber Pfad C gesendet und verfaellt beim Verbindungsabbau.
Ausserhalb des Debug-Modus zeigt der Chat-Kopf daraus ein Symbol: gruener
Punkt fuer einen bestehenden E2EE-Kanal, Augen, wenn das Gegenueber den Chat
geoeffnet hat.

## 5. Profilprotokoll und lokaler Cache

`PROFILE_REQUEST` und `PROFILE_RESPONSE` werden als AES-GCM-verschluesselte
`SECURE_ENVELOPE`-Nachrichten uebertragen. Eine Profilantwort enthaelt ID,
Avatar, Profilfelder, `version` und `updatedAt`.

Der bei einem direkten `KEY_HELLO` gelernte ECDSA-Schluessel wird zusammen mit
der Peer-ID lokal gepinnt. Die Profilpruefung unterscheidet drei Ergebnisse:

| Ergebnis | Bedeutung |
|---|---|
| `trusted` | Signatur gueltig, Schluessel entspricht dem gepinnten Pin |
| `unpinned` | Signatur gueltig, Schluessel noch nicht direkt bestaetigt |
| `false` | Umschlag unvollstaendig, Besitzer-ID falsch, Schluessel abweichend oder Signatur ungueltig |

Direkt empfangene Profile muessen `trusted` sein. Der Swarm-Fallback akzeptiert
zusaetzlich `unpinned`, da ein ueber Dritte bezogenes Profil zwangslaeufig noch
keinen Pin besitzt. Ein solcher Schluessel wird **nicht** gepinnt: er gilt nur
als Anzeigewert, bis eine direkte Verbindung ihn bestaetigt. Existiert bereits
ein Pin, ist dieser bindend - ein abweichender Schluessel gilt als Faelschung.

Damit die spaetere direkte Verbindung ein zuvor per Swarm gecachtes Profil auch
bei identischer Version ersetzen kann, laesst `cachePeerProfile` den Uebergang
von `unpinned` nach `trusted` als Sonderfall zu.

IndexedDB Version 9 enthaelt:

| Store | Inhalt |
|---|---|
| `keys` | nicht exportierbarer AES-GCM-Schluessel fuer Profil-Caches |
| `localProfile` | genau ein verschluesseltes eigenes Profil |
| `profiles` | ausschliesslich verschluesselte Profile anderer Peers |
| `messages` | lokaler Chatverlauf pro Peer |
| `chatOperations` | idempotente Put-/Delete-/React-Operationen pro Chat |
| `gridPeers` | minimale lokale Routing-Metadaten |
| `media` | verschluesselte Bilder (Galerie, Alben) |
| `albums` | eigene Alben (`ownerId` = eigene ID, mit `acl`) und empfangene Alben anderer Peers (seit Version 8) |
| `statusUpdates` | eigene Status und Status von Freunden, `{ id, peerId, expiresAt, sealed }`, Inhalt mit dem Speicherschluessel verschluesselt (seit Version 9) |

Der Store `keys` enthaelt zusaetzlich den Datensatz `router-auth` mit
`nodeId` und Router-Token. Er spiegelt `localStorage` fuer den Service
Worker, der keinen Zugriff auf `localStorage` hat. Der Datensatz
`push-settings` speichert `compactNotifications` fuer den Service Worker.
Die Datensaetze `app-config`, `app-mode` und `invite-expect:<peerId>` gehoeren
zu den App-Modi (Abschnitt 3.0), `album-keys:*` zu den Alben (5.1). Der Datensatz `chat-gate` spiegelt die Chat-Berechtigungen fuer den Service
Worker (Abschnitt 6.0). Der Datensatz `grid-settings` speichert `silent`, `ttlMinutes`, `liveGrid`,
`cacheEnabled` (Standard an), `useLocation`, `locationLabel` und `safeZones`
(Liste von Geohash-Zellen). Ein fehlender Datensatz entspricht den Standardwerten.
Safe Zones verlassen nie das Geraet: Liegt die eigene Zelle in einer Safe
Zone, registriert sich der Client als `silent`. Weitere Datensaetze:
`chat-scopes` (Chatlisten, 6.0), `chat-reads` (Lesestand fuer Ungelesen-Badges, 6.0), `album-defaults`, `album-ticket:<albumId>`
(5.1), `privacy-settings` (Spur-Wasserzeichen) und `status-settings`
(`directOnly`, Status).

### 5.2 Status (R7, `client/app/status.js`)

Nur im Chat- und Freunde-Modus, nur unter Freunden.

| Operation | Inhalt |
|---|---|
| `STATUS_POST` | `{ statusId, kind: 'text' \| 'photo', text (max. 280), color, image (Foto, max. 70 KB), createdAt, expiresAt }` |
| `STATUS_DELETE` | `{ statusId }` |

- Versand an jeden Freund einzeln als `CHAT_OPERATION`: P2P, steht nach 10 s
  kein Kanal, ueber Pfad C (ohne Web Push). Mit `status-settings.directOnly`
  nur P2P. Status landen nicht im Chat-Log; beim naechsten Verbindungsaufbau
  liefert der Absender aktive Status nach, die der Freund noch nicht hat.
- Fotos kommen aus Snap-Kamera und Editor (`openSnapCamera('status')`); jeder
  Freund bekommt sein eigenes Wasserzeichen (wenn eingeschaltet).
- Empfaenger nehmen Status nur von Freunden an und begrenzen `expiresAt` auf
  hoechstens 24 h ab Empfang. Abgelaufene Status loescht der Client beim
  Start und alle 15 Minuten; endet eine Freundschaft, werden deren Status
  sofort geloescht.
- Kurzstatus (Rich Presence): `myProfile.presenceText` (max. 60 Zeichen) steht
  nur im Profil fuer Freunde (signiert) und erscheint neben dem Online-Status
  in Chatliste und Kontaktleiste.
- Datenschutz: ueber Pfad C sieht der Server, dass ein Absender zeitgleich an
  mehrere Empfaenger schickt (Freundeskreis erkennbar); "Status nur direkt"
  vermeidet das.

### 5.1 Alben

Album-Datensaetze (inkl. `secret` und rollender Keys) liegen wie Profile mit dem
Speicherschluessel verschluesselt im Store `albums` (`{ id, sealed: { iv, ciphertext } }`);
alte Klartext-Datensaetze werden beim Laden migriert.

Ein eigenes Album ist `{ id: 'alb_<uuid>', ownerId, name, items: [{ id, version }], acl: [peerId] }`.
Die Bilder (`albimg_<uuid>`, max. 1080 px, JPEG 0.7) liegen verschluesselt in
`media`. Alben sind nicht Teil des Profils.

Teilen: Der Besitzer nimmt den Chat-Partner in die `acl` auf und sendet eine
Chat-Nachricht mit `message.album = { albumId, ownerId, name, cover, count }`
(Deckfoto max. 30 KB). Der Empfaenger akzeptiert den Verweis nur, wenn
`ownerId` dem Absender entspricht.

P2P-Protokoll (nur ueber den verschluesselten DataChannel):

| Nachricht | Richtung | Bedeutung |
|---|---|---|
| `ALBUM_REQUEST { albumId }` | Betrachter -> Besitzer | Albuminhalt anfragen |
| `ALBUM_RESPONSE { album: { id, name, items } }` | Besitzer -> Betrachter | nur wenn der Betrachter in der `acl` steht und die Anfrage offen ist |
| `ALBUM_DENIED { albumId }` | Besitzer -> Betrachter | kein Zugriff; der Betrachter loescht seine Kopie |
| `ALBUM_REVOKED { albumId }` | Besitzer -> Betrachter | Zugriff entzogen oder Album geloescht |

Inhaltsschluessel: Jedes eigene Album hat ein Geheimnis `secret` (32 Byte,
nur beim Besitzer) und eine `keyVersion`. Pro Bild gilt (Schema 2, R3; fuer
alle Betrachter gleich, damit Betrachter Bilder weitergeben koennen)

```
CK = HKDF-SHA256(ikm = secret, salt = "<albumId>:<keyVersion>", info = "og-album-image:<imageId>")
```

Albumbilder gehen nur als Ciphertext unter `CK` raus
(`IMAGE_RESPONSE { imageId, version, keyVersion, keyScheme: 2, encrypted: { iv, ciphertext } }`);
der Betrachter speichert nur den Ciphertext (`media`: `{ encrypted, version,
keyVersion, keyScheme, relayedBy? }`). Der Sender bettet vorher ein
Wasserzeichen mit der ID des Empfaengers ein (Abschnitt 6.2). Gespeicherte
Kopien ohne `keyScheme: 2` (Schema 1, Schluessel pro Betrachter) gelten als
veraltet und werden neu angefragt.

`ALBUM_RESPONSE` enthaelt zusaetzlich `manifest`: einen mit dem
ECDSA-Identitaetsschluessel des Besitzers signierten Umschlag
`{ payload: { id, ownerId, name, keyVersion, updatedAt, items }, publicKey, signature }`.
Betrachter speichern ihn mit dem Album; geprueft wird nur gegen den gepinnten
Schluessel des Besitzers (`verifyEnvelope`).

**Schluesselverteilung (Alben v2, P12)**: Der Schluessel zum Auspacken der
`CK`s setzt sich aus drei Teilen zusammen - eigener Schluessel, Schluessel der
Quelle (Besitzer) und rollender Source-Key `R_e`, den der Besitzer pro Album
und Epoche zufaellig erzeugt:

```
KEK_e = HKDF-SHA256(ikm = ECDH(eigener Identitaetsschluessel, Identitaetsschluessel der Gegenseite),
                    salt = R_e, info = "og-album:<albumId>:<epoch>:<keyVersion>")
```

Der Besitzer schickt jedem Betrachter in der `acl` die Chat-Operation
`ALBUM_KEYS { bundles }` mit je einem Buendel fuer die laufende und die
vorab eingestellten Epochen: `{ albumId, keyVersion, epoch, epochMs,
epochEndsAt, rollingKey, iv, wrapped }` (`wrapped` = AES-GCM unter `KEK_e` ueber alle `CK`s). Weg: P2P,
steht nach 10 Sekunden kein Kanal, Pfad C (kein Web Push). Gesendet wird beim
Start des Besitzers, zu jedem Epochenwechsel (Timer aus `/api/time`), wenn ein
Betrachter online kommt oder sich verbindet, beim Teilen und nach einem Entzug
(neue Version) - pro Betrachter, Album, Version und Epoche hoechstens einmal.
`ALBUM_KEYS` wird nicht ins Operations-Log uebernommen.

Gueltigkeit pro Album (R2): `album.keyEpochMinutes` (0 = Server-Wert
`MEDIA_KEY_EPOCH_MINUTES`, sonst 15, 60, 180 oder 1440) bestimmt die
Epochenlaenge, `album.keyEpochsAhead` (1 bis 3) die vorab gelieferten
Epochen; ein Push enthaelt also hoechstens 4 Buendel. Epoche =
`floor(Serverzeit / epochMs)`. Neue Alben uebernehmen den Standard aus
`keys`/`album-defaults` (`{ epochMinutes, epochsAhead }`). Eine Aenderung
schickt sofort neue Buendel; alte laufen zu ihrem Ende ab, die
Inhaltsschluessel bleiben gleich (kein neuer Bild-Download). Der Betrachter
waehlt das Buendel, dessen Fenster `[epochEndsAt - epochMs, epochEndsAt)` die
Serverzeit enthaelt.

Der Betrachter speichert nur die Buendel (`keys`/`album-keys:<albumId>:<keyVersion>:<epoch>`,
abgelaufene werden geloescht). Beim Ansehen leitet er `KEK_e` fuer die
laufende Epoche ab, packt die `CK`s als nicht exportierbare `CryptoKey`s aus
und haelt sie nur im Arbeitsspeicher; bei `epochEndsAt` werden sie verworfen
und das naechste Buendel geoeffnet. Buendel gelten nur, wenn ihr Absender der
Besitzer des Albums ist. Fehlt ein Buendel, fragt der Betrachter den Besitzer
direkt (`ALBUM_KEY_REQUEST { albumId }`, P2P); dieser antwortet mit einem neuen
`ALBUM_KEYS`.

Folgen: Ein Betrachter sieht ein Album bis zu zwei Epochen weiter, auch wenn
der Besitzer offline ist. Nach einem Entzug steigt `keyVersion` (neue `CK`s),
der entzogene Betrachter bekommt keine Buendel mehr und verliert den Zugriff
spaetestens mit dem Ende der naechsten Epoche.

**Schwarm-Abruf (R3, `client/app/swarm.js`)**: Antwortet der Besitzer nicht
(kein offener Kanal bzw. nach 1,5 s), fragt der Client seine offenen
P2P-Kanaele. Es wird nichts zusaetzlich gespeichert; weitergegeben wird nur,
was der Client selbst schon hat.

| Typ | Antwort | Pruefung beim Empfaenger |
|---|---|---|
| `SWARM_IMAGE_REQUEST { ownerId, imageId, version }` | `SWARM_IMAGE_RESPONSE { ..., data }` | nur oeffentliche Profile; `SHA-256(data)` = `sha256` des Galerie-Eintrags im signierten Profil |
| `SWARM_ALBUM_REQUEST { ownerId, albumId, ticket }` | `SWARM_ALBUM_RESPONSE { ..., manifest }` | Manifest vom gepinnten Besitzer-Schluessel signiert, nur neuere Staende (`keyVersion`, `updatedAt`) |
| `SWARM_ALBUM_IMAGE_REQUEST { ownerId, albumId, imageId, version, ticket }` | `SWARM_ALBUM_IMAGE_RESPONSE { ..., keyVersion, keyScheme, encrypted }` | Bild im Manifest, passende Versionen, eigenes Wasserzeichen; Speicherung mit `relayedBy` |

Zugangstickets: Jedes `ALBUM_KEYS` enthaelt `ticket`, einen vom Besitzer
signierten Umschlag `{ albumId, ownerId, viewerId, keyVersion, expiresAt }`
(`expiresAt` = Ende der letzten gelieferten Epoche). Der Betrachter speichert es
unter `keys`/`album-ticket:<albumId>` und schickt es mit jeder Album-Anfrage an
den Schwarm. Der Weitergebende antwortet nur, wenn die Signatur zum gepinnten
Besitzer-Schluessel passt, `viewerId` der Peer am anderen Ende des
verschluesselten Kanals ist und das Ticket nicht abgelaufen ist. Damit bekommt
ein Zweitaccount ohne eigene Freigabe keine Kopie mit seinem Wasserzeichen,
und die Zugriffsliste bleibt privat.

Wasserzeichen-Pruefung: Verlangt das Manifest ein Wasserzeichen, entschluesselt
der Anfragende die weitergegebene Kopie sofort mit seinen Album-Schluesseln und
behaelt sie nur, wenn sie sein eigenes Tag traegt (`identifyWatermark`). Ein
Weitergebender kann das Wasserzeichen also nicht weglassen oder auf einen
anderen Peer faelschen; ohne gueltige Schluessel nimmt der Client keine
weitergegebene Kopie an.

Ein weitergebender Betrachter braucht selbst gueltige Album-Schluessel: er
entschluesselt seine Kopie, setzt das Wasserzeichen des Anfragenden und
verschluesselt neu unter `CK`. Ansehen kann der Anfragende nur mit eigenen
`ALBUM_KEYS` vom Besitzer; die Zugriffsliste bleibt damit beim Besitzer.
Weitergegebene Kopien werden durch die des Besitzers ersetzt, sobald er
erreichbar ist.

Grenzen:
- Ein berechtigter Betrachter koennte einem anderen ein falsches Bild unter
  `CK` unterschieben (er hat `CK`); das Manifest schuetzt Name und Bildliste,
  nicht den Bildinhalt.
- Das Wasserzeichen ist Abschreckung, kein Beweis: wer den Klartext hat und
  den Client manipuliert, kann es entfernen oder faelschen (das Verfahren ist
  im Client-Code sichtbar).
- Zwei vom Besitzer freigegebene Accounts derselben Person koennen ihre
  Kopien vergleichen und das Wasserzeichen gezielt entfernen (Kollusion).

Galerie-Eintraege tragen `sha256` (Base64 von SHA-256 der Data-URL), alte
Eintraege bekommen ihn beim Start (`ensureGalleryHashes`). Das signierte Profil
enthaelt jetzt auch `audience`, damit Dritte Match-Profile nicht als oeffentlich
weitergeben koennen.

`IMAGE_REQUEST` liefert nur noch Galeriebilder des eigenen Profils oder Bilder
aus Alben, in deren `acl` der anfragende Peer steht. `IMAGE_RESPONSE` wird nur
fuer angefragte Bilder aus dem gecachten Profil oder einem empfangenen Album
desselben Besitzers angenommen. Ein Entzug wirkt fuer neue Anfragen sofort;
bereits empfangene Kopien loescht der Client des Betrachters nach
`ALBUM_REVOKED`/`ALBUM_DENIED` (ohne Garantie gegen manipulierte Clients).

Speicher: Beim Start bittet die App per `navigator.storage.persist()` um
dauerhaften Speicher und zeigt `navigator.storage.estimate()` in den
Einstellungen (Hinweis ab 80 % Belegung). "Nicht mehr benoetigte Medien
entfernen" loescht Eintraege im Store `media`, die weder zur eigenen Galerie,
zu gecachten Galerien, zu Alben noch zu offenen Secure Snaps gehoeren.

Nur eine hoehere Profilversion ersetzt einen vorhandenen Cache.
Das eigene Profil wird nie durch Grid-Tombstones oder Peer-Cache-Bereinigung
geloescht. Beim Upgrade von Version 3 wird ein vorhandenes eigenes Profil
einmalig aus `profiles` nach `localProfile` verschoben.

Fehlt `localProfile`, blockiert ein modaler Erststartdialog die
Router-Registrierung. Er rendert alle Felder aus `PROFILE_SCHEMA`, validiert
Pflichtfelder und wird erst nach erfolgreicher AES-GCM-Speicherung geschlossen.

## 6. Chat-Deltasynchronisation

Chats werden als idempotente Operationen synchronisiert:

- `MESSAGE_PUT` enthaelt eine neue Nachricht. Eine Antwort traegt
  `message.replyTo = { messageId, senderId, preview }` (Vorschau max. 80
  Zeichen); der Empfaenger bereinigt das Feld.
- `MESSAGE_DELETE` ist ein Tombstone fuer eine zuvor gesendete Nachricht.
- `MESSAGE_REACT` setzt die Reaktion eines Absenders auf eine Nachricht
  (`emoji` aus 👍 ❤️ 😂 😮 😢 🔥 oder `null` zum Entfernen). Pro Absender und
  Nachricht gilt die neueste Operation (`createdAt`); aeltere werden aus
  `chatOperations` geloescht. Reaktionen loesen keinen Web Push aus.
- Markierungen (`message.starred`) und die Chat-Suche sind rein lokal und
  werden nicht synchronisiert.
- Normale Snaps tragen `snapMode: 'replay'`: der Empfaenger kann sie einmal
  ansehen und einmal wiederholen (lokal `snapViews`). Danach wird `snapData`
  in `messages` und im Operations-Log (`put:<id>`) geloescht, und der
  Empfaenger sendet die Chat-Operation `SNAP_CONSUMED { messageId }`
  (`consumed:<id>`, P2P oder Pfad C, kein Web Push). Der Sender loescht darauf
  seine Kopie (`snapData` und `put:`-Operation), ausser er hat den Snap selbst
  gespeichert. Nur der Empfaenger eines eigenen Einmal-Snaps darf das melden. Mit "Speichern"
  setzt der Empfaenger lokal `snapSaved`; dann bleibt der Snap wie ein Bild im
  Chat. Secure Snaps lassen sich nie speichern. Snaps ohne `snapMode` (vor
  dieser Aenderung) bleiben dauerhaft sichtbar.
- Snaps (`message.snapData`) werden auf max. 1080 px verkleinert und so lange
  komprimiert, bis die Data-URL hoechstens 70 000 Zeichen hat. So passen sie
  auch in Pfad C (Queue-Limit 256 KB Ciphertext, wegen Sprachnachrichten).
- Geht eine eigene Nachricht ueber Pfad C, speichert der Sender
  `cacheExpiresAt` aus der Queue-Antwort. Taucht ihre `put:`-Operation im
  `CHAT_SYNC_HELLO` oder `CHAT_SYNC_INVENTORY` des Peers auf, wird sie als
  `deliveryConfirmed` markiert. Ist die TTL ohne Bestaetigung abgelaufen,
  zeigt der Chat "Nicht abgeholt - wird bei der naechsten direkten Verbindung
  zugestellt"; der naechste Chat-Sync liefert die Operation aus.
- Operationen besitzen global eindeutige IDs und koennen mehrfach empfangen
  werden, ohne doppelte Nachrichten zu erzeugen.

Nach jedem neuen E2EE-Schluessel und vor einem weiteren Nachrichtenversand
tauschen beide Clients die 20 neuesten Operations-IDs aus. Fehlende
Operationen werden angefordert. Aeltere IDs werden anschliessend in
Inventarseiten zu je 50 IDs im Hintergrund verglichen.

Jede Nachricht traegt lokal ein `deliveredVia`-Label (nur im Debug-Modus
sichtbar):

| Label | Bedeutung |
|---|---|
| `Establishing secure channel...` | Gesendet, Kanal noch nicht bereit |
| `E2EE P2P` | Direkt ueber den DataChannel gesendet oder empfangen |
| `E2EE Sync` | Beim Empfaenger ueber die Chat-Synchronisation nachgeliefert |
| `Encrypted Path C` | Ueber die Server-Queue gesendet oder empfangen |
| `E2EE Push` | Vom Service Worker aus einer Web-Push-Nachricht gespeichert |
| `Pending` | Weder P2P noch Pfad C erfolgreich; Zustellung beim naechsten Sync |
| `Delivery rejected` | Empfaenger hat Pfad C abgelehnt (z. B. blockiert) |

Steht der Kanal 10 Sekunden nach dem Senden noch nicht, wird die Operation
ueber Pfad C eingestellt; schlaegt auch das fehl, wird sie `Pending`. Beim
Laden eines Chats werden Nachrichten, die laenger als 15 Sekunden auf
`Establishing secure channel...` stehen, ebenfalls auf `Pending` gesetzt.

**Gleichzeitiger Aufbau**: Bieten beide Seiten gleichzeitig an, gilt
"perfect negotiation" (hoeflich ist die Seite mit der groesseren Node-ID, sie
nimmt das Angebot der anderen an). Haengt der Aufbau trotzdem, versucht die
hoefliche Seite es erst nach zufaelligen 1-3 s erneut und gar nicht, wenn die
andere inzwischen begonnen hat (sonst kollidieren beide Wachhunde wieder).
Fehlt beiden das Profil des anderen, wartet die hoefliche Seite 1,5 s mit dem
eigenen Aufbau. Verschluesselte Nachrichten, die vor dem eigenen
Sitzungsschluessel ankommen (beide leiten gleichzeitig ab), werden bis zu 50
Stueck zurueckgehalten und danach in Reihenfolge verarbeitet (vorher gingen
sie verloren, z. B. Profil-Anfragen).

**Empfangsbestaetigung (P2P)**: Ein offener DataChannel kann halb tot sein
(der Partner hat gerade das Netz verloren, ICE merkt es erst nach bis zu 30 s);
`send()` klappt dann, die Nachricht kommt aber nie an. Der Empfaenger
bestaetigt jede direkt empfangene `CHAT_OPERATION` sofort mit
`CHAT_OPERATION_ACK { operationId }`. Fehlt die Bestaetigung nach 5 Sekunden
(bei noch gepufferten grossen Nachrichten bis zu 60 Sekunden), wird die
Verbindung abgebaut und die Operation ueber Pfad C eingestellt (sonst
`Pending` und erneuter Versand beim naechsten Kanal). Meldet der Server den
Partner offline (`PRESENCE`/`PEER_OFFLINE`), geht Unbestaetigtes und
Wartendes sofort ueber Pfad C. Doppelt ankommende Operationen erkennt der
Empfaenger an der `operationId`. Gilt nur fuer Operationen mit
Pfad-C-Fallback (nicht fuer "Status nur direkt").

Pro Chat bleiben maximal 100 `MESSAGE_DELETE`-Operationen erhalten. Eine
geloeschte Nachricht bleibt lokal als Platzhalter sichtbar und wird nicht
durch eine spaeter eintreffende alte Put-Operation wiederhergestellt.

### 6.0 Matching, Chat-Berechtigungen, Profil-Sichtbarkeit

Match-Operationen sind normale Chat-Operationen (P2P, Pfad C, Chat-Sync):

| Operation | Bedeutung |
|---|---|
| `MATCH_PING { actorId, createdAt }` (`flame:<uuid>`) | Flamme; max. eine pro Peer und 24 h (Client) |
| `MATCH_RESET { actorId, createdAt }` (`unmatch:<uuid>`) | Match loesen |

Ein **Match** besteht, wenn beide Seiten nach dem letzten `MATCH_RESET` eine
Flamme gesendet haben. Beide Clients berechnen das aus ihrem Operations-Log;
der Server erfaehrt nichts. Flammen loesen keinen Web Push aus.

**Freunde (R6, `client/app/friends.js`)**: Im Chat- und Freunde-Modus ersetzt
"Adden" die Flamme; gleiche Mechanik, eigene Beziehung:

| Operation | Bedeutung |
|---|---|
| `FRIEND_PING { actorId, createdAt }` (`friend:<uuid>`) | Anfrage senden bzw. eine erhaltene annehmen |
| `FRIEND_RESET { actorId, createdAt }` (`unfriend:<uuid>`) | ablehnen, zurueckziehen oder Freundschaft beenden |

Befreundet = beide haben nach dem letzten `FRIEND_RESET` ein `FRIEND_PING`
gesendet. Freunde zaehlen wie Matches (`isConnectedPeer`): keine
Chat-Einschraenkungen, volles Profil (`audience` = Freund), Galerie. Match
und Freundschaft sind unabhaengig; ein Grid-Match macht niemanden zum Freund.
Im Freunde-Modus zeigt das Grid nur Freunde (Filter im Client, der Server
kennt keine Freundschaften).

Aus Grid/Event: Chats in `discovery` lassen sich erst nach einem Match adden
(Knopf unter der Match-Info). Die Einstellung `myProfile.allowMatchFriends`
(Standard an) steht im signierten Profil, wird aber nicht als Feld angezeigt:
ist sie aus, bekommt der Match keinen "Adden"-Knopf (`canAddMatch` prueft
beide Seiten). Zusaetzlich ignoriert der Empfaenger `FRIEND_PING` aus
`discovery`-Chats ohne Match oder bei abgeschalteter Einstellung (gespeichert,
aber weder gemeldet noch annehmbar). Eine angenommene Freundschaft verschiebt
den Chat nach `social`.

Signiertes Profil: neben `fields`, `avatar`, `gallery` und `audience` sind
jetzt auch `chatPolicy` und `allowMatchFriends` signiert und kommen beim
anderen an (vorher fehlten die Chat-Regeln beim Empfaenger, Absender sahen
immer die Standardregeln).

**Getrennte Chatlisten**: Jeder Chat gehoert zu `discovery` (Grid & Event)
oder `social` (Chat & Freunde), gespeichert in `keys`/`chat-scopes`
(`{ scopes: { <peerId>: scope } }`). Festgelegt beim ersten
Nachrichtenaustausch: eigene erste Nachricht = aktueller Modus, eingehende
erste Nachricht = `message.scope` des Absenders (Feld im verschluesselten
`MESSAGE_PUT`). Freunde sind immer `social`. Chats ohne Zuordnung (aeltere
Versionen) erscheinen in beiden Listen.

**Ungelesen-Badges** (`client/app/unread.js`): Lesestand je Chat in
`keys`/`chat-reads` (`{ reads: { <peerId>: ms, '*': ms } }`), nur lokal, geht
weder an den Server noch an den Partner (keine Lesebestaetigung). Ungelesen =
Nachricht des Partners mit `createdAt` nach dem Lesestand, nicht geloescht,
nicht zurueckgehalten, Chat nicht blockiert. `'*'` ist der Stand beim ersten
Start mit Badges (bis dahin gilt alles als gelesen). Gelesen wird, wenn der
Chat sichtbar offen ist (`isChatVisibleFor`); der Lesestand ist dann
`max(jetzt, neuestes createdAt)`, damit Nachrichten mit vorgehender Uhr des
Absenders nicht spaeter erneut zaehlen. Anzeige: Zahl am Chat in Liste,
Kontaktleiste und Schnellwechsel, Summe am Chat-Tab, im Seitentitel und am
App-Symbol (Badging API), Punkt am Listen-Wechsel bei Ungelesenem in der
anderen Liste. Der Service Worker setzt bei einer Push-Benachrichtigung nur
einen Punkt am App-Symbol.

**Chat-Berechtigungen** (`myProfile.chatPolicy = { mode, limit, allowImages }`,
im signierten Profil):

| Modus | Ohne Match |
|---|---|
| `A` | alles erlaubt |
| `B` | max. `limit` (1/3/5/10) Nachrichten des anderen; `allowImages: false` sperrt Snaps, Alben, Secure Snaps |
| `C` | keine Nachrichten |

Durchsetzung beim Empfaenger in `applyChatOperation`: eine `MESSAGE_PUT`
ueber den Regeln wird mit `held: true` gespeichert und nicht angezeigt. Beim
Match werden alle `held`-Nachrichten freigegeben. Ein Chat gilt auch als
angenommen, wenn man dem anderen selbst schon geschrieben hat. Der Client des
Absenders liest die Regeln aus dem Profil und zeigt "Noch N Nachrichten bis
zum Match" bzw. sperrt die Eingabe (nur Anzeige).

Der Service Worker kennt die Regeln nicht. Die Seite spiegelt deshalb
`keys`/`chat-gate = { mode, acceptedPeerIds }`. Bei Modus B/C und nicht
angenommenem Absender speichert der SW die Nachricht mit
`held: true, policyPending: true` und zeigt nur die kompakte Benachrichtigung;
die Seite prueft solche Nachrichten beim Laden des Chats.

**Profil-Sichtbarkeit** (`myProfile.visibility`, `myProfile.privateFields`):
Der Besitzer baut die `PROFILE_RESPONSE` pro Betrachter
(`buildProfilePayloadFor`):

| Stufe | Ohne Match | Router |
|---|---|---|
| 1 | alles | Name + Vorschaubild |
| 2 | Profilbild + nicht markierte Felder, keine Galerie (`restricted: true`) | Name + Vorschaubild |
| 3 | nur ID, Stufe, Chat-Regeln (`restricted: true`) | kein Name, kein Bild (Silhouette "Jemand in der Naehe") |

Mit Match bekommt der Betrachter das volle Profil mit `audience: <seine ID>`.
Solche Profile werden nie per Swarm weitergegeben und nur vom adressierten
Peer angenommen; oeffentliche Profile tragen `audience: 'public'`. Ein Wechsel
von `audience` ersetzt den Cache auch ohne neue Version. `IMAGE_REQUEST` fuer
Galeriebilder wird bei Stufe 2/3 ohne Match abgelehnt.

### 6.1 Secure Snaps

Opt-in pro Sender (`keys`/`snap-settings`: `secureSnaps`, Standard-`views` 1,
Standard-`seconds` 10; pro Snap in der Vorschau aenderbar: Ansichten 1/2/3,
Dauer 5/10/30 s oder `0` = bis zum Schliessen, max. 5 Minuten).

- Der Snap wird mit einem frischen AES-GCM-Schluessel verschluesselt
  (`message.secureSnap = { snapId, views, seconds, encrypted }`, kein
  `snapData`) und laeuft wie jede Nachricht ueber P2P oder Pfad C. Der
  Schluessel bleibt beim Sender (`media`/`ssnap_<snapId>`, mit `viewsLeft`).
- Ansehen nur mit Sender online: Der Empfaenger sendet `SNAP_VIEW_REQUEST`
  ausschliesslich ueber einen offenen Kanal (wartet max. 10 s auf den Aufbau).
  Der Sender zaehlt die Ansicht herunter und versucht zuerst einen
  Live-Stream: `SNAP_STREAM_START { snapId, streamId, seconds, viewsLeft }`,
  dazu ein Video-Track aus `canvas.captureStream()` per Renegotiation auf der
  bestehenden Verbindung. Der Empfaenger antwortet mit `SNAP_STREAM_PLAYING`.
- Kommt binnen 6 s kein `SNAP_STREAM_PLAYING`, sendet der Sender
  `SNAP_VIEW_GRANT { snapId, key, seconds, viewsLeft }`. Der Empfaenger
  entschluesselt nur im Arbeitsspeicher (Blob-URL, Puffer wird ueberschrieben).
- Nach Ablauf der Dauer: `SNAP_STREAM_END` bzw. `SNAP_VIEW_CLOSED`, Track und
  Blob-URL werden verworfen. Wird die App verlassen, schliesst der Viewer sofort.
- Nach der letzten Ansicht loeschen Sender (Schluessel, Ciphertext) und
  Empfaenger (Ciphertext) ihre Daten; weitere Anfragen beantwortet der Sender
  mit `SNAP_VIEW_DENIED`.
- Grenzen: Screenshots und Bildschirmaufnahmen lassen sich im Browser nicht
  verhindern; ein manipulierter Client kann Frames oder den Schluessel
  behalten. Abschreckung ist das Wasserzeichen.

### 6.2 Wasserzeichen

Snaps (bei der Aufnahme) und Albumbilder (pro Betrachter beim Ausliefern)
tragen unsichtbar ein 32-Bit-Tag = erste 32 Bit von
`SHA-256("og-watermark:" + empfaengerId)`. Verfahren: QIM auf der mittleren
Helligkeit von 16x16-Bloecken (Stufe 8, max. +-4 Helligkeitsstufen), Bit
`i mod 32` pro Block, Auslesen per Mehrheitsentscheid; ab 28/32 passenden Bits
gilt ein bekannter Peer als Treffer. Uebersteht JPEG bis Qualitaet 40 und
1:1-Screenshots, nicht aber Skalieren oder Zuschneiden. Pruefen: Debug-Karte
"Wasserzeichen pruefen" in den Einstellungen.

Einstellung "Spur-Wasserzeichen" (`keys`/`privacy-settings.traceWatermark`,
Standard an): aus = eigene neue Snaps und ausgelieferte Albumbilder werden
nicht markiert. Das signierte Album-Manifest traegt `watermark`; weitergebende
Betrachter (Schwarm) folgen der Einstellung des Besitzers.

### 6.3 Anzeige per Canvas

Albumbilder (Kacheln, Deckfotos), Snaps, Secure Snaps, Chat-Bilder und der
Bildbetrachter zeichnen in `<canvas>` (`client/app/secure-canvas.js`:
`createImageBitmap` aus den Bytes, kein Data- oder Blob-URL im DOM,
Kontextmenue gesperrt). Die Quelle fuer den Betrachter liegt nur in einer
`WeakMap`. Beim Schliessen werden die Canvas geleert. Speichern (Download als
JPEG aus dem Canvas) gibt es nur fuer Chat-Bilder im Chat- und Freunde-Modus
(`isSocialMode`), nie fuer Alben oder Secure Snaps. Mit derselben Freigabe
erscheint daneben "Teilen", wenn der Browser Dateien teilen kann
(`canShareFiles`: `navigator.canShare({ files })`): `shareCanvasImage` gibt
das JPEG an `navigator.share`; Abbrechen ist kein Fehler. Profil-Galerien bleiben
`<img>`. Kein Schutz gegen Screenshots; Pixel-Verwuerfeln wurde bewusst nicht
gebaut (entschieden 2026-10-24).

## 7. Message Queue Cache API

Die Queue dient ausschliesslich als Store-and-Forward-Speicher fuer bereits
clientseitig verschluesselte Payloads.

| Methode | Route | Funktion |
|---|---|---|
| `POST` | `/api/cache` | Ciphertext mit einer TTL von 1 bis 72 Stunden ablegen |
| `GET` | `/api/cache/:recipientId` | Gueltige Nachrichten eines Empfaengers lesen |
| `DELETE` | `/api/cache/:msgId` | Verarbeitete Nachricht entfernen |

Alle Queue-Routen verlangen das Capability-Token des Absenders beziehungsweise
Empfaengers als Bearer-Token. Quoten: hoechstens 500 Nachrichten oder 20 MB
Ciphertext pro Empfaenger und 200 Nachrichten pro Absender und Empfaenger;
darueber antwortet `POST /api/cache` mit 429 `Recipient queue is full`.

Der Cloud-Cache ist eine reine Sender-Einstellung (`grid-settings.cacheEnabled`).
Ist er aus, stellt der Client eigene Operationen nicht in Pfad C ein; sie
bleiben lokal und gehen per P2P oder Chat-Sync raus. Eingehende
Pfad-C-Nachrichten anderer Peers werden weiterhin abgerufen und angewendet.

SQLite speichert Message-ID, Empfaenger, optionalen Absender, Ciphertext, IV
und Ablaufzeit. Klartext wird von dieser API weder erwartet noch verarbeitet.

Der Client verwendet Pfad C nur fuer `CHAT_OPERATION`-Payloads, wenn der
direkte P2P-/Signaling-Aufbau fehlschlaegt. Dazu wird mit dem persistenten,
nicht exportierbaren ECDH-Identitaetsschluessel des Senders und dem zuvor per
P2P bekannten Public Key des Empfaengers ein separater AES-GCM-Schluessel
abgeleitet. Ohne bekannten Peer-Key bleibt die Operation lokal in der
Retry-Queue.

Nach erfolgreicher WebSocket-Registrierung liest der Empfaenger seine Queue.
Er akzeptiert nur Absender-Public-Keys, die seinem lokal bekannten P2P-Key
entsprechen. Erst nach erfolgreicher Entschluesselung und idempotenter
Anwendung wird der Queue-Eintrag per `DELETE` entfernt.

## 8. Persistente Chat-Kontrollen

SQLite speichert pro Besitzer/Peer-Paar in `chat_controls`:

- den letzten Loesch-Cutoff `deleted_before`
- den Zeitpunkt einer aktiven Blockierung `blocked_at`
- den letzten Aenderungszeitpunkt

| Methode | Route | Funktion |
|---|---|---|
| `GET` | `/api/chat-controls/:ownerId` | Regeln eines Clients lesen |
| `POST` | `/api/chat-controls` | Chat loeschen oder Peer blockieren |
| `DELETE` | `/api/chat-controls/:ownerId/:peerId/block` | Blockierung entfernen |

Beim Loeschen oder Blockieren entfernt der Router wartende Queue-Payloads in
beide Richtungen. Eine Blockierung verhindert weitere Queue-Zustellungen vom
blockierten Absender. Der Client liest die Tabelle beim Start, nach
WebSocket-Reconnect und bei erneuter Aktivierung. Operationen vor dem
Loesch-Cutoff sowie alle Payloads blockierter Peers werden verworfen.

Lokale Chatkontakte werden unabhaengig vom Discovery-Grid aus `messages` und
`chatOperations` rekonstruiert. Dadurch kann ein Verlauf auch geoeffnet
werden, wenn beide Clients zuvor offline waren und der andere Peer noch nicht
wieder im Router registriert ist.

## 9. Web Push und Service Worker

Der Server liefert `client/sw.js` unter `/sw.js` mit Scope `/` aus.

| Methode | Route | Funktion |
|---|---|---|
| `GET` | `/api/push/vapid-public-key` | Oeffentlichen VAPID-Schluessel lesen |
| `POST` | `/api/push/subscribe` | Push-Subscription eines Peers speichern (authentifiziert) |
| `DELETE` | `/api/push/subscribe/:peerId` | Push-Subscription entfernen (authentifiziert) |

SQLite speichert pro Peer genau eine Subscription in `push_subscriptions`.
Endpunkte muessen https sein und zu einem bekannten Push-Dienst gehoeren
(`fcm.googleapis.com`, `android.googleapis.com`, `*.push.services.mozilla.com`,
`web.push.apple.com`, `*.push.apple.com`, `*.notify.windows.com`, erweiterbar per
`PUSH_HOST_ALLOWLIST`); IP-Adressen und Zugangsdaten in der URL sind verboten.
So kann kein Client den Server gegen interne Hosts schicken (SSRF). Vor jedem
Push wird das erneut geprueft.
Generierte VAPID-Schluessel liegen in `server_settings`.

Ablauf:

1. `POST /api/cache` mit `notify: true` (nur `MESSAGE_PUT`) loest nach dem
   Speichern einen Web Push an den Empfaenger aus. Der Sender wartet nicht
   darauf.
2. Payload: `{ type: 'PATH_C', msgId, senderId, ciphertextPayload, ivHex }`.
   Ueber 3800 Byte entfallen `ciphertextPayload` und `ivHex`.
3. Der Push wird nach RFC 8291 (`aes128gcm`) verschluesselt und mit einem
   VAPID-JWT (ES256, RFC 8292) signiert.
4. Antwortet der Push-Dienst mit 404 oder 410, wird die Subscription geloescht.

Der Service Worker:

- leitet den Push an ein sichtbares App-Fenster weiter (`PATH_C_AVAILABLE`),
  das die Queue selbst abruft
- sonst: liest Identitaetsschluessel, `router-auth` und den vertrauten
  Peer-Key aus IndexedDB, holt den Ciphertext bei Bedarf aus der Queue,
  prueft den Absender-Key und entschluesselt
- uebernimmt nur gueltige `MESSAGE_PUT`-Operationen idempotent in
  `messages` und `chatOperations` (`deliveredVia: 'E2EE Push'`)
- loescht danach den Queue-Eintrag und zeigt eine Benachrichtigung
- zeigt bei Fehlern eine allgemeine Benachrichtigung; die Nachricht bleibt in
  der Queue
- zeigt im Kompaktmodus (`compactNotifications`, Standard: an) immer nur eine Meldung
  "Neue Nachrichten" ohne Name und Text, mit festem Tag `opengrid-messages`,
  sodass auch mehrere Nachrichten nur eine Meldung ergeben
- nutzt fuer Netzwerkzugriffe ein Timeout von 5 Sekunden
- ruft `skipWaiting()` nie automatisch auf, nur nach `ACTIVATE_UPDATE` von der
  Seite (Nutzer tippt im Update-Hinweis auf "Aktualisieren")

### 9.1 Offline (App-Shell)

Der Server setzt beim Ausliefern von `/sw.js` die Asset-Version und die
Precache-Liste ein (`__ASSET_VERSION__`, `__PRECACHE_URLS__`): `/`, alle
`clientAssetFiles` mit `?v=<Version>`, Font-Awesome-CSS und die woff2-Schriften.

- `install`: alle URLs in den Cache `opengrid-shell-<Version>` laden; jede
  Antwort muss `ok` und same-origin sein, sonst wird der Cache verworfen und
  die Installation scheitert (der bisherige Worker bleibt aktiv).
- `activate`: alte `opengrid-shell-*`-Caches loeschen, `clients.claim()`.
- `fetch`: Seitenaufrufe (`/grid`, `/chat/<id>`, ...) zuerst ueber das Netz
  (3 s Timeout), offline die gecachte App-Shell; `/client/*` und `/vendor/*`
  zuerst aus dem Cache; `/api/*`, `/ws` und fremde URLs ungecacht.
- Wartet ein neuer Worker, zeigt die Seite "Eine neue Version ist bereit"
  mit Knopf; nach `controllerchange` laedt sie neu.
- Ohne Verbindung (Browser offline oder WebSocket laenger als 4 s getrennt)
  zeigt die Seite einen Offline-Hinweis; Chats, Profile und Medien kommen
  aus IndexedDB.

Externe Abhaengigkeiten zur Laufzeit gibt es keine mehr: Tailwind wird mit
`npm run build:css` (Tailwind-CLI 3, `tailwind.config.cjs`) nach
`client/tailwind.css` kompiliert (Docker-Build, `prestart`, `pretest`); Font
Awesome kommt aus `node_modules/@fortawesome/fontawesome-free` unter
`/vendor/fontawesome/*`; Platzhalterbilder und App-Icons (`client/icon.svg`, PNG 180/192/512 fuer Manifest und `apple-touch-icon`)
sind lokal.

Ein Klick auf die Benachrichtigung fokussiert die App und oeffnet den Chat
(`OPEN_CHAT`) oder startet sie mit `/?chat=<peerId>`.

## 9.2 Server-Haertung

- Aufbewahrung: `peer_credentials.last_active_at` wird bei jeder Registrierung
  gesetzt. Stuendlich loescht der Server Peers, die laenger als
  `CREDENTIAL_RETENTION_DAYS` (Standard 180, mindestens 7) inaktiv sind:
  Zugangsdaten, Push-Abo, eigene Chat-Kontrollen, wartende Nachrichten und den
  Grid-Eintrag.

- Rate-Limits pro IP (Fenster 1 Minute): Registrierung 30, Grid 90, Chat-Kontrollen 30,
  Push-Abo 10; Pfad C 120 pro Absender; WebSocket 300 Nachrichten pro 10 Sekunden
  pro Verbindung (danach `SIGNALING_ERROR` und verworfen). Ueberschreitung: 429
  mit `Retry-After`.
- Sicherheits-Header auf allen Antworten: `Content-Security-Policy`
  (`default-src 'self'`, Bilder auch `data:`/`blob:`, `connect-src` nur eigener
  Host inkl. WebSocket und Nominatim, `frame-ancestors 'none'`,
  `script-src 'self'` ohne `'unsafe-inline'`), `X-Content-Type-Options`,
  `Referrer-Policy: no-referrer`, `Permissions-Policy` (Kamera, Mikrofon und
  Standort nur same-origin), `Cross-Origin-Opener-Policy`, `X-Frame-Options`. Keine
  CORS-Header: die App laeuft same-origin.
- Sprachen (`client/i18n.js`, `server/i18n.js`): Texte unter Schluesseln
  `bereich.name` in `i18n/<sprache>.properties` (UTF-8, Untermenge des
  Java-Formats: `#` Kommentar, `=`/`:` trennt, `\` setzt fort, `\ ` am Anfang
  erhaelt ein Leerzeichen, `\uXXXX`). Der Server kompiliert sie beim Start zu
  `/client/i18n/<sprache>.js` (`I18N_MESSAGES[sprache] = {...}`, im
  Service-Worker-Precache). `i18n.js` waehlt die Sprache (eigene Wahl in
  `localStorage` `opengrid-language`, sonst Router-Standard
  `CLIENT_DEFAULTS.language`, sonst Geraet) und laedt per `document.write`
  synchron nur dieses Woerterbuch (gleiche Herkunft, CSP-konform), weil
  App-Skripte `t()` schon beim Laden nutzen. `t(key, params)`; fehlt ein
  Schluessel, erscheint er selbst. Markup: `data-i18n="schluessel"` (Text) und
  `data-i18n-attr="attr:schluessel;..."`, einmal bei `DOMContentLoaded`
  gefuellt (das deutsche Markup ist nur Rueckfall). Uhrzeiten immer 24 h
  (`formatClockTime`). Profil-Schema: `label`/`default` als Text (bleibt
  unveraendert) oder `{ de, en }` (`localizedText`). Deutsche Texte mit echten
  Umlauten. Service Worker: der Server setzt beim Ausliefern von `/sw.js` nur
  die Schluessel `sw.*` aller Sprachen ein (`__SW_TEXTS__`); `swText(key,
  params)` waehlt nach der Browsersprache (`navigator.languages`, sonst
  Deutsch), weil der SW die Spracheinstellung in `localStorage` nicht lesen
  kann.
- Info-Seite (`server/info-site.js`, `client/info/site.js`, `info-site/`):
  Seiten `info-site/pages/<sprache>/<seite>.md` (feste Liste `INFO_PAGES`,
  dazu `news` = `CHANGELOG.md`), Begriffe `info-site/i18n/<sprache>.properties`
  als `INFO_TERMS` (`/info-site/i18n/<sprache>.js`). Aufloesung im Browser:
  `${schluessel}` rekursiv (max. 8 Ebenen, Schleifen werden zu
  `[[schluessel]]`), im Modus "Einfach erklaert" (Standard, `localStorage`
  `opengrid-info-mode`) zuerst `schluessel.plain`, `${ui:schluessel}` aus dem
  App-Woerterbuch. Links: `page:seite`, `app:` (APP_URL). Ohne `INFO_HOST`
  unter `/info`; mit `INFO_HOST` liefert ein `onRequest`-Hook auf diesem Host
  jede Seitenadresse als Info-Seite (App-Routen gelten dort nicht).
  `/api/config` liefert `infoUrl` fuer die Links in Menue und Onboarding.
- Navigation: unten Grid, Chat, Profil. Die Einstellungen haben keinen eigenen
  Knopf: Zahnrad im Profil-Kopf, Eintrag im Menue, oder vom Profil nach links
  wischen (`TAB_ORDER` grid, chat, editprofile, keys); dabei bleibt "Profil"
  markiert. Das Menue (rechts) schaltet den App-Modus direkt um (Event ohne
  Code fuehrt zur Code-Eingabe) und enthaelt Einstellungen, Changelog,
  Debug-Modus, Abmelden und die Version.
- Einstellungen (`#view-keys`): Bereiche als Tabs (`data-settings-tab` an den
  Karten, `switchSettingsTab` in `settings.js`, letzter Tab in `localStorage`
  `opengrid-settings-tab`; "Debug" nur im Debug-Modus). Zeilen `.setting-row`
  mit Titel, kurzer Beschreibung und rechts einem Schalter (`input.switch`,
  weiter ein echtes Kontrollkaestchen) oder einer Auswahl (`.setting-select`).
- Keine Inline-Handler im Markup: Elemente tragen `data-click`,
  `data-change`, `data-input` oder `data-enter` (Enter-Taste) mit dem Namen
  einer globalen Funktion, Argumente als JSON in `data-args` (Platzhalter
  `$value`, `$checked`, `$number`, `$el`, `$src`, `$event`).
  `client/app/actions.js` verteilt die Ereignisse; `test/markup-actions.test.js`
  prueft, dass es keine `on*`-Attribute gibt und jede Aktion existiert.
- Logs: nur Methode, Pfad ohne Query-String und Statuscode, keine IP-Adressen.
- Capability-Token-Hashes werden konstant-zeitig verglichen.
- `trustProxy` standardmaessig nur fuer Loopback und private Netze (`TRUST_PROXY`).

## 10. Betriebsgrenzen

- Ein Container entspricht einer Signaling-Instanz. Fuer horizontale
  Skalierung waere ein gemeinsamer Pub/Sub-Backplane erforderlich.
- SQLite liegt in einem persistenten Docker-Volume.
- Der Reverse Proxy muss WebSocket-Upgrades fuer `/ws` erlauben.
- Vollstaendige Profile, Klartext-Chats und private Schluessel verbleiben auf
  dem Client.

## 10. Migrationskonvention

Aenderungen an SQLite, IndexedDB, persistenten Schluesseln, Tokens,
Protokoll-Payloads oder Deployment-Konfigurationen muessen zusammen mit einer
ausfuehrbaren Migrationsanweisung ausgeliefert werden. Ein Code-Update ohne
passende Migrationsanweisung gilt bei solchen Aenderungen als unvollstaendig.

Jede Migration erhaelt eine eindeutige, fortlaufende ID im Format
`MIG-YYYYMMDD-NNN`. Sie dokumentiert mindestens:

- Zielversion oder `BUILD_TIMESTAMP`, ab der die Migration erforderlich ist
- betroffene Server-, Browser- und Deployment-Daten
- Voraussetzungen und konkrete Upgrade-Schritte
- automatische Migrationen im Code und verbleibende manuelle Schritte
- Verifikation des erfolgreichen Upgrades
- Rueckfall- oder Wiederherstellungsverfahren

Migrationen muessen idempotent sein oder vor der Ausfuehrung ihren bereits
erreichten Stand pruefen. Server und Client duerfen waehrend eines gestaffelten
Rollouts nicht stillschweigend inkompatibel werden. Fuer eine Uebergangsphase
ist entweder Rueckwaertskompatibilitaet bereitzustellen oder der notwendige
Cache-, Token- beziehungsweise Datenbank-Reset deutlich auszuweisen.
