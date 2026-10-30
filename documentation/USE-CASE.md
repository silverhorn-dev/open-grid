# Use Cases und Akzeptanzkriterien

## UC-01: Discovery im Geohash

**Als Nutzer** moechte ich andere registrierte Clients in meinem Geohash
sehen, ohne vollstaendige Profile an einen zentralen Dienst zu senden.

Akzeptanzkriterien:

- Der Router speichert nur Name, Thumbnail und eine Geohash-Zelle (ca. 1 km).
- Das Grid zeigt nur die aktuelle Router-Antwort.
- Zuerst erscheint nur die eigene Zelle. "Mehr laden" erweitert das Grid
  ringweise bis ueber 500 km; der Knopf erscheint nur, wenn weitere Peers
  existieren. Ist wenig los (weniger als 6 Peers), laedt das Grid bis zu drei
  Ringe automatisch nach.
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
  sie. Reaktionen werden synchronisiert und sitzen gut lesbar auf der unteren
  Kante der Nachricht.
- Die Kontaktleiste zeigt links Avatar mit Online-Punkt, Name und Status
  ("online", "offline", "hat den Chat offen"); rechts nur Suche und ein Menue
  mit Medien, Profil, Chat loeschen und Blockieren.
- Die Chatliste zeigt pro Chat die letzte Nachricht mit Uhrzeit, neueste oben.
- Ist das eigene Geraet offline, zeigt ein dezentes Icon in der Kopfzeile und
  im Chat-Kopf das an (kein Banner); Chats bleiben lokal lesbar.
- Das Nachrichtenfeld waechst mit bis zu fuenf Zeilen und scrollt danach; am
  Desktop sendet Enter (Shift+Enter = neue Zeile), auf dem Smartphone ist
  Enter eine neue Zeile und der Senden-Knopf sendet.
- Beim Oeffnen eines Chats und beim Senden steht der Verlauf unten. Wer weit
  nach oben gescrollt hat, behaelt beim Senden und bei neuen Nachrichten seine
  Position und bekommt einen Knopf "nach unten".
- Im offenen Chat laesst sich direkt zum naechsten Chat derselben Liste
  wechseln: per Avatar-Leiste, Pfeilen oder Wischen auf der Kontaktleiste
  (einstellbar unter "Darstellung", auch ganz abschaltbar). "Zurueck" fuehrt
  danach zur Chatliste, nicht durch alle besuchten Chats.
- Am Desktop ist der Chat eine Box in Fensterhoehe: nur die Nachrichten
  scrollen, die Kontaktleiste bleibt oben stehen.
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
- Nach der Aufnahme gibt es einen Editor: mit dem Finger zeichnen (Farben),
  Text und Emojis auf das Bild legen und verschieben, doppelt tippen entfernt
  eine Ebene, "Rueckgaengig". Dazu optionale Bildunterschrift, "Nochmal" und
  "Senden". Verschickt wird ein einziges JPEG.
- Seitlich wischen (oder der Knopf "Als Bild senden" am rechten Rand) schaltet
  zwischen Snap und Bild um; ein Bild bleibt dauerhaft im Chat.
- Beim Bild laesst sich "Original" einschalten: der Empfaenger bekommt sofort
  eine Vorschau und das Original in voller Qualitaet, sobald eine direkte
  Verbindung besteht. Originale gehen nie ueber den Server.
- Speichert der Empfaenger einen Einmal-Snap, sieht der Absender das.
- Eine Ansicht zaehlt schon beim Oeffnen des Snaps.
- Der Absender stellt ein, wie lange ein Einmal-Snap nach dem ersten Ansehen
  noch wiederholt werden kann (15, 30, 60 min oder unbegrenzt; Standard 30 min).
  Danach ist er bei beiden weg. Der Empfaenger sieht keine Restzeit.
- In der Galerie lassen sich mehrere Bilder auswaehlen; vor dem Senden sehe ich
  alle durch (blaettern, einzelne entfernen, pro Bild Snap/Bild/Secure
  waehlen, einzelne im Editor bearbeiten) und schicke sie mit "Alle senden";
  jedes wird ein eigener Snap (bzw. Bild oder Foto-Status).
- Mehrere ungesehene Snaps lassen sich hintereinander ansehen: weiter per
  Doppeltippen, seitlich oder nach oben wischen (einstellbar).
- Gesten in der Kamera: nach unten wischen schliesst, am Ausloeser nach oben
  wischen oeffnet die Galerie, doppelt tippen wechselt die Kamera, zwei Finger
  zoomen (wenn die Kamera Zoom kann). Hat die Kamera eine Lampe, gibt es einen
  Licht-Knopf.
- Die Kamera wird beim Schliessen immer freigegeben.
- Im geoeffneten Snap schliesst nach unten wischen den Snap (die Seite laedt
  dabei nicht neu).
- Ein normaler Snap laesst sich einmal ansehen und einmal wiederholen; danach
  ist er weg, auch beim Sender. Mit "Speichern" bleibt er dauerhaft im Chat;
  das koennen Empfaenger und Sender jeweils fuer sich. Secure Snaps
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
- Nur freigegebene Peers erhalten Albuminhalt und Bilder, immer per P2P. Ist
  der Besitzer offline, koennen andere Betrachter, die das Album schon haben,
  Liste und Bilder weitergeben; das Wasserzeichen zeigt dann auf den
  Empfaenger. Ansehen geht nur mit gueltigen Schluesseln vom Besitzer.
- Oeffentliche Profilbilder kommen ebenfalls von anderen Grid-Teilnehmern,
  wenn der Besitzer nicht antwortet; der Client prueft jedes Bild gegen den
  Hash im signierten Profil.
- Der Zugriff kann pro Peer entzogen werden. Danach werden neue Anfragen
  abgelehnt und der Client des Peers loescht seine Kopie.
- Betrachter speichern Albumbilder nur verschluesselt. Zum Ansehen braucht es
  drei Teile: den eigenen Schluessel, den des Besitzers und einen rollenden
  Schluessel, den der Besitzer pro Epoche verteilt - direkt oder ueber den
  verschluesselten Zwischenspeicher.
- Der Besitzer stellt pro Album ein, wie lange ein Schluessel gilt
  (Server-Standard, 15 min, 1 h, 3 h, 24 h) und wie viele Epochen er vorab
  ausliefert (1 bis 3). Neue Alben uebernehmen den Standard aus den
  Einstellungen.
- Der Besitzer verteilt die Schluessel fuer die laufende und die naechste
  Epoche; Betrachter sehen das Album also auch, wenn der Besitzer kurz offline
  ist. Nach einem Entzug ist spaetestens mit Ende der naechsten Epoche Schluss.

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
- Das Spur-Wasserzeichen laesst sich in den Einstellungen abschalten (Standard
  an).
- Albumbilder, Snaps und Chat-Bilder werden nur angezeigt (Canvas), nicht als
  Datei bereitgestellt. Chat-Bilder lassen sich im Chat- und Freunde-Modus im
  Bildbetrachter speichern, in Grid und Event nicht.

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
- Lange druecken (am Desktop Rechtsklick) oeffnet das Kontextmenue mit
  Reaktionen und Aktionen; es bleibt offen, auch wenn neue Nachrichten
  kommen. Doppelt tippen reagiert mit ❤️.
- Text laesst sich ueber die Aktion "Kopieren" kopieren.
- Seitlich wischen wechselt zwischen Grid, Chat und Profil.
- Profil- und Medienfenster schliessen per Wischen nach unten.
- Im Chat am Ende nach oben ziehen loest die eingestellte Aktion aus: Seite
  neu laden (Standard), naechster Chat, Auswahl aller Chats der Liste
  (Quick-Switcher), Snap aufnehmen oder Album teilen
  (Einstellungen, "Darstellung").
- Senkrechtes Scrollen, die Zurueck-Geste des Systems und alle Knoepfe
  funktionieren weiter wie bisher.

## UC-31: App-Modus waehlen

**Als Betreiber** moechte ich festlegen, wofuer meine Instanz da ist, und
**als Nutzer** moechte ich zwischen den erlaubten Modi waehlen.

Akzeptanzkriterien:

- Der Betreiber erlaubt Modi ueber `APP_MODES` und setzt `DEFAULT_APP_MODE`.
- Sind mehrere Modi erlaubt, fragt das Onboarding danach; in den
  Einstellungen laesst sich der Modus jederzeit wechseln.

## UC-32: Nur Chat

**Als Nutzer** moechte ich OpenGrid wie einen privaten Messenger nutzen.

Akzeptanzkriterien:

- Es gibt kein Grid; man ist fuer niemanden sichtbar.
- Das Profil ist schlank (Name und Status, vom Betreiber anpassbar);
  Dating-Angaben aus anderen Modi werden nicht mitgeschickt.
- Beim ersten Kontakt tauschen beide Seiten automatisch ihre Profile aus.
- Kontakte kommen ueber einen Einladungslink oder QR-Code (Kopieren,
  Teilen). Wer den Link oeffnet, landet direkt im Chat, und zwar im Modus und
  in der Liste, aus der eingeladen wurde (bei beiden).
- Ist dieser Bereich beim Oeffnenden ausgeschaltet, oeffnet sich nichts; ein
  Hinweis sagt, fuer welchen Modus die Einladung ist.
- Passt der Schluessel beim ersten Kontakt nicht zur Einladung, wird die
  Verbindung abgebrochen und eine Warnung angezeigt.

## UC-33: Freunde in der Naehe

**Als Nutzer** moechte ich nur meine Kontakte in der Naehe sehen.

Akzeptanzkriterien:

- Das Grid zeigt nur gegenseitige, nicht blockierte Kontakte, die gerade
  online sind, mit Entfernungsgruppe.
- Fremde sehen einen nicht, auch nicht im oeffentlichen Grid.

## UC-37: Freunde adden (Chat- und Freunde-Modus)

**Als Nutzer** moechte ich im Chat- und Freunde-Modus Leute adden statt
Flammen zu verschicken, und meine Freundes-Chats getrennt von Dating-Chats
sehen.

Akzeptanzkriterien:

- Im Profil gibt es "Adden"; der andere sieht "Moechte dich adden" mit
  "Annehmen" und "Ablehnen". Eine gesendete Anfrage laesst sich zurueckziehen,
  eine Freundschaft beenden.
- Freunde sehen das volle Profil (auch "nur fuer Matches"-Felder) und die
  Galerie; Schreiben geht auch ohne Freundschaft.
- In Grid und Event bleiben Flamme und Match. Nach einem Match kann man
  dort zusaetzlich adden; der Chat wandert dann nach "Chat & Freunde".
- Wer das nicht will, schaltet "Matches koennen mich adden" ab. Die
  Einstellung geht unsichtbar mit dem Profil mit: Matches sehen dann keinen
  "Adden"-Knopf.
- Die Chatliste zeigt im Grid-/Event-Modus nur "Grid & Event"-Chats und im
  Chat-/Freunde-Modus nur "Chat & Freunde"-Chats. Ein Chat gehoert in die
  Liste des Modus, in dem er begann; befreundete Chats wandern nach
  "Chat & Freunde".
- Im Freunde-Modus zeigt das Grid nur Freunde.
- Ein Knopf neben dem Titel der Chatliste wechselt zur anderen Liste;
  einstellbar, ob dabei der App-Modus wechselt oder nur die Liste angezeigt
  wird, und abschaltbar.
- Im Chat- und Freunde-Modus erscheint die Alben-Karte im Profil nur, wenn es
  eigene Alben gibt.
- In "Chat & Freunde"-Chats fehlt der Album-Knopf neben "Snap"; ein langer
  Druck auf "Snap" laesst ihn fuer diesen Chat erscheinen (Easteregg).

## UC-38: Status fuer Freunde

**Als Nutzer** moechte ich meinen Freunden fuer einen Tag zeigen, was los ist.

Akzeptanzkriterien:

- Im Chat- und Freunde-Modus zeigt eine Leiste ueber der Chatliste den eigenen
  Status ("+") und Freunde mit aktuellem Status (farbiger Ring = ungesehen).
- Ein Status ist ein Text mit Hintergrundfarbe oder ein Foto aus der
  Snap-Kamera (mit Editor); er ist 24 Stunden sichtbar und wird danach auf
  allen Geraeten geloescht. Eigene Status lassen sich vorher loeschen.
- Nur Freunde bekommen Status; Fremde und Grid-Kontakte sehen nichts.
- Ein dauerhafter Kurzstatus (z. B. "Im Club") erscheint bei Freunden neben
  dem Online-Status.
- "Status nur direkt" verteilt Status nur P2P; der Server sieht dann nicht,
  an wen man Status schickt.

## UC-34: Event-Modus

**Als Nutzer** moechte ich auf einem Event nur die anderen Teilnehmer sehen.

Akzeptanzkriterien:

- Mit einem Event-Code tritt man bei; das Grid zeigt alle mit demselben Code.
- Der Server kennt nur einen Hash des Codes.
- Nach 12 Stunden oder per "Event verlassen" endet die Teilnahme; danach
  gilt wieder der vorherige Modus.

## UC-35: Farben und Hell/Dunkel

**Als Nutzer** moechte ich die App farblich an meinen Geschmack anpassen.

Akzentfarbe und Thema gelten pro Geraet.

Akzeptanzkriterien:

- In den Einstellungen gibt es "System", "Hell" und "Dunkel"; "System" folgt
  der Einstellung des Geraets.
- Die Akzentfarbe wird in einem runden Farbrad gewaehlt (ziehen) oder aus
  Vorgaben; "Standard" stellt die urspruengliche Farbe wieder her.
- Thema und Akzentfarbe gelten sofort und auch nach einem Neustart, ohne
  Aufflackern.

## UC-36: Club-/LAN-Betrieb

**Als Veranstalter** moechte ich OpenGrid im lokalen WLAN eines Events ohne
Internet betreiben, **als Nutzer** moechte ich, dass dabei keine Daten an
fremde Server gehen.

Akzeptanzkriterien:

- Mit `LAN_MODE=true` verteilt der Server keine STUN/TURN-Server; Verbindungen
  laufen nur direkt im WLAN.
- Nutzer koennen "Nur lokales Netz" auch selbst einschalten.
- Ist ein Chat-Partner im selben Netz, zeigt die Kontaktleiste "im selben
  WLAN".
- Ohne eigene Konfiguration nutzt der Server seinen eigenen TURN-Server auch
  fuer STUN statt eines fremden Dienstes.
- Die Grenzen sind dokumentiert: HTTPS ist Pflicht, ein Mesh ohne Server ist
  in einer PWA nicht moeglich.

## UC-39: Ungelesene Nachrichten

**Als Nutzer** moechte ich sehen, in welchen Chats neue Nachrichten auf mich
warten und wie viele.

Akzeptanzkriterien:

- Jeder Chat in der Liste (auch in Kontaktleiste und Schnellwechsel) zeigt die
  Zahl ungelesener Nachrichten, ab 100 "99+".
- Der Chat-Tab, der Seitentitel und das App-Symbol zeigen die Summe.
- Hat die andere Liste ("Grid & Event" bzw. "Chat & Freunde") Ungelesenes,
  zeigt der Listen-Wechsel einen Punkt.
- Oeffnen des Chats setzt ihn auf gelesen; Nachrichten in den offenen Chat
  zaehlen nicht. Der Stand bleibt nach dem Neuladen erhalten.
- Der Lesestand bleibt auf dem Geraet; der Partner bekommt keine
  Lesebestaetigung.

## UC-40: Sprachnachrichten

**Als Nutzer** moechte ich statt zu tippen kurz etwas einsprechen koennen.

Akzeptanzkriterien:

- Ist das Eingabefeld leer, zeigt die Leiste ein Mikrofon statt "Senden".
- Aufnahme mit Zeitanzeige, verwerfen oder senden; bis 15 Minuten. Am Maximum
  stoppt die Aufnahme, gesendet wird nie automatisch.
- Die erste Minute kommt auch an, wenn der andere offline ist (Router-Cache, nur
  verschluesselt); laengere Aufnahmen zeigen ab einer Minute "Rest nur direkt".
- Der Rest kommt nur ueber eine direkte Verbindung. Der Empfaenger kann den
  Anfang sofort hoeren; fehlt der Rest beim Abspielen noch, wartet die
  Wiedergabe und laeuft weiter, sobald er da ist.
- Kann der Browser lokal verschriftlichen, steht der Text unter der Nachricht;
  sonst gibt es keinen Text (kein Cloud-Dienst).
- Sprachnachrichten zaehlen wie Bilder fuer die Chat-Berechtigungen.

## UC-41: Videos (nur direkt)

**Als Nutzer** moechte ich kurze Videos schicken, ohne dass sie ueber den Server
laufen.

Akzeptanzkriterien:

- Videos bis 25 MB (MP4, WebM, MOV, Ogg) lassen sich aus der Galerie senden.
- Der andere sieht sofort ein Vorschaubild mit Laenge; das Video selbst kommt
  nur ueber eine direkte Verbindung (P2P/TURN), mit Fortschritt.
- Das Video wird vor dem Speichern per SHA-256 geprueft.
- Abspielen im Vollbild wie der Bildbetrachter (nach unten wischen schliesst),
  ohne Download-Knopf.

## UC-42: Gesten im Chat

Akzeptanzkriterien:

- Wischen zum Antworten klappt bei jeder Nachricht beliebig oft, auch mit Start
  im Leerraum neben der Nachricht oder auf dem kleinen Aktionen-Pfeil (der dabei
  nicht aufklappt).
- Die Kontaktleiste nach unten ziehen oeffnet das Profil des Kontakts.

## UC-43: Sprache der App

**Als Nutzer** moechte ich die App in meiner Sprache benutzen.

Akzeptanzkriterien:

- Deutsch und Englisch; ohne eigene Wahl folgt die App der Sprache des Geraets
  (der Betreiber kann einen Standard vorgeben).
- Umstellen unter Einstellungen > Allgemein > Sprache; die App laedt neu und
  merkt sich die Wahl.
- Alle Texte der Oberflaeche, auch Profilfelder und Uhrzeiten (immer 24 h),
  folgen der Sprache; Chatnachrichten bleiben unveraendert.

## UC-44: Info-Seite fuer alle

**Als interessierte Person** moechte ich verstehen, was OpenGrid ist und wie es
mit meinen Daten umgeht, ohne Fachwissen.

Akzeptanzkriterien:

- Eigene Seite (Subdomain oder `/info`) mit Ueberblick, Erste Schritte,
  Funktionen, Privatsphaere, haeufigen Fragen, Selbst betreiben und Neuigkeiten.
- Deutsch und Englisch; Umschalter "Einfach erklaert" / "Mit Fachbegriffen",
  beide Varianten grammatikalisch stimmig.
- Knopfnamen der App erscheinen genau wie in der App.
- Erreichbar aus dem Menue ("Hilfe & Info") und beim Einrichten des Profils.

## UC-45: Bereich beim Onboarding waehlen

**Als neuer Nutzer** moechte ich festlegen, ob ich nur Leute entdecken, nur mit
Freunden schreiben oder beides will, damit die App nur zeigt, was ich brauche.

Akzeptanzkriterien:

- Beim ersten Start drei Karten: "Nur Entdecken", "Social", "Entdecken &
  Freunde"; erlaubt der Betreiber nur einen Bereich, entfaellt die Frage.
- Nur Entdecken: Grid und Event, Flamme und Match, nirgends ein
  "Adden"-Knopf, keine Status- und Freunde-Einstellungen, kein Listen-Wechsel.
- Social: Chat und Freunde-Grid, nur Adden, keine Flamme und keine
  Matching-Einstellungen.
- Entdecken & Freunde: alles wie bisher.
- Unter Einstellungen > Allgemein > Erweitert laesst sich der Bereich aendern;
  "Alle Modi anzeigen" schaltet alles wieder ein.
- Bestehende Nutzer behalten alle Modi.

## UC-46: Nachweis vor der Sichtbarkeit (Betreiber-Option)

**Als Betreiber** moechte ich verlangen koennen, dass Nutzer ihr Alter oder
eine E-Mail-Adresse nachweisen, bevor sie im Grid sichtbar sind.

Akzeptanzkriterien:

- Standardmaessig aus; einschaltbar per `AGE_CHECK` / `EMAIL_CHECK`.
- Ohne Nachweis: registriert, aber unsichtbar und ohne Grid; ein Fenster fuehrt
  durch den Nachweis, wegklicken geht, in den Einstellungen bleibt der Hinweis.
- Alter: "mindestens 18" bestaetigen oder Nachweis ueber einen Anbieter, der
  nur "ab 18: ja" liefert.
- E-Mail: 6-stelliger Code, 15 Minuten gueltig, 5 Versuche; die Adresse liegt
  nur verschluesselt beim Betreiber.
- Gesperrte Peers, Adressen und Anbieter-Pseudonyme kommen nicht wieder rein.
- Optionales IP-Protokoll fuer Anfragen der Strafverfolgung (0-14 Tage).

## UC-47: Nacktbilder unscharf (Empfaenger)

**Als Empfaenger** moechte ich ungefragte Nacktbilder nicht sofort sehen.

Akzeptanzkriterien:

- Einstellung unter Medien > Schutz, standardmaessig aus.
- Eingehende Bilder werden nur auf dem eigenen Geraet geprueft; moegliche
  Nacktbilder erscheinen unscharf mit "Tippen zum Ansehen".
- Der erste Tipp zeigt das Bild, oeffnet aber nichts anderes; danach bleibt es
  sichtbar, auch im Bildbetrachter.
- Eigene Bilder werden nie geprueft.
- Vor dem Senden eigener Bilder fragt die App nach, wenn das Modell ein
  Nacktbild sieht (abschaltbar, Standard an); geprueft wird nur auf dem Geraet.
- Kann ein Bild nicht geprueft werden (Modell laedt nicht, Zeitlimit), bleibt
  es unscharf mit "Konnte nicht geprueft werden" statt ungeprueft zu erscheinen.
- Das Erkennungsmodell kommt vom eigenen Router und wird erst geladen, wenn der
  Filter an ist; der Betreiber legt Modell, Schwelle und Klassen fest.
- Ohne Modell (`NUDITY_MODEL=off`) sagt die Einstellung, dass der Filter nicht
  wirkt.
- Im Debug-Modus lassen sich eigene Bilder testen (Werte je Klasse), ohne dass
  sie das Geraet verlassen.

## UC-48: Chat-Bild oder Video speichern oder teilen

**Als Nutzer** moechte ich ein Chat-Bild oder Video herunterladen oder direkt
ueber das Teilen-Menue meines Geraets weitergeben, und **als Absender**
festlegen, wer meine Medien speichern darf.

Akzeptanzkriterien:

- Im Bild- und Video-Betrachter stehen "Speichern" und, wo das Geraet Dateien
  teilen kann (typisch installierte App auf dem Handy), "Teilen" nebeneinander.
- Einstellung "Wer darf meine Bilder und Videos speichern": "Nur Freunde"
  (Standard, Betreiber kann ihn aendern) oder "Alle Chat-Partner"; gilt fuer
  neue Nachrichten, auch fuers Teilen.
- Im Snap-Editor laesst sich jede Aufnahme mit einem Schalter neben den
  Werkzeugen (Download mit Kontakt) als "nicht speicherbar" markieren; der
  Schalter ist dann durchgestrichen mit Hinweis. Standard kommt vom Betreiber,
  sonst speicherbar.
- Eigene Bilder und Videos lassen sich immer speichern.
- Alben, Secure Snaps und Einmal-Snaps nie.
- Teilen gibt die Datei an das System; Abbrechen zeigt keinen Fehler.

## UC-49: Aus einer anderen App nach OpenGrid teilen

**Als Nutzer der installierten App** moechte ich ein Foto aus der Galerie oder
einen Link ueber das Teilen-Menue direkt in einen Chat schicken.

Akzeptanzkriterien:

- OpenGrid erscheint im Teilen-Menue des Geraets (installierte PWA, nicht iOS).
- Nach dem Teilen fragt OpenGrid "Senden an" und zeigt die Chats.
- Bilder gehen als Chat-Bilder raus; Text landet im Eingabefeld und wird nicht
  automatisch gesendet.
- Andere Dateien werden uebersprungen, mit Hinweis.
- Geteiltes bleibt bis dahin nur auf dem Geraet und wird danach geloescht.

## UC-50: Album-Vorschau im Chat

**Als Album-Besitzer** moechte ich festlegen, ob die Album-Karte im Chat ein
scharfes, ein unscharfes oder gar kein Vorschaubild zeigt.

Akzeptanzkriterien:

- Auswahl je Album "Vorschau im Chat": normal, unscharf, keine.
- Unscharf: das gesendete Vorschaubild ist bereits unscharf, ein scharfes
  verlaesst das eigene Geraet nicht.
- Keine: die Karte zeigt nur Name und Anzahl.
- Gilt fuer kuenftig geteilte Karten.

## UC-51: Album begrenzt teilen

**Als Album-Besitzer** moechte ich ein Album wie einen Snap nur fuer wenige
Ansichten oder kurze Zeit freigeben.

Akzeptanzkriterien:

- Nach der Album-Auswahl im Chat: "Normal teilen" (wie bisher) oder begrenzt
  1x/2x/3x ansehen bzw. 15 min/1 h/24 h.
- Ansichten: jedes Oeffnen zaehlt eine Ansicht (15 Minuten); der Besitzer muss
  dafuer online sein. Danach ist der Zugriff weg.
- Zeit: nach Ablauf ist der Zugriff weg, auch wenn der Besitzer offline war
  (die Schluessel enden mit der Frist).
- Die Album-Karte im Chat zeigt die Grenze; in der Alben-Verwaltung stehen
  begrenzte Personen mit ihrem Stand und lassen sich vorher entziehen.
- Ab 3 Personen ist die Zugriffsliste eingeklappt.

## UC-52: Sprachnachricht abspielen

**Als Empfaenger** moechte ich in einer Sprachnachricht springen und sie
schneller abspielen.

Akzeptanzkriterien:

- Tippen oder Ziehen auf der Leiste springt an die Stelle.
- Knopf 1x / 1,5x / 2x, gilt fuer alle Sprachnachrichten.
- Neue Nachrichten waehrend der Wiedergabe lassen Knopf und Leiste nicht
  flackern.

## UC-53: Flirt-Modus im Freundes-Chat

**Als Nutzer** moechte ich nach dem Adden normal schreiben, aber mit derselben
Person auch weiter flirten koennen.

Akzeptanzkriterien:

- Pro Person bleibt es ein Chat; er steht nach dem Adden unter "Chat &
  Freunde".
- Eine Flamme ueber dem Senden-Knopf schaltet pro Chat in den Flirt-Modus:
  dort sehe ich alles (Flirt-Nachrichten markiert) und schreibe
  Flirt-Nachrichten; Senden lange druecken schickt nur eine Nachricht als
  Flirt. Die Flamme laesst sich ausblenden (Einstellung oder pro Chat).
- Im normalen Chat sind Flirt-Nachrichten standardmaessig ausgeblendet
  (Einstellung "Flirt-Verlauf im normalen Chat ausblenden", Chat > Nach dem
  Adden); kommt eine neue, zeigt die Flamme einen Punkt (auch wenn danach
  schon weitere normale Nachrichten kamen).
- Ohne aktiven Entdecken-Bereich gibt es keine Flamme, der Flirt-Teil bleibt
  verborgen.
- Nichts wird geloescht; das Gegenueber merkt nichts.

## UC-54: Benachrichtigungen je Art

**Als Nutzer** moechte ich festlegen, worueber ich benachrichtigt werde.

Akzeptanzkriterien:

- Einstellungen > Chat > Benachrichtigungen: Match, Flamme, Nachricht in
  "Entdecken", Profilbesuch, Adden, Nachricht in "Chat & Freunde",
  Chat-Ereignisse; nur die Arten der aktiven Bereiche sind sichtbar.
- Ein Schalter gilt fuer Push (App geschlossen) und den Hinweis in der App.
- Abgeschaltete Arten kommen gar nicht erst als Push.
- Flamme, Match und Anfragen wecken die App jetzt auch im Hintergrund.
- Profilbesuche: der Besucher muss "Meine Profilbesuche zeigen" einschalten
  (Standard aus), der Besuchte "Profilbesuch" (Standard aus); nur in
  "Entdecken", hoechstens alle 6 Stunden pro Person.

## UC-55: Lange Chats

**Als Nutzer** moechte ich, dass auch lange Chats schnell oeffnen, und auf Wunsch
Tag fuer Tag lesen.

Akzeptanzkriterien:

- Ein Chat zeigt zuerst die letzten 150 Nachrichten; oben angekommen kommen
  aeltere dazu, ohne dass die Ansicht springt.
- Option "Chat nach Tagen" (Einstellungen > Chat): eine Leiste unter der
  Kontaktleiste zeigt den Tag; Pfeile links/rechts oder seitlich wischen
  wechseln zu Tagen mit Nachrichten. Nach dem Senden steht der Chat auf heute.
- Suche und "nur markierte" finden Nachrichten aus allen Tagen.

## UC-56: Interaktionen und Matches im Grid

**Als Nutzer in "Entdecken"** moechte ich sehen, wer mich angesehen oder mir
eine Flamme geschickt hat, und meine Matches an einem Ort.

Akzeptanzkriterien:

- Das Grid hat drei Bereiche: Grid, Interaktionen, Matches.
- Interaktionen: Flammen und Profilbesuche, neueste oben, mit "Flamme
  zurueck"; ein Badge zeigt Neues. Die Liste liegt nur auf dem Geraet.
- Matches: noch nicht angeschriebene oben, "Schreiben" oeffnet den Chat.
- Filter hinter einem Pfeil-Knopf: Entfernung, mit Foto, Zahlen von-bis und
  Auswahlfelder aus dem Profil; nur auf dem Geraet. Wer noch ohne geladenes
  Profil ist, steht als "unbekannt" hinten (abschaltbar).
- Im geoeffneten Profil wische ich seitlich zum naechsten Profil.

## UC-57: Nur fuer bestimmte Leute sichtbar

**Als Nutzer in "Entdecken"** moechte ich festlegen, wer meine Karte im Grid
sieht (z. B. nur Position "Top", Alter 21-35).

Akzeptanzkriterien:

- Einstellungen > Privatsphaere > "Wer mich im Grid sieht": Auswahl je Zahl-
  oder Auswahlfeld des Profils; ohne Auswahl sehen mich alle.
- Wer nicht passt (oder den Wert nicht angegeben hat), sieht meine Karte nicht.
- Der Router bekommt nur einen kurzen Code der Regel, nie etwas ueber die
  Betrachter; ein Hinweis sagt, dass die Regel lesbar ist und eine veraenderte
  App sie ignorieren koennte.

## UC-58: Profil loeschen

**Als Nutzer** moechte ich mein Profil vollstaendig loeschen.

Akzeptanzkriterien:

- Einstellungen > Allgemein > "Profil endgueltig loeschen", zweimal bestaetigen.
- Der Router loescht alles zu mir; mein Geraet loescht alle Daten, die App
  startet neu mit der Einrichtung.
- Bei meinen Kontakten verschwinden Verlauf, Bilder, Alben und Status; der
  Chat bleibt in der Liste mit "Profil wurde geloescht", schreiben geht nicht
  mehr. Kontakte, die gerade offline sind, bekommen das beim naechsten Oeffnen.
- Tippt ein Kontakt den Chat an, oeffnet er sich nicht mehr, sondern
  verschwindet endgueltig ("Profil wurde geloescht - Chat entfernt").
- Ohne Verbindung zum Router wird nichts geloescht (Hinweis).

## UC-59: Alter mit der Wallet nachweisen

**Als Nutzer** moechte ich mein Alter mit meiner digitalen Wallet nachweisen,
ohne Namen oder Geburtsdatum preiszugeben, und **als Betreiber** nur Nachweise
von Ausstellern annehmen, denen die EU (oder ich selbst) vertraut.

Akzeptanzkriterien:

- Mit `AGE_CHECK=provider` und `AGE_PROVIDER=eudi` fuehrt "Alter nachweisen" zur
  Wallet-Auswahl des Browsers; abgefragt wird nur `age_over_18`.
- Nach gueltigem Nachweis ist der Nutzer sichtbar und bekommt das Grid.
- Abgelehnt werden: unbekannte Aussteller, Antworten fuer eine andere Seite,
  falsche oder wiederverwendete Nonces, `age_over_18 = false`, nicht erlaubte
  Nachweisarten.
- Ohne Unterstuetzung im Browser oder bei Abbruch erscheint ein Hinweis statt
  eines Fehlers.
- Die EU-Liste anerkannter Aussteller wird automatisch und nur mit gueltiger
  Signatur des bekannten Unterzeichners uebernommen; eine ungueltige Fassung
  aendert nichts.
- Der Router speichert nur "18+" und einen HMAC des Geraeteschluessels.

## UC-60: Router im Admin-Panel ueberwachen

**Als Betreiber** moechte ich auf einen Blick sehen, wie ausgelastet mein Router
ist, und mich dafuer sicher ohne Passwort anmelden.

Akzeptanzkriterien:

- Ohne Passkey steht beim Start ein einmaliger Setup-Link im Log; damit entsteht
  der erste Passkey, danach gilt der Link nicht mehr.
- Anmelden nur per Passkey; fremde Seiten, fremde Passkeys und wiederverwendete
  Challenges werden abgelehnt.
- "Auslastung" zeigt je Wert ein Diagramm mit aktuellem Wert, die letzte Stunde
  oder 24 Stunden, Warnungen mit Symbol und Text und eine Tabelle.
- "Status" zeigt Version, Peers, Push-Abos, Zwischenspeicher, Nacktbild-Modell
  und Nachweise; Nutzerinhalte zeigt das Panel nie.
- Weitere Passkeys lassen sich anlegen, der letzte nicht entfernen.
- "Einstellungen" aendert u. a. Nachweis-Pflichten, Nacktbild-Modell und
  App-Standards ohne Neustart; ungueltige Werte werden mit Grund abgelehnt,
  "Zuruecksetzen" stellt die Umgebung wieder her, Panel-Werte gelten auch nach
  einem Neustart.
- "Sperren" sperrt Peer-IDs und E-Mail-Adressen (nur als HMAC gespeichert) und
  hebt Sperren auf; ein gesperrter Peer kann sich nicht mehr registrieren.
- Nach einem Wasserzeichen-Treffer kann ein Nutzer den Peer melden (ohne das
  Bild hochzuladen); im Panel unter "Meldungen" sperrt der Betreiber mit einem
  Klick oder legt die Meldung ab.

## UC-61: Getrenntes Entdecken nach Alter und Pflicht-Scan

**Als Betreiber** moechte ich, dass sich Minderjaehrige und Erwachsene beim
Entdecken nicht begegnen und Minderjaehrige vor Nacktbildern geschuetzt sind.

Akzeptanzkriterien:

- Mit Altersnachweis-Pflicht sehen sich in "Entdecken" und "Event" nur Menschen
  derselben Altersgruppe; ohne Nachweis gibt es kein Entdecken.
- Ein gueltiger Wallet-Nachweis "unter 18" fuehrt in die Gruppe unter 18 (statt
  abgelehnt zu werden).
- `NUDITY_SCAN_REQUIRED` legt fest, fuer wen der Nacktbild-Filter Pflicht ist
  (aus, unter 18, Chats mit unter 18, alle); der Schalter ist dann gesperrt.
- Bei "Chats mit unter 18" prueft der Empfaenger Bilder von unter 18 immer; der
  Router erfaehrt dabei nicht, wer unter 18 ist.
- Unter 18 (oder ohne verlangten Nachweis) oeffnet keine Einladung aus
  "Entdecken"/"Event", sondern sieht einen Hinweis; der eigene Einladungslink
  fuehrt dann in den Chat-Bereich. Einladungen aus "Chat & Freunde" gehen normal.

## UC-62: Chat per Wischen schliessen (Hintergrund-Geste)

**Als Nutzer** moechte ich einen Chat mit einem Wisch nach rechts schliessen, ohne
die Eingabeleiste treffen zu muessen.

Akzeptanzkriterien:

- In einem unsichtbaren Band (etwa 1 cm) in der Mitte des Verlaufs schliesst ein
  Wisch nach rechts den Chat, auch ueber einer Nachricht.
- Links und rechts davon wird die Nachricht auf dieser Hoehe gewischt (Antworten),
  wie bisher.
- Liegt dort keine Nachricht, ist sie geloescht oder ist es eine eigene Nachricht
  (die man nach links beantwortet), schliesst der Wisch nach rechts den Chat.
- Geloeschte Nachrichten lassen sich weder beantworten noch per Geste bedienen.
- Abschaltbar zusammen mit dem Wischen auf der Eingabeleiste.

## UC-63: Altersnachweis ueber einen OIDC-Pruefdienst

**Als Betreiber** moechte ich einen beliebigen Pruefdienst (z. B. KJM-anerkannt)
anbinden, ohne dass OpenGrid an einen Anbieter gebunden ist.

Akzeptanzkriterien:

- Mit `AGE_PROVIDER=oidc` leitet "Alter nachweisen" zum Dienst und zurueck in die
  App; danach ist der Nachweis gespeichert (nur Altersgruppe + HMAC).
- Aussteller, Client und Claim sind per Umgebung oder live im Admin-Panel
  einstellbar; das Client-Secret liegt verschluesselt und wird nie angezeigt.
- "Unter 18" nur bei ausdruecklichem Wert des Dienstes; fehlender oder unklarer
  Claim, falsche Signatur, Nonce, Aussteller oder Client -> abgelehnt.
- Ein `state` gilt nur fuer den Peer, der den Ablauf gestartet hat, und nur einmal.

## UC-64: Vom Match zum Freund, Chatliste mit Menue

**Als Nutzer** moechte ich, dass ein Chat erst dann zu "Chat & Freunde" wandert,
wenn wir wirklich Freunde sind, und ihn in der Liste schnell bedienen koennen.

Akzeptanzkriterien:

- Wer nur "Entdecken" nutzt, kann nicht geaddet werden; der "Adden"-Knopf
  verschwindet beim Match, sobald er den Bereich umstellt.
- Eine Anfrage laesst den Chat in "Grid & Event"; erst die Freundschaft
  verschiebt ihn.
- In "Grid & Event" bleibt ein Verweis "Jetzt in Chat & Freunde", der dorthin
  fuehrt und sich entfernen laesst.
- Jede Zeile der Chatliste hat ein Menue (Knopf rechts, langes Druecken,
  Rechtsklick): Oeffnen, Profil, Chat loeschen, Blockieren.
- Im Entdecken-Modus ist ein Chat, der in beiden Bereichen steht, automatisch
  im Flirt-Modus (pro Chat abschaltbar); der Verweis oeffnet ihn dort als Flirt.

## UC-65: Flammen nach dem Match, gestapelt

**Als Nutzer** moechte ich einem Match weiter Flammen schicken und sehen, wie
viele ich bekommen habe.

Akzeptanzkriterien:

- Auch nach einem Match geht eine Flamme pro Tag und Person; der andere wird
  benachrichtigt, das Match bleibt.
- Erhaltene Flammen stapeln sich: 2 = Doppelflamme, ab 3 = Flamme mit Zahl.
- Flammen verschwinden nach einer Woche; Match aufloesen loescht sie.
