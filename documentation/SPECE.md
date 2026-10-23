# Technische Spezifikation

## 1. Komponentenstruktur

- `server/app.js` implementiert die HTTP- und REST-Routen.
- `server/database.js` kapselt eine lokale SQLite-Datenbank.
- `server/signaling.js` verwaltet aktive WebSocket-Verbindungen und leitet
  WebRTC-Signaling-Nachrichten weiter.
- `client/grid.client.js` kapselt Discovery, Heartbeats und den
  Signaling-Client.
- `client/p2p.client.js` kapselt WebRTC, DataChannels und das verschluesselte
  P2P-Protokoll.
- `client/crypto.client.js` stellt gemeinsame Kodierungsfunktionen fuer
  Web-Crypto-Payloads bereit.
- `index.html` enthaelt nur noch das HTML-Markup der App-Shell.
- `client/app/*.js` enthaelt die UI-Logik als klassische Skripte (globaler
  Scope, Reihenfolge wie in `index.html`): `config.js` (Konfiguration,
  `state`), `storage.js` (IndexedDB, Chat-Operationen), `profile.js`
  (Profil, Medien, Onboarding), `chat.js` (Modal, Chat, Snaps),
  `settings.js` (Debug, Schluessel, Toasts, Tabs, Sichtbarkeit),
  `router.js` (Client-Routen, History), `viewer.js` (Bildbetrachter),
  `albums.js` (Alben, Medienuebersicht), `push.js` (Web Push), `main.js`
  (Start). `client/geohash.client.js` kodiert den eigenen Standort.
- `client/styles.css` und `client/app/tailwind.config.js` enthalten Styles
  und die Tailwind-Konfiguration.
- Der Server liefert nur Dateien aus der festen Liste `clientAssetFiles` in
  `server/app.js` aus; neue Client-Dateien muessen dort eingetragen werden.
- Debug-Modus: `CONFIG.DEBUG_MODE` kommt aus `localStorage`
  (`opengrid-debug-mode` = `on`/`off`, Standard aus). Ist er an, traegt
  `<html>` die Klasse `debug-on`. Elemente mit der Klasse `debug-only` sind
  sonst per CSS ausgeblendet. Technische Toasts laufen ueber
  `showDebugToast()` und erscheinen nur im Debug-Modus.
- Navigation: `switchTab()` steuert die Ansichten und markiert alle Knoepfe mit
  passendem `data-tab-btn` (Header-Navigation auf dem Desktop,
  Bottom-Navigation auf Smartphones).
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

Alle Peers einer Zelle haben denselben Mittelpunkt. Mehrfache Abfragen von
verschiedenen Orten liefern deshalb hoechstens die Zelle, keine genauere
Position (Schutz gegen Trilateration).

## 4. WebRTC-Signaling und Presence

Der WebSocket-Endpunkt `/ws` vermittelt:

- SDP Offer und Answer
- ICE Candidates
- Offline-Fallback-Meldungen
- `PEER_OFFLINE`-Hinweise

Schliesst die aktive WebSocket-Verbindung eines Peers, sendet der Server
`{ type: 'PEER_OFFLINE', peerId }` an alle verbundenen Peers in derselben
Geohash-Zelle. Diese markieren den Peer sofort als offline, brechen eine
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

Nach Aufbau des DataChannels tauschen beide Clients oeffentliche ECDH-P-256-
Schluessel aus und leiten einen AES-256-GCM-Session-Key ab. Beim Oeffnen eines
Profils prueft ein verschluesseltes `PRESENCE_PING`/`PRESENCE_PONG` die
Erreichbarkeit.

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

IndexedDB Version 8 enthaelt:

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

Der Store `keys` enthaelt zusaetzlich den Datensatz `router-auth` mit
`nodeId` und Router-Token. Er spiegelt `localStorage` fuer den Service
Worker, der keinen Zugriff auf `localStorage` hat. Der Datensatz
`push-settings` speichert `compactNotifications` fuer den Service Worker.
Der Datensatz `grid-settings` speichert `silent`, `ttlMinutes`, `liveGrid`,
`cacheEnabled` (Standard an), `useLocation`, `locationLabel` und `safeZones`
(Liste von Geohash-Zellen). Ein fehlender Datensatz entspricht den Standardwerten.
Safe Zones verlassen nie das Geraet: Liegt die eigene Zelle in einer Safe
Zone, registriert sich der Client als `silent`.

### 5.1 Alben

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

Rotierende Schluessel (seit P5): Jedes eigene Album hat ein Geheimnis `secret`
(32 Byte, nur beim Besitzer) und eine `keyVersion`. Pro Betrachter und Bild gilt

```
key = HKDF-SHA256(ikm = secret, salt = "<albumId>:<keyVersion>", info = "<imageId>:<viewerId>")
```

Albumbilder gehen nur als Ciphertext unter diesem Schluessel raus
(`IMAGE_RESPONSE { imageId, version, keyVersion, encrypted: { iv, ciphertext } }`);
der Betrachter speichert nur den Ciphertext. Die Schluessel holt er pro
Epoche:

| Nachricht | Richtung | Bedeutung |
|---|---|---|
| `ALBUM_KEY_REQUEST { albumId, epoch }` | Betrachter -> Besitzer | Schluessel fuer die laufende Epoche anfragen |
| `ALBUM_KEY_RESPONSE { albumId, keyVersion, epoch, epochEndsAt, keys }` | Besitzer -> Betrachter | Rohschluessel pro Bild, nur fuer Peers in der `acl` |

Die Epoche kommt aus der Serverzeit (`GET /api/time`, Laenge per
`MEDIA_KEY_EPOCH_MINUTES`). Der Betrachter importiert die Schluessel als nicht
exportierbare `CryptoKey`s, haelt sie nur im Arbeitsspeicher und verwirft sie
bei `epochEndsAt`; ist das Album offen, fragt er sofort neu an. Entzieht der
Besitzer einem Peer den Zugriff, steigt `keyVersion`: alle Schluessel aendern
sich, andere Betrachter laden die Bilder neu. Der Besitzer bettet vor dem
Verschluesseln ein Wasserzeichen mit der ID des Betrachters ein (Abschnitt 6.2).

`IMAGE_REQUEST` liefert nur noch Galeriebilder des eigenen Profils oder Bilder
aus Alben, in deren `acl` der anfragende Peer steht. `IMAGE_RESPONSE` wird nur
fuer angefragte Bilder aus dem gecachten Profil oder einem empfangenen Album
desselben Besitzers angenommen. Ein Entzug wirkt fuer neue Anfragen sofort;
bereits empfangene Kopien loescht der Client des Betrachters nach
`ALBUM_REVOKED`/`ALBUM_DENIED` (ohne Garantie gegen manipulierte Clients).

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
- Snaps (`message.snapData`) werden auf max. 1080 px verkleinert und so lange
  komprimiert, bis die Data-URL hoechstens 70 000 Zeichen hat. So passen sie
  auch in Pfad C (Queue-Limit 100 KB Ciphertext).
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

Pro Chat bleiben maximal 100 `MESSAGE_DELETE`-Operationen erhalten. Eine
geloeschte Nachricht bleibt lokal als Platzhalter sichtbar und wird nicht
durch eine spaeter eintreffende alte Put-Operation wiederhergestellt.

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

## 7. Message Queue Cache API

Die Queue dient ausschliesslich als Store-and-Forward-Speicher fuer bereits
clientseitig verschluesselte Payloads.

| Methode | Route | Funktion |
|---|---|---|
| `POST` | `/api/cache` | Ciphertext mit einer TTL von 1 bis 72 Stunden ablegen |
| `GET` | `/api/cache/:recipientId` | Gueltige Nachrichten eines Empfaengers lesen |
| `DELETE` | `/api/cache/:msgId` | Verarbeitete Nachricht entfernen |

Alle Queue-Routen verlangen das Capability-Token des Absenders beziehungsweise
Empfaengers als Bearer-Token.

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
- ruft `skipWaiting()` nie automatisch auf

Ein Klick auf die Benachrichtigung fokussiert die App und oeffnet den Chat
(`OPEN_CHAT`) oder startet sie mit `/?chat=<peerId>`.

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
