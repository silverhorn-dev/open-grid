# Gruppenchats und Mehrgeraete-Betrieb (Plan)

Stand: 2026-11-10 (Board T35, Backlog "group chats" und "Mehrgeraete-Betrieb").
Alle Phasen gebaut (P0-P5, 2026-11-10; Umsetzung in SPECE.md). Abweichung bei
P3: kein eigener Medien-Schluessel/`mediaId`; der Schwarm nutzt die vorhandenen
Originale (Nachrichten-ID + SHA-256 in der Nachricht), uebertragen ueber die
paarweise verschluesselten Kanaele. Abweichung bei P4:
jedes Geraet behaelt seine Node-ID, die Router-Registrierung bekommt keine
Identitaets-ID; das nicht zuletzt aktive Geraet meldet sich still an.

## 1. Ziel

- **Gruppen**: Chats mit mehreren Personen (Text, Reaktionen, Bilder, Sprache,
  Snaps), ohne dass der Router mehr erfaehrt als heute.
- **Mehrgeraete**: dieselbe Person auf Handy und PC gleichzeitig, mit allen
  Chats, Freunden und Matches auf beiden Geraeten.
- **Weniger Router-Cache**: Medien moeglichst von Geraet zu Geraet ("Schwarm"),
  der Zwischenspeicher nur als Rueckfall.

Beides hat denselben Kern: eine Nachricht geht an **mehrere Nodes** statt an
einen. Eine Person mit zwei Geraeten ist fuer ihre Kontakte eine kleine Gruppe
aus zwei Nodes. Darum wird beides gemeinsam geplant.

## 2. Ist-Stand

- Eine Identitaet = ein Geraet = eine Node-ID mit eigenen, nicht exportierbaren
  Schluesseln (ECDH fuer Verschluesselung, ECDSA fuer Signaturen).
- Chats sind 1:1: Operations-Log je `peerId` (`chatOperations`), Abgleich per
  `CHAT_SYNC_HELLO`/Inventar (siehe SPECE, "Pruefung des Chat-Syncs").
- Schluessel je Paar: P2P-Sitzung **und** Pfad C nutzen statisches ECDH
  (eigener privater x fremder oeffentlicher Schluessel) -> immer derselbe
  AES-Schluessel je Paar, keine Forward Secrecy.
- Operationen sind nicht einzeln signiert; der Absender ist der Kanal (P2P)
  bzw. der `senderPublicKey` (Pfad C). Weiterleiten durch Dritte geht deshalb
  nicht pruefbar.
- Router: Signaling, Grid, Pfad C je **Empfaenger-Node** (hoechstens 500
  Nachrichten bzw. 20 MB je Empfaenger), Web Push je Node.
- Umzug (`move.js`) zeigt schon das Muster fuer Mehrgeraete: die alte
  Identitaet signiert eine Vollmacht fuer einen neuen Schluessel.

## 3. Gemeinsamer Kern: Unterhaltung mit Mitgliedern

- Neues Modell **Unterhaltung** (`conversationId`) mit einer Liste von
  Mitglieds-Nodes. Ein 1:1-Chat ist eine Unterhaltung mit zwei Personen.
- Das Operations-Log haengt an der `conversationId` statt an der `peerId`;
  der Chat-Sync laeuft mit **jedem** gerade erreichbaren Mitglied (dasselbe
  HELLO/Inventar wie heute).
- **Signierte Operationen** (Voraussetzung fuer alles Weitere): jede Operation
  traegt `actorId`, `deviceId` und eine ECDSA-Signatur ueber den kanonischen
  Inhalt. Dann darf jedes Mitglied fremde Operationen weitergeben, und der
  Empfaenger prueft den Urheber selbst. Nebenbei kann ein Peer keine
  Operationen mehr im Namen anderer einspielen (Befund aus dem Chat-Sync-Pruefen).
- Zustellung = Fan-out an alle Mitglieds-Nodes: P2P, wenn offen, sonst Pfad C
  je Node. Bestaetigt ist eine Operation erst, wenn sie im Sync eines Mitglieds
  auftaucht (wie heute `deliveryConfirmed`, je Mitglied).

## 4. Gruppen

### Mitglieder und Rechte

- Mitgliedschaft als signierte Operationen im Gruppen-Log:
  `GROUP_CREATE`, `GROUP_ADD`, `GROUP_REMOVE`, `GROUP_LEAVE`, `GROUP_ROLE`,
  `GROUP_RENAME`. Der aktuelle Stand ergibt sich aus dem Log (deterministisch,
  bei Konflikten gewinnt die fruehere Operation, Gleichstand nach ID).
- Vorschlag: Gruender ist Admin; Admins duerfen hinzufuegen, entfernen und
  andere zu Admins machen. Jeder darf austreten.
- Neue Mitglieder bekommen den Verlauf **nicht** (Vorschlag; siehe offene
  Entscheidungen), sondern erst ab ihrem Beitritt.

### Verschluesselung

- **Stufe 1, Fan-out paarweise**: jede Nachricht wird fuer jedes Mitglied mit
  dem vorhandenen Paar-Schluessel verschluesselt und einzeln zugestellt. Kein
  neues Krypto-Verfahren, sofort nutzbar; Kosten wachsen mit der Gruppengroesse
  -> Grenze z. B. 32 Mitglieder.
- **Stufe 2, Absender-Schluessel** ("sender keys"): jedes Mitglied hat einen
  eigenen symmetrischen Gruppen-Schluessel (AES-256-GCM, `crypto.subtle`) mit
  Ketten-Ableitung (HKDF je Nachricht, alte Glieder werden verworfen ->
  Forward Secrecy innerhalb der Kette). Der Schluessel geht einmal paarweise an
  jedes Mitglied; eine Nachricht wird nur **einmal** verschluesselt. Bei
  `GROUP_REMOVE` erzeugen alle neue Absender-Schluessel (das entfernte Mitglied
  kann neue Nachrichten nicht mehr lesen).
- Signatur der Operation (siehe 3) bleibt zusaetzlich, damit Mitglieder sich
  nicht gegenseitig faelschen koennen (der Gruppen-Schluessel allein beweist nur
  "irgendein Mitglied").

### Router

- Unveraendert: Signaling je Node, Pfad C je Empfaenger-Node.
- Optional spaeter: ein Pfad-C-Eintrag fuer mehrere Empfaenger (einmal
  Chiffrat, Liste von Empfaenger-IDs) als Erweiterung von `POST /api/cache`
  (keine neue Route, siehe Decisions-Log). Der Router lernt dabei, welche Nodes
  zusammen schreiben (das sieht er beim paarweisen Fan-out aber ohnehin).
- Web Push je Mitglied wie heute.

## 5. Medien im Schwarm (weniger Router-Cache)

- Jedes Medium (Bild, Video, Sprache, Original) bekommt einen eigenen
  Schluessel `K` und wird verschluesselt; die Nachricht traegt nur
  `{ mediaId = SHA-256(Chiffrat), K, Groesse, Typ }`.
- Wer das Chiffrat hat (Absender, jedes Mitglied, das es schon geladen hat),
  bietet es an: `MEDIA_HAVE { mediaIds }` beim Verbinden, Abruf in Stuecken
  `MEDIA_REQUEST { mediaId, offset }` / `MEDIA_CHUNK` (wie heute die
  Originale). Der Empfaenger prueft den Hash.
- Pfad C traegt nur noch die kleine Nachricht; das Medium kommt aus dem
  Schwarm. Ist niemand online, der es hat: Vorschau (klein, wie heute) im
  Pfad C, das Original spaeter.
- Wirkt auch fuer 1:1: der Router-Cache traegt fast nur noch Text.

## 6. Mehrgeraete

- **Geraete einer Identitaet**: das erste Geraet ist die Wurzel. Ein neues
  Geraet koppelt per QR/Code (wie der Umzug, `transfer.js`): es bekommt die
  Daten und eine von der Wurzel signierte **Geraete-Bescheinigung**
  `{ identityId, deviceId, ECDH-/ECDSA-Schluessel, ausgestellt, Rechte }`.
- Eine signierte **Geraeteliste** (versioniert) geht an alle Kontakte. Kontakte
  schicken danach jede Nachricht an alle Geraete der Person (Fan-out wie bei
  Gruppen), pruefen eingehende Nachrichten gegen die Liste.
- Eigene Geraete sind stille Mitglieder **jeder** eigenen Unterhaltung: was das
  Handy sendet, bekommt der PC ueber denselben Sync. Lesestand, Einstellungen,
  Freunde, Matches, Alben gehen als eigene Operationen an die eigenen Geraete.
- Grid/Discovery: nur ein Geraet erscheint im Grid (das zuletzt aktive), damit
  die Person nicht doppelt auftaucht; die Router-Registrierung bekommt dafuer
  eine Identitaets-ID neben der Node-ID.
- Geraet entfernen: neue Geraeteliste ohne es, Kontakte verwerfen es; die
  Absender-Schluessel in Gruppen werden erneuert.
- Wurzel verloren (Handy kaputt): Vorschlag, die Wurzel kann einem zweiten
  Geraet das Recht "kann Geraete hinzufuegen" geben; ohne das bleibt nur der
  Umzug mit neuer Identitaet.

## 7. Entscheidungen (2026-11-10)

1. Gruppengroesse: hoechstens **16** Mitglieder.
2. Rechte: nur **Admins** fuegen hinzu (Gruender ist Admin, kann weitere ernennen).
3. Verlauf fuer neue Mitglieder: der **Admin entscheidet beim Hinzufuegen**
   (kein Verlauf oder die letzten 50 Nachrichten, neu verschluesselt).
4. Bereich: Gruppen in **Chat & Freunde** und im **Event-Modus**, nicht in
   Entdecken.
5. Mehrgeraete: das erste Geraet ist die **Wurzel**, das Recht "Geraete
   hinzufuegen" ist auf ein zweites Geraet uebertragbar.
6. Grid: nur das **zuletzt aktive** Geraet einer Person ist sichtbar.
7. Pfad C: **gleich buendeln** - ein Chiffrat mit Empfaengerliste
   (Erweiterung von `POST /api/cache`). Dafuer kommen die Gruppen-Schluessel
   (Absender-Schluessel ohne Kette) schon mit den Gruppen (P2), nicht erst P5.
8. Forward Secrecy: **mit P5** (Ketten fuer Gruppen, ephemeres ECDH fuer 1:1).

## 8. Phasen

| Phase | Inhalt |
|---|---|
| P0 | Signierte Operationen: jede eigene Operation traegt `sig` (ECDSA ueber kanonisches JSON); Empfaenger pruefen gegen den gepinnten Schluessel des Urhebers. Uebergang: unsignierte Operationen vom direkten Peer werden noch angenommen. |
| P1 | Unterhaltungs-Modell (`conversationId`), 1:1 als Sonderfall, IndexedDB-Migration |
| P2 | Gruppen: Mitglieder-Operationen (signiert), Admins, bis 16, Bereich Chat & Freunde + Event; Absender-Schluessel je Mitglied (AES-256-GCM, paarweise verteilt, bei Entfernen erneuert); Nachricht einmal verschluesselt, Pfad C gebuendelt (`recipients`); Verlauf fuer Neue nach Wahl des Admins |
| P3 | Medien-Schwarm (content-adressiert, Stuecke, Hash-Pruefung) |
| P4 | Mehrgeraete: Kopplung (QR/Code), Geraete-Bescheinigung von der Wurzel, Geraeteliste, Fan-out an Geraete, Sync eigener Geraete, Grid nur zuletzt aktives Geraet |
| P5 | Forward Secrecy: Ketten-Ableitung der Absender-Schluessel, ephemeres ECDH fuer 1:1 (P2P und Pfad C) |
