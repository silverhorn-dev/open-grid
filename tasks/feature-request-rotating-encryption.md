# Feature Request: Eigenes, rotierendes Verschluesselungsverfahren fuer Medien

Status: eigener Algorithmus verworfen (2026-10-29, siehe `tasks/rejected.md`); Alternativen
(Key-Splitting, Epochen-Geheimnis, Stream) besprochen und geparkt, siehe `tasks/board.md`.

## 1. Idee (Nutzer)

- Medien (Albumbilder, Snaps) sollen nach Ablauf der TTL auch dann nicht mehr
  lesbar sein, wenn jemand einen Schluessel aus dem Client kopiert hat.
- Dafuer ein eigener Verschluesselungsalgorithmus statt nur AES-GCM aus
  `crypto.subtle`.
- Der Algorithmus ist "pattern-modularisiert": er besteht aus Bausteinen, deren
  Reihenfolge/Parameter ein Muster festlegt.
- Das Muster wechselt regelmaessig (z. B. pro Epoche) und kommt vom Server.
  Nach dem Wechsel passt ein alter (gestohlener) Schluessel nicht mehr zum
  neuen Muster.

## 2. Ausgangslage

- Albumbilder: Inhaltsschluessel `CK` pro Bild und Schluesselversion
  (AES-256-GCM), fuer alle Betrachter gleich (seit R3, Schwarm-Weitergabe).
- Betrachter bekommen `CK` nur in Buendeln (`ALBUM_KEYS`), verpackt mit
  `KEK_e = HKDF(ECDH(eigener Key, Besitzer-Key), salt = R_e, info = Album:Epoche:Version)`.
- Die TTL wirkt auf die Schluesselverteilung: Buendel laufen ab, `CK` liegt nur
  nicht exportierbar im Arbeitsspeicher und wird zum Epochenende verworfen.
- Ein manipulierter Client kann `CK` beim Entpacken roh mitschneiden. Dieser
  Schluessel funktioniert dann bis zur naechsten `keyVersion` (Entzug) auf allen
  gespeicherten Kopien.

## 3. Ziel

Ein mitgeschnittener Schluessel soll nach Ablauf seiner Epoche keine neueren
Daten mehr entschluesseln koennen, und der Wechsel soll zentral (Server-Takt)
gesteuert werden.

## 4. Bewertung

### 4.1 Konflikt mit den harten Regeln

- `AGENT.md` / `claudy.md` Regel 3: "All crypto via native `crypto.subtle`".
  Ein eigener Algorithmus verletzt diese Regel; dafuer braucht es eine bewusste
  Entscheidung (Eintrag im Decisions log).

### 4.2 Sicherheit eines eigenen Algorithmus

- Der Algorithmus laeuft im Browser, sein Code ist also fuer jeden lesbar. Auch
  das Muster muss beim Client ankommen, sonst kann er nicht entschluesseln.
  Sicherheit kann daher nur im Schluessel liegen, nicht im Verfahren
  (Kerckhoffs-Prinzip).
- Eigene Chiffren ohne jahrelange Kryptoanalyse sind praktisch immer schwaecher
  als AES-GCM. Eine Kombination aus wechselnden Bausteinen erhoeht die
  Sicherheit nicht, sie erhoeht nur die Fehlerflaeche (Padding, IV-Reuse,
  fehlende Authentisierung).
- `crypto.subtle` ist nativ, konstant-zeitig und hardwarebeschleunigt; eigener
  JS-Code ist deutlich langsamer (wichtig bei 3 MB Bildern auf Smartphones).

### 4.3 Grundsaetzliche Grenze

- Wer waehrend einer gueltigen Epoche Schluessel, Muster und Ciphertext hat,
  kann das Bild einfach im Klartext speichern. Das kann kein Verfahren
  rueckgaengig machen; nur das Wasserzeichen macht es nachverfolgbar.
- Ein wechselndes Muster schuetzt also nur Daten, die **nach** dem Wechsel
  verschluesselt werden. Alte Kopien bleiben mit altem Schluessel + altem Muster
  lesbar, ausser sie werden pro Epoche neu verschluesselt (mehr Traffic).

## 5. Vorschlag: gleiches Ziel mit `crypto.subtle`

Der "vom Server getaktete Wechsel" laesst sich ohne eigene Chiffre abbilden:

1. **Epochen-Geheimnis vom Server**: `/api/time` liefert zusaetzlich ein
   zufaelliges `S_e` pro Epoche (der Server kennt keine Inhalte, nur Zufall).
   Der Server gibt `S_e` nur waehrend Epoche `e` heraus und loescht es danach.
2. **Inhaltsschluessel pro Epoche**:
   `CK_e = HKDF(CK, salt = S_e, info = og-album-image:<imageId>:<epoch>)`.
   Ein mitgeschnittener `CK` allein reicht nicht mehr, es braucht zusaetzlich
   `S_e`, das es nach der Epoche nirgends mehr gibt.
3. **Neu verschluesseln pro Epoche**: gespeicherte Kopien werden zum
   Epochenwechsel neu verschluesselt (Besitzer oder Schwarm-Betrachter, siehe R3).
   Kosten: Bilder x Betrachter pro Epoche.
4. Das "Muster" ist dann das Epochen-Geheimnis; Algorithmus bleibt AES-GCM.

Grenze wie 4.3: Wer `CK`, `S_e` und Ciphertext innerhalb derselben Epoche
mitschneidet, hat das Bild.

## 6. Offene Fragen

1. Eigener Algorithmus trotz Regel 3, oder Variante aus Abschnitt 5?
2. Darf der Server ein Epochen-Geheimnis ausgeben (er sieht dabei keine
   Inhalte, wird aber Teil der Schluesselableitung)?
3. Welcher Traffic ist fuer das Neu-Verschluesseln pro Epoche akzeptabel
   (Epochenlaenge vs. Anzahl Bilder/Betrachter)?
4. Gilt das auch fuer Secure Snaps, oder nur fuer Alben?

## 7. Akzeptanzkriterien (falls umgesetzt)

- Ein in Epoche `e` mitgeschnittener Schluessel entschluesselt keine in Epoche
  `e+1` oder spaeter erzeugten Ciphertexte.
- Epochen-Geheimnisse sind nach Ablauf weder auf dem Server noch im Client
  gespeichert.
- Unit-Tests: Epochen-Wechsel, abgelaufenes Geheimnis, gestohlener `CK` ohne
  `S_e`.
- `SPECE.md` (Alben, Schluesselverteilung) und `README.md` (Server-Rolle)
  aktualisiert.

## 8. Besprechung 2026-10-29: Nutzer-Idee "Lese-Muster vom Router + Geheimnis vom Peer"

Idee: Der Router liefert ein Lese-Muster, der Peer ein Geheimnis; ueber das Muster wird aus dem
Geheimnis eine Zeit gelesen, passt sie nicht -> Fehler, sonst wird mit dem Zeitstempel der Rest zum
Schluessel entschluesselt.

Bewertung aus Sicht eines veraenderten Clients:

- Die Zeitpruefung ist eine Verzweigung im Code; der Angreifer entfernt sie oder stellt die Uhr
  zurueck. Pruefungen im Code schuetzen nur gegen ehrliche Clients (das leisten Limits und
  Selbstzerstoerung bereits).
- Ein Zeitstempel ist kein Geheimnis (steht in den Daten oder ist leicht zu raten).
- Echter Schutz kommt nur vom Router-Anteil, und nur wenn er nicht zu erraten ist (~128 Bit Zufall,
  ein Muster aus wenigen Positionen ist in Sekunden durchprobiert) und nach der Frist geloescht wird.
  Dann ist es Key-Splitting.

Saubere Fassung (gleiches Ziel, nur `crypto.subtle`):

```
Bildschluessel = HKDF( Besitzer-Geheimnis,
                       salt = Router-Geheimnis (256 Bit, je Freigabe-Frist),
                       info = album:bild:gueltig-bis )
```

- Der Router gibt sein Geheimnis nur bis zur Frist heraus (pro Bild beim Ansehen, begrenzt) und
  loescht es danach. Die "Zeitpruefung" ist dann echt: nach der Frist gibt es den Bestandteil nicht mehr.
- Bilder werden einmal verschluesselt, kein Neu-Verschluesseln pro Zeitscheibe.
- Grenze bleibt: wer beide Teile waehrend einer gueltigen Ansicht hat, behaelt Schluessel bzw. Bild.
  Schutz nur gegen kopierte App-Daten nach der Frist.

Status: geparkt (Nutzer 2026-10-29).

