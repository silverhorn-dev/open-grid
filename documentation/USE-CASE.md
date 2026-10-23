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
  sie beim Hovern. Auf Touch-Geraeten sitzt ein kleiner Pfeil in der oberen
  Ecke der Nachricht (eigene rechts, fremde links); der Text macht ihm Platz.
  Er ist das aeussere Element der Leiste und klappt sie auf und wieder zu. Die Leiste ist bei eigenen Nachrichten rechtsbuendig, bei fremden
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
- Ein Umschalter filtert nach "Beide", "Eigene" oder "Andere".
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

## UC-26: Flamme senden und Match

**Als Nutzer** moechte ich mit wenig Aufwand Interesse zeigen und erkennen,
wenn es auf Gegenseitigkeit beruht.

Akzeptanzkriterien:

- Im Profil eines Peers gibt es "Flamme senden". Die Flamme ist eine kleine
  verschluesselte Chat-Operation (`MATCH_PING`) und kommt auch offline an
  (P2P oder Pfad C). Der Server erfaehrt nichts davon.
- Eine Flamme pro Peer und 24 Stunden.
- Empfangene Flammen erscheinen in der Chatliste unter "Interesse" mit
  Knopf "Zurueck-flammen".
- Haben beide sich gegenseitig eine Flamme geschickt, ist es ein **Match**
  (beide Clients berechnen das lokal aus ihren Operationen).
- Ein Match laesst sich aufheben ("Match loesen"); danach gelten wieder die
  Regeln fuer Nicht-Matches.

## UC-27: Chat-Berechtigungen

**Als Nutzer** moechte ich festlegen, wer mir ohne Match schreiben darf.

Akzeptanzkriterien:

- Einstellung mit drei Stufen, jederzeit wechselbar:
  - **A Alles:** jeder kann schreiben (wie bisher).
  - **B Eingeschraenkt:** ohne Match hoechstens N Nachrichten vom anderen
    (N waehlbar: 1, 3, 5 oder 10; Standard 5); ein Schalter erlaubt oder
    sperrt Bilder (Snaps, Alben, Secure Snaps) in diesen Nachrichten.
  - **C Nur Matches:** ohne Match kann niemand schreiben.
- Die Stufe steht im signierten Profil. Der Client des Absenders zeigt sie an
  ("Noch 3 Nachrichten bis zum Match", Eingabe gesperrt bei C oder Limit).
- Durchgesetzt wird beim Empfaenger: Nachrichten ueber dem Limit oder bei C
  werden nicht angezeigt und nicht gespeichert (manipulierte Sender bringen
  nichts durch).
- Mit dem Match fallen alle Grenzen weg. Hat man dem anderen selbst schon
  geschrieben, gilt der Chat ebenfalls als angenommen.
- Zurueckgehaltene Nachrichten erscheinen, sobald es ein Match gibt.
- Bestehende Chats von vor der Einstellung bleiben erhalten.

## UC-28: Profil-Sichtbarkeit

**Als Nutzer** moechte ich bestimmen, wie viel Fremde von meinem Profil sehen.

Akzeptanzkriterien:

- Einstellung mit drei Stufen:
  - **1 Alles:** Profil, Felder und Galerie fuer alle (wie bisher).
  - **2 Teilsichtbar:** Profilbild und alle Felder, die nicht als "nur fuer
    Matches" markiert sind, fuer alle; markierte Felder und die Galerie erst
    nach einem Match. Beim Oeffnen bietet die App "Flamme senden, um mehr zu
    sehen" an (optional).
  - **3 Unsichtbar:** im Grid nur eine Silhouette ohne Namen ("Jemand in der
    Naehe"); Profilbild, Name, Felder und Galerie erst nach einem Match. Das
    Profil zeigt nur "Flamme senden".
- Durchgesetzt wird beim Besitzer: sein Client liefert ueber P2P nur, was
  die Stufe fuer diesen Peer erlaubt. Bei Stufe 3 bekommt der Router weder
  Namen noch Vorschaubild.
- Ein vollstaendiges Profil, das ein Match bekommen hat, ist nur fuer diesen
  Empfaenger signiert und wird von anderen Clients nicht weitergegeben
  (Swarm-Profile nur fuer oeffentliche Stufe).
- Matches sehen immer alles.

## UC-29: App offline nutzen

**Als Nutzer** moechte ich die installierte App auch ohne Netz oeffnen und
meine Chats lesen.

Akzeptanzkriterien:

- Nach dem ersten Aufruf startet die App auch im Flugmodus vollstaendig
  (Layout, Icons, alle Seiten wie `/chat/<id>`).
- Ohne Verbindung erscheint ein Hinweis; lokale Chats, Profile und Medien
  bleiben nutzbar. Nachrichten gehen raus, sobald wieder Verbindung besteht.
- Eine neue Version wird nie mitten in der Sitzung aktiviert. Die App zeigt
  "Eine neue Version ist bereit" mit Knopf "Aktualisieren".
- Zur Laufzeit werden keine externen CDNs oder Bilddienste geladen.

## UC-30: Gesten auf dem Smartphone

**Als Nutzer** moechte ich die App mit gewohnten Gesten bedienen.

Akzeptanzkriterien:

- Eine Nachricht zur Seite wischen startet eine Antwort (fremde nach rechts,
  eigene nach links); ein Antwort-Symbol zeigt den Fortschritt.
- Lange druecken oeffnet die Aktionsleiste, doppelt tippen reagiert mit ❤️.
- Text laesst sich ueber die Aktion "Kopieren" kopieren.
- Seitlich wischen wechselt zwischen Grid, Chat und Profil.
- Profil- und Medienfenster schliessen per Wischen nach unten.
- Im Chat am Ende nach oben ziehen aktualisiert den Chat.
- Senkrechtes Scrollen, die Zurueck-Geste des Systems und alle Knoepfe
  funktionieren weiter wie bisher.
