# Use Cases und Akzeptanzkriterien

## UC-01: Discovery im Geohash

**Als Nutzer** moechte ich andere registrierte Clients in meinem Geohash
sehen, ohne vollstaendige Profile an einen zentralen Dienst zu senden.

Akzeptanzkriterien:

- Der Router speichert nur Name und Thumbnail.
- Das Grid zeigt nur die aktuelle Router-Antwort.
- Ein nur lokal gecachtes Profil erscheint ohne Router-Eintrag nicht im Grid.
- Eine explizite Abmeldung entfernt das Profil aus dem Grid.

## UC-02: Profil per P2P laden

**Als Nutzer** moechte ich beim Oeffnen eines Profils dessen aktuelle Daten
direkt vom anderen Client beziehen.

Akzeptanzkriterien:

- Der Profilklick startet bei Bedarf eine WebRTC-Verbindung.
- ECDH P-256 leitet einen AES-256-GCM-Session-Key ab.
- `PROFILE_REQUEST` und `PROFILE_RESPONSE` sind verschluesselt.
- Der Router sieht den Profilinhalt nicht.

## UC-03: Presence validieren

**Als Nutzer** moechte ich im offenen Profil erkennen, ob der andere Client
wirklich erreichbar ist.

Akzeptanzkriterien:

- Der Status wird vom aufrufenden Client berechnet.
- Ein verschluesselter Ping/Pong bestaetigt **Online**.
- Ohne Antwort wird der Peer als **Abwesend** angezeigt.
- Ohne eigene Netzwerk- oder Signaling-Verbindung erscheint **Offline**.
- Ohne Pong innerhalb von 4 Sekunden erscheint **Abwesend**.
- Trennt ein Peer seine Signaling-Verbindung, sehen Peers in derselben
  Geohash-Zelle ihn sofort als **Offline**.
- Im Discovery-Grid wird kein unvalidiertes Online-Badge angezeigt.

## UC-04: Verschluesselter Profil-Cache

**Als Nutzer** moechte ich bereits geladene Profile nach einem Neustart lokal
verwenden koennen, ohne sie unverschluesselt abzulegen.

Akzeptanzkriterien:

- Profilinhalte werden vor IndexedDB mit AES-256-GCM verschluesselt.
- Der lokale AES-Schluessel ist nicht exportierbar.
- Jede Profilantwort besitzt `version` und `updatedAt`.
- Nur neuere Versionen ersetzen einen vorhandenen Cache.
- Gecachte Profile werden nur zusammen mit einem aktuellen Router-Eintrag im
  Grid verwendet.

## UC-05: Stabile Client-ID

**Als Nutzer** moechte ich nach Reload oder Browser-Neustart nicht als neues
Profil erscheinen.

Akzeptanzkriterien:

- Die Browser-Installation besitzt eine persistente `nodeId`.
- Mehrere Tabs verwenden dieselbe `nodeId`.
- Die ID bleibt bis zum manuellen Loeschen der Websitedaten erhalten.
- Laufzeitregistrierungen besitzen eine separate `registrationId`.

## UC-06: Persistenter P2P-Chat

**Als Nutzer** moechte ich meinen Chatverlauf nach einem Neustart auf beiden
beteiligten Clients wiedersehen.

Akzeptanzkriterien:

- Nachrichten werden Ende-zu-Ende-verschluesselt ueber WebRTC gesendet.
- Sender und Empfaenger speichern ihre jeweilige Kopie lokal in IndexedDB.
- Der Router und das WebSocket-Signaling speichern keine Chatinhalte.

## UC-07: Self-hosted Betrieb

**Als Betreiber** moechte ich OpenGrid ohne Cloudflare-Abhaengigkeiten auf
einem eigenen Host ausfuehren.

Akzeptanzkriterien:

- Ein Docker-Container liefert PWA, REST-API und WebSocket-Signaling aus.
- SQLite persistiert Routing-Metadaten und verschluesselte Queue-Payloads in
  einem Docker-Volume.
- Der Container benoetigt weder Wrangler noch Cloudflare KV, Durable Objects
  oder Worker Metadata.
- TLS kann von einem vorgeschalteten Reverse Proxy terminiert werden.
- Ein Health-Endpunkt erlaubt Container- und Proxy-Ueberwachung.

## UC-08: Erstmalige Profileinrichtung

**Als neuer Nutzer** moechte ich vor der ersten Grid-Registrierung mein
lokales Profil einrichten.

Akzeptanzkriterien:

- Ohne Datensatz im IndexedDB-Store `localProfile` erscheint ein modaler
  Einrichtungsdialog.
- Der Dialog zeigt alle Felder des konfigurierten Profilschemas.
- Pflichtfelder muessen ausgefuellt sein.
- Der Dialog kann erst nach erfolgreicher verschluesselter Speicherung
  geschlossen werden.
- Grid-Registrierung und Signaling starten erst nach Abschluss des Dialogs.

## UC-09: Chat nach Offline-Phasen synchronisieren

**Als Nutzer** moechte ich nach einer Offline-Phase nur fehlende
Chat-Aenderungen austauschen.

Akzeptanzkriterien:

- Nach Aufbau des sicheren Kanals werden die letzten 20 Operations-IDs
  verglichen.
- Aeltere Operationen werden in Hintergrundseiten abgeglichen.
- Nur fehlende Put- oder Delete-Operationen werden uebertragen.
- Das Loeschen einer eigenen Nachricht erscheint beim anderen Client ebenfalls
  als geloeschte Nachricht.
- Pro Chat werden hoechstens 100 Delete-Tombstones aufbewahrt.

## UC-10: Verschluesselter Store-and-Forward-Pfad

**Als Nutzer** moechte ich Chat-Aenderungen fuer einen voruebergehend
unerreichbaren bekannten Peer hinterlegen.

Akzeptanzkriterien:

- Nur Chat-Operationen werden in Pfad C eingestellt.
- Der Server erhaelt ausschliesslich AES-GCM-Ciphertext, IV und Routing-IDs.
- Queue-Verschluesselung verwendet persistente lokale ECDH-Schluessel und
  einen zuvor direkt verifizierten Peer-Public-Key.
- Nach Reconnect werden gueltige Operationen angewendet und danach aus der
  Server-Queue geloescht.
- Ohne bekannten Peer-Key bleibt die Operation lokal fuer einen spaeteren
  direkten Verbindungsversuch.
- Steht der direkte Kanal nach 10 Sekunden nicht, wird automatisch Pfad C
  genutzt. Keine Nachricht bleibt dauerhaft auf "Establishing secure
  channel..." stehen.
- Der Empfaenger sieht als Zustellpfad `Encrypted Path C`, nicht `E2EE P2P`.

## UC-11: Offline-Chat wiederfinden

**Als Nutzer** moechte ich einen lokal gespeicherten Chat auch dann wieder
oeffnen koennen, wenn der andere Client noch offline ist.

Akzeptanzkriterien:

- Die Chatliste wird aus lokalen Nachrichten und Operationen rekonstruiert.
- Ein Chatkontakt benoetigt keinen aktuellen Router-Eintrag.
- Offline-Chats erscheinen nicht faelschlich im Discovery-Grid.
- Sobald der Peer wieder erreichbar ist, startet die normale Delta-
  Synchronisation.

## UC-12: Chat loeschen und Peer blockieren

**Als Nutzer** moechte ich einen Chat dauerhaft zuruecksetzen oder einen Peer
blockieren, ohne dass wartende oder alte Operationen den Zustand aufheben.

Akzeptanzkriterien:

- Der Router persistiert Chat-Loesch-Cutoffs und Blockierungen.
- Chat-Loeschung und Blockierung entfernen wartende Queue-Nachrichten in beide
  Richtungen.
- Operationen vor dem Loesch-Cutoff werden lokal nicht erneut angewendet.
- Blockierte Absender koennen keine neuen Queue-Nachrichten hinterlegen.
- Jeder Client aktualisiert seine Regeln beim Start, Reconnect und Fokus.
- Eine Blockierung kann explizit wieder aufgehoben werden.

## UC-13: Push-Benachrichtigung bei geschlossener App

**Als Nutzer** moechte ich neue Nachrichten auch bei geschlossener App
erhalten, ohne dass der Server Klartext sieht.

Akzeptanzkriterien:

- Push-Benachrichtigungen werden erst nach ausdruecklicher Zustimmung
  aktiviert und koennen wieder deaktiviert werden.
- Nur neue Nachrichten (`MESSAGE_PUT`) loesen einen Push aus.
- Der Push enthaelt nur den Pfad-C-Ciphertext des Senders oder einen Hinweis
  mit Message-ID.
- Der Service Worker speichert die Nachricht lokal und entfernt sie danach aus
  der Server-Queue.
- Blockierte Absender loesen keinen Push aus.
- Ist die App sichtbar geoeffnet, verarbeitet sie die Nachricht selbst.
- Ein Klick auf die Benachrichtigung oeffnet den passenden Chat.
- Standardmaessig erscheint nur eine einzige Meldung "Neue Nachrichten" ohne
  Name und Text, auch bei mehreren Nachrichten. Vorschauen mit Name und Text
  lassen sich optional einschalten.

## UC-14: Mobile Bedienung und Debug-Modus

**Als Nutzer** moechte ich die App auf dem Smartphone wie eine native App
bedienen und keine technischen Angaben sehen, solange ich sie nicht brauche.

Akzeptanzkriterien:

- Auf Smartphones (< 768 px) liegt eine feste Navigation unten mit Grid, Chat
  und Profil. Auf dem Desktop liegen dieselben drei Punkte oben im Header.
- Technisches (Einstellungen, Debug-Schalter, Cloud Cache, Abmelden) liegt im
  Menue oben rechts.
- Auf Smartphones zeigt der Chat-Tab zuerst die Chatliste. Ein geoeffneter
  Chat fuellt den ganzen Bildschirm und hat einen Zurueck-Knopf.
- Der Debug-Modus ist standardmaessig aus und wird pro Browser gemerkt.
- Ohne Debug-Modus sind technische Angaben ausgeblendet: Node-IDs,
  Zustellpfade unter Nachrichten, Verbindungsstatus, Geohash, Version,
  Protokoll, Schema-Editor und Schluessel.
- Ohne Debug-Modus erscheinen keine technischen Warnungen als Toast. Hinweise,
  auf die der Nutzer reagieren muss, bleiben sichtbar.
- Ohne Debug-Modus zeigt der Chat-Kopf statt des Verbindungsstatus nur ein
  Symbol: gruener Punkt = verbunden, Augen = das Gegenueber hat den Chat
  gerade geoeffnet.
