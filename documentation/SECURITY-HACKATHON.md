# Security-Hackathon (2026-11-10)

Pruefung der neuen Angriffsflaechen (GIFs, Melden, Umzug) und der Ideen aus dem
Backlog ("P2P mitlesen/angreifen, Profil-Anfragen, veraenderter Client, TURN,
fremder Router-Cache"). Vorgehen: Code lesen, Angriff nachstellen (Test),
beheben, Test behalten. Board T35.

## Ergebnis

| ID | Bereich | Schwere | Stand |
|---|---|---|---|
| S1 | Fremde Urheber in Chat-Operationen | mittel | behoben |
| S2 | Gefaelschte Schwarm-Profile | mittel | behoben |
| S3 | Wegmelden mit Wegwerf-Konten | mittel | behoben |
| S4 | Zu grosse Sync-Antworten (Verfuegbarkeit) | mittel | behoben (Chat-Sync-Pruefung) |
| S5 | Keine Forward Secrecy | mittel | offen, geplant |
| S6 | GIF-Links verraten IP und Oeffnen | niedrig | akzeptiert (Zustimmung, Proxy) |
| S7 | Ungesigniertes Alt-Profil vom direkten Peer | niedrig | akzeptiert |
| S8 | GIF-Proxy (SSRF) | - | geprueft, in Ordnung |
| S9 | Fremder Router-Cache, Umzugs-Relay, alte ID stilllegen | - | geprueft, in Ordnung |
| S10 | Client ueber P2P angreifen (Nutzlasten, XSS) | - | geprueft, in Ordnung |
| S11 | TURN mitlesen | - | geprueft, nur Metadaten |
| S12 | Veraenderter Client, Code-Hashing/Verschleierung | - | Einschaetzung |
| S13 | Aeltere Loeschungen nach langer Offline-Zeit | niedrig | bekannte Grenze |

## Befunde im Einzelnen

### S1 Fremde Urheber in Chat-Operationen (behoben)

- Angriff: Kontakt B schickt (P2P, Sync oder Pfad C) eine `MESSAGE_PUT` mit
  `actorId` und `message.senderId` = **meine** ID. `applyChatOperation` pruefte
  nur, dass beide gleich sind, nicht, dass sie zu B gehoeren. Folge: in meinem
  Verlauf steht eine Nachricht "von mir", die ich nie geschrieben habe (oder
  von Dritten).
- Fix: `isOperationFromPeer` (payload-validation.js); von B werden nur
  Operationen mit `actorId` = B angenommen (P2P und Sync; der Service Worker
  prueft das schon). Test: `test/payload-validation.test.js`.
- Dauerhafte Loesung fuer Gruppen/Mehrgeraete: signierte Operationen
  (GRUPPEN-MEHRGERAETE.md, Phase P0).

### S2 Gefaelschte Schwarm-Profile (behoben)

- Angriff: C beantwortet `SWARM_PROFILE_REQUEST` fuer A mit einem Profil, das
  C mit einem **eigenen** Schluessel signiert. Ohne gepinnten Schluessel von A
  galt das als "gueltig, unbestaetigt" und wurde als A's Profil (Name, Fotos)
  gezeigt, bis zur ersten direkten Verbindung.
- Fix: das Grid liefert je Peer `keyFp` (SHA-256 ueber den Signaturschluessel
  aus der Registrierung, 22 Zeichen); ein ungepinntes Schwarm-Profil wird nur
  angenommen, wenn sein Schluessel dazu passt (`signingKeyFingerprint`). Der
  Router kannte den Schluessel ohnehin. Tests: `test/client-crypto.test.js`,
  `test/server.test.js`.

### S3 Wegmelden mit Wegwerf-Konten (behoben)

- Angriff: ein Konto kostet nur einen Schluessel. Drei frische Konten melden
  eine Person -> sie ist im Grid ausgeblendet (`USER_REPORT_HIDE`).
- Fix: fuer das Ausblenden zaehlen nur Melder mit Konto aelter als
  `USER_REPORT_MIN_AGE_HOURS` (Standard 24); gespeichert wird jede Meldung, das
  Panel sieht das Alter. Test: `test/server.test.js`.
- Rest-Risiko: wer Konten einen Tag vorher anlegt, kann es weiter versuchen;
  der Admin entscheidet am Ende ("Wieder sichtbar machen"). Moegliche
  Verschaerfung: nur Melder zaehlen, die mit der Person Kontakt hatten, oder
  verifizierte Melder (Alters-/E-Mail-Nachweis), wenn der Router das verlangt.

### S4 Zu grosse Sync-Antworten (behoben)

Siehe SPECE "Pruefung des Chat-Syncs": eine Sync-Antwort mit mehreren Bildern
passte nicht in eine DataChannel-Nachricht; jetzt in Paketen. Gegenprobe e2e
`sync-large`.

### S5 Keine Forward Secrecy (offen)

- P2P-Sitzung und Pfad C nutzen statisches ECDH je Paar -> immer derselbe
  AES-Schluessel. Wer spaeter an einen privaten Geraeteschluessel kommt und
  frueheren Verkehr mitgeschnitten hat (z. B. Router-Cache-Kopien, TURN-Mitschnitt
  ohne DTLS-Schluessel reicht nicht, wohl aber Pfad-C-Chiffrate), kann ihn
  entschluesseln.
- Mildernd: Schluessel sind nicht exportierbar (im Browser gespeichert),
  Pfad C haelt hoechstens 72 h.
- Plan: ephemeres ECDH beim Verbinden fuer P2P, Ketten-Schluessel fuer Gruppen
  (GRUPPEN-MEHRGERAETE.md, Entscheidung 8, Phase P5).

### S6 GIF-Links verraten IP und Oeffnen (akzeptiert)

- Ein Absender kann je Empfaenger eine eigene GIF-URL schicken und sieht im
  Server-Log, wann und von welcher IP sie geladen wurde (wie ein Zaehlpixel).
- Mildernd: nichts wird ohne ausdrueckliche Zustimmung geladen (verschwommene
  Flaeche, Systemdialog nennt die IP), externe Links brauchen eine eigene
  Zustimmung, mit `GIF_PROXY=on` sieht der fremde Server nur den Router.

### S7 Ungesigniertes Alt-Profil (akzeptiert)

`PROFILE_RESPONSE` ohne Signatur wird vom **direkten** Peer noch angenommen
(Kompatibilitaet). Es betrifft nur sein eigenes Profil ueber den
authentifizierten Kanal, nicht Dritte. Kann entfallen, sobald alte Clients weg
sind.

### S8 GIF-Proxy (geprueft)

Nur https mit Hostnamen; DNS-Aufloesung, jede Adresse oeffentlich (IPv4, IPv6,
IPv4-in-IPv6), Verbindung genau zur gepruefte Adresse (kein DNS-Rebinding),
Weiterleitungen hoechstens 3 und jede neu geprueft, nur Bild/Video, Groesse auch
beim Lesen gezaehlt, Tages-Token je Peer, standardmaessig aus. Tests in
`test/server.test.js`.

### S9 Router-Cache, Umzug (geprueft)

- `GET /api/cache/:id` und `DELETE /api/cache/:msgId` verlangen das Token des
  Empfaengers; fremde Queues sind nicht lesbar.
- Umzugs-Relay: 128-Bit-ID, einmal abholbar, 15 min, Schluessel nie beim Router.
- Alte ID stilllegen: altes Token **und** gueltige Signaturkette der alten
  Identitaet noetig.

### S10 Client ueber P2P angreifen (geprueft)

- Jede Nutzlast (P2P und Pfad C) laeuft durch `isValidSecurePayload`
  (bekannte Typen, Laengen, Formate), bevor etwas passiert.
- Fremde Inhalte (Nachrichten, Profile, GIF-Titel, Notizen im Admin-Panel)
  werden per `textContent` gesetzt; `innerHTML` enthaelt nur feste Symbole und
  eigene Uebersetzungen. Strikte CSP (`script-src 'self'`, keine
  Inline-Handler).
- GIF-URLs nur `https:` (kein `javascript:`/`data:`).

### S11 TURN mitlesen (geprueft)

Ueber TURN laeuft der DataChannel (DTLS/SCTP verschluesselt), darin noch einmal
AES-256-GCM. Der TURN-Betreiber sieht IPs, Zeitpunkte und Groessen, keine
Inhalte. Im Club-/LAN-Betrieb ohne TURN.

### S12 Veraenderter Client (Einschaetzung)

- In einer PWA kontrolliert der Nutzer seinen Browser vollstaendig. Hashing
  oder Verschleierung des App-Codes halten einen Angreifer am eigenen Geraet
  nicht auf (er kann jede Pruefung entfernen) und machen die App nur schwerer
  pruefbar. Empfehlung: **keine** Verschleierung.
- Schutz entsteht dort, wo ein veraenderter Client nichts gewinnt: Pruefungen
  beim Empfaenger (S1, S2), Ende-zu-Ende-Verschluesselung (ein veraenderter
  Client sieht nur, was ihm ohnehin geschickt wird), Pruefungen auf dem Router
  (Tokens, Signaturen, Limits).
- Echte Geraete-Attestierung nur in der Android-App (Key Attestation, siehe
  ANDROID-APP.md).

### S13 Aeltere Loeschungen (bekannte Grenze)

Je Chat bleiben die neuesten 100 `MESSAGE_DELETE`; war der Partner bei mehr
Loeschungen offline, erfaehrt er von den aeltesten nichts.

## Was der Router weiterhin sieht (by design)

Wer mit wem ueber Pfad C/Signaling Kontakt hat (Routing-IDs), Zeitpunkte,
Groessen, Grid-Zelle (Geohash 6), Meldungen (IDs, Grund, Notiz), beim Umzug
"alte ID -> neue ID", bei aktiver Anbieter-Suche nichts (Anfragen gehen direkt
zum Anbieter).
