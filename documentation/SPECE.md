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
- `index.html` enthaelt App-Shell, UI und lokale IndexedDB-Funktionen.

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
- Geohash
- Anzeigename
- Thumbnail
- Ablaufzeit

Der Client erneuert die Registrierung alle 25 Sekunden. Ohne Heartbeat laeuft
sie nach zehn Minuten ab. Eine alte Registration-ID darf eine neuere
Registrierung desselben Peers nicht entfernen.

Die erste Registrierung stellt ein zufaelliges Peer-Capability-Token aus.
Der Browser bewahrt es lokal auf; der Server speichert nur dessen SHA-256-
Hash getrennt vom kurzlebigen Presence-Eintrag. Queue-, Chat-Control- und
WebSocket-Zugriffe muessen dieses Token vorlegen. Signaling-Nachrichten
erhalten serverseitig die authentifizierte Absender-ID.

Das Grid entspricht immer der aktuellen Router-Antwort fuer einen Geohash.
Lokale Cache-Eintraege werden nicht ohne aktiven Router-Eintrag angezeigt.
Explizit entfernte Peers erhalten einen zeitlich begrenzten Tombstone.

## 4. WebRTC-Signaling und Presence

Der WebSocket-Endpunkt `/ws` vermittelt:

- SDP Offer und Answer
- ICE Candidates
- Offline-Fallback-Meldungen

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
| Online | Passender Pong innerhalb von 8 Sekunden |
| Abwesend | Router-Eintrag vorhanden, aber kein Pong |
| Offline | Eigene Netzwerk- oder Signaling-Verbindung fehlt |

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

IndexedDB Version 7 enthaelt:

| Store | Inhalt |
|---|---|
| `keys` | nicht exportierbarer AES-GCM-Schluessel fuer Profil-Caches |
| `localProfile` | genau ein verschluesseltes eigenes Profil |
| `profiles` | ausschliesslich verschluesselte Profile anderer Peers |
| `messages` | lokaler Chatverlauf pro Peer |
| `chatOperations` | idempotente Put-/Delete-Operationen pro Chat |
| `gridPeers` | minimale lokale Routing-Metadaten |

Nur eine hoehere Profilversion ersetzt einen vorhandenen Cache.
Das eigene Profil wird nie durch Grid-Tombstones oder Peer-Cache-Bereinigung
geloescht. Beim Upgrade von Version 3 wird ein vorhandenes eigenes Profil
einmalig aus `profiles` nach `localProfile` verschoben.

Fehlt `localProfile`, blockiert ein modaler Erststartdialog die
Router-Registrierung. Er rendert alle Felder aus `PROFILE_SCHEMA`, validiert
Pflichtfelder und wird erst nach erfolgreicher AES-GCM-Speicherung geschlossen.

## 6. Chat-Deltasynchronisation

Chats werden als idempotente Operationen synchronisiert:

- `MESSAGE_PUT` enthaelt eine neue Nachricht.
- `MESSAGE_DELETE` ist ein Tombstone fuer eine zuvor gesendete Nachricht.
- Operationen besitzen global eindeutige IDs und koennen mehrfach empfangen
  werden, ohne doppelte Nachrichten zu erzeugen.

Nach jedem neuen E2EE-Schluessel und vor einem weiteren Nachrichtenversand
tauschen beide Clients die 20 neuesten Operations-IDs aus. Fehlende
Operationen werden angefordert. Aeltere IDs werden anschliessend in
Inventarseiten zu je 50 IDs im Hintergrund verglichen.

Pro Chat bleiben maximal 100 `MESSAGE_DELETE`-Operationen erhalten. Eine
geloeschte Nachricht bleibt lokal als Platzhalter sichtbar und wird nicht
durch eine spaeter eintreffende alte Put-Operation wiederhergestellt.

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

## 9. Betriebsgrenzen

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
