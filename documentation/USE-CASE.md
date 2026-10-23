# Use Cases und Akzeptanzkriterien

## UC-01: Discovery im Geohash

**Als Nutzer** moechte ich andere registrierte Clients in meinem Geohash
sehen, ohne vollstaendige Profile an einen zentralen Dienst zu senden.

Akzeptanzkriterien:

- Der Router speichert nur Name, Thumbnail und eine Geohash-Zelle (ca. 1 km).
- Das Grid zeigt nur die aktuelle Router-Antwort.
- Zuerst erscheint nur die eigene Zelle. "Mehr laden" erweitert das Grid
  ringweise bis ueber 500 km; der Knopf erscheint nur, wenn weitere Peers
  existieren.
- Peers sind nach Entfernung gruppiert (Sehr nah, In der Naehe, In der Stadt,
  20-100 km, 100-300 km, 300-500 km, > 500 km). Genaue Entfernungen oder
  Standorte anderer Peers sind nie sichtbar.
- Der Geraetestandort wird nur nach Zustimmung gelesen und verlaesst das
  Geraet nur als Zelle.
- Ohne Geraetestandort kann eine Adresse angegeben werden. Sie geht nur auf
  Klick an einen externen Geocoder (OpenStreetMap Nominatim), der Router sieht
  weiterhin nur die Zelle.
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
- Chat-Partner sehen sich gegenseitig online/offline, unabhaengig von Zelle,
  Grid und Silent-Modus (gruener Punkt in Chatliste und Chat-Kopf). Wer nicht
  gegenseitig im Chat steht oder blockiert ist, sieht nichts. Ein "zuletzt
  online" wird nicht gespeichert.
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

## UC-15: Silent-Modus und Safe Zones

**Als Nutzer** moechte ich fuer bestehende Chats erreichbar bleiben, ohne im
Grid aufzutauchen.

Akzeptanzkriterien:

- Im Silent-Modus erscheint das eigene Profil bei niemandem im Grid; Clients,
  die es schon zeigen, entfernen es beim naechsten Refresh.
- Chats, Signaling und Pfad C funktionieren im Silent-Modus weiter.
- Safe Zones (z. B. Zuhause) werden nur lokal gespeichert. Ist die aktuelle
  Zelle eine Safe Zone, ist der Client automatisch im Silent-Modus.
- Das Grid zeigt einen Hinweis, solange man unsichtbar ist.

## UC-16: Sichtbarkeitsdauer und Live-Grid

**Als Nutzer** moechte ich festlegen, wie lange ich nach dem Schliessen noch
sichtbar bin, und nur Peers sehen, die gerade online sind.

Akzeptanzkriterien:

- Die Sichtbarkeit nach dem letzten Heartbeat ist waehlbar (1, 10, 30 oder
  60 Minuten); der Router begrenzt sie auf 1 bis 60 Minuten.
- Im Live-Grid erscheinen nur Peers mit aktiver Signaling-Verbindung.

## UC-17: Cloud-Cache abschalten

**Als Nutzer** moechte ich, dass meine eigenen Nachrichten nie auf dem Server
zwischengespeichert werden.

Akzeptanzkriterien:

- Der Cloud-Cache ist standardmaessig an.
- Ist er aus, sendet der Client nichts mehr ueber Pfad C.
- Eingehende Pfad-C-Nachrichten anderer Peers kommen weiterhin an.
- Nachrichten gehen dann ausschliesslich per P2P oder Chat-Sync; keine
  Nachricht geht verloren, sie bleibt bis zur naechsten Verbindung lokal.

## UC-18: Echte Seiten und Zurueck-Navigation

**Als Nutzer** moechte ich nach einem Refresh dort bleiben, wo ich war, und
auf dem Smartphone mit der Zurueck-Geste innerhalb der App navigieren.

Akzeptanzkriterien:

- Jeder Tab und jeder offene Chat hat eine eigene Adresse (`/grid`, `/chat`,
  `/chat/<id>`, `/profile`, `/settings`).
- Ein Refresh oeffnet denselben Tab beziehungsweise denselben Chat.
- "Zurueck" schliesst zuerst ein offenes Menue oder Modal, dann fuehrt es
  vom Chat zur Chatliste und zwischen den Tabs zurueck.
- Push-Benachrichtigungen oeffnen direkt `/chat/<id>`.

## UC-19: Antworten, Reagieren, Markieren, Suchen

**Als Nutzer** moechte ich die ueblichen Chat-Funktionen haben.

Akzeptanzkriterien:

- Auf jede Nachricht (auch eigene) kann geantwortet werden; die Antwort
  zeigt ein Zitat, ein Klick darauf springt zur Originalnachricht.
- Reaktionen mit einem von sechs Emojis; dieselbe Reaktion erneut entfernt
  sie. Reaktionen werden synchronisiert.
- Nachrichten lassen sich lokal markieren; die Suche kann auf markierte
  Nachrichten beschraenkt werden.
- Die Aktionen (Antworten, Reagieren, Markieren, Loeschen) sitzen als Leiste
  mit gut treffbaren Knoepfen halb ueber der Nachricht. Am Desktop erscheinen
  sie beim Hovern, auf Touch-Geraeten ueber einen Pfeil an der Aussenseite der
  Nachricht. Die Leiste ist bei eigenen Nachrichten rechtsbuendig, bei fremden
  linksbuendig, und ragt nie aus dem Bildschirm.
- Die Schriftgroesse der Nachrichten ist in den Einstellungen waehlbar.
- Die Suche filtert den aktuellen Chat lokal nach Text.

## UC-20: Snaps aufnehmen

**Als Nutzer** moechte ich wie in einer Kamera-App schnell ein Foto im Chat
verschicken.

Akzeptanzkriterien:

- Die Snap-Kamera oeffnet im Vollbild mit grossem Ausloeser, Kamerawechsel
  (vorne/hinten) und Schliessen-Knopf.
- Ohne Kamera oder ohne Erlaubnis kann ein Bild aus der Galerie gewaehlt
  werden.
- Nach der Aufnahme gibt es eine Vorschau mit optionaler Bildunterschrift,
  "Nochmal" und "Senden".
- Die Kamera wird beim Schliessen immer freigegeben.
- Ein normaler Snap laesst sich einmal ansehen und einmal wiederholen; danach
  ist er weg. Mit "Speichern" bleibt er dauerhaft im Chat. Secure Snaps
  lassen sich nicht speichern.
- Snaps passen immer in Pfad C. Laeuft die Queue-TTL ab, bevor der
  Empfaender sie abholt, sieht der Sender einen Hinweis; die Nachricht geht
  beim naechsten direkten Sync raus.

## UC-21: Medienuebersicht im Chat

**Als Nutzer** moechte ich alle Bilder eines Chats auf einen Blick sehen.

Akzeptanzkriterien:

- Ein Knopf im Chat-Kopf zeigt alle Snaps und geteilten Alben des Chats.
- Ein Klick oeffnet das Bild gross beziehungsweise das Album.

## UC-22: Private Alben teilen und entziehen

**Als Nutzer** moechte ich mehrere private Alben anlegen und gezielt
einzelnen Chat-Partnern zeigen.

Akzeptanzkriterien:

- Alben werden im Profil angelegt, befuellt und geloescht; sie sind nicht
  Teil des oeffentlichen Profils.
- Ein Album wird im Chat geteilt und erscheint dort mit Deckfoto; ein Klick
  oeffnet es.
- Nur freigegebene Peers erhalten Albuminhalt und Bilder, immer per P2P. Der
  Besitzer muss dafuer online sein.
- Der Zugriff kann pro Peer entzogen werden. Danach werden neue Anfragen
  abgelehnt und der Client des Peers loescht seine Kopie.
- Betrachter speichern Albumbilder nur verschluesselt. Die Schluessel gelten
  nur fuer eine Epoche (Server-Einstellung, z. B. 3 Stunden) und muessen dann
  beim Besitzer neu geholt werden.

## UC-23: Bilder ansehen

**Als Nutzer** moechte ich Bilder gross und bequem ansehen.

Akzeptanzkriterien:

- Snaps, Albumbilder, Bilder der Medienuebersicht und Profilbilder oeffnen in
  einem Vollbild-Betrachter.
- Wischen (oder Pfeiltasten/-knoepfe am Desktop) blaettert fluessig zwischen
  den Bildern derselben Quelle; das naechste Bild ist beim Wischen schon
  sichtbar. Ein Zaehler zeigt die Position.
- Pinch, Doppeltipp oder Mausrad zoomen bis 5-fach; ein gezoomtes Bild laesst
  sich verschieben.
- Nach unten wischen, "Zurueck" oder Escape schliessen den Betrachter.

## UC-24: Secure Snaps

**Als Nutzer** moechte ich, dass ein Snap nur begrenzt angesehen werden kann.

Akzeptanzkriterien:

- Secure Snaps sind eine Einstellung des Senders (Standard aus). Ansichten
  (1x, 2x, 3x) und Dauer (5 s, 10 s, 30 s, bis zum Schliessen) sind in den
  Einstellungen vorbelegt und pro Snap aenderbar.
- Ein Secure Snap kommt auch offline an, laesst sich aber nur ansehen, wenn
  der Sender online ist. Sonst erscheint ein Hinweis.
- Wenn moeglich wird der Snap live gestreamt; sonst wird er nur im
  Arbeitsspeicher entschluesselt.
- Der Empfaenger sieht "noch Nx" und einen Countdown; danach "Abgelaufen".
  Der Sender sieht, wie oft der Snap angesehen wurde.
- Der Empfaenger-Client akzeptiert normale und sichere Snaps gleichermassen.

## UC-25: Leaker erkennen

**Als Nutzer** moechte ich herausfinden, wer ein Bild weitergegeben hat.

Akzeptanzkriterien:

- Snaps und Albumbilder tragen ein unsichtbares Wasserzeichen mit der ID des
  Empfaengers.
- Im Debug-Modus laesst sich ein Bild oder 1:1-Screenshot pruefen; ein
  Treffer nennt den Peer.
