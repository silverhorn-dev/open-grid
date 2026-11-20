# Profilbild-Verifizierung (Board T37 P1/P2, Plan)

Stand: 2026-11-19. Ziel (Nutzer): Fake-Profile und Menschen, die auf
Nacktbilder aus sind, im Dating ausbremsen. Ein Haken "Profilbild verifiziert"
zeigt: die Person hinter dem Profil sieht aus wie ihr Profilbild und war beim
Pruefen live vor der Kamera.

## Entscheidungen (Nutzer, 2026-11-11)

- Nur im Dating (Entdecken). Event offen; im Social-Bereich spaeter optional ein
  Video-Ident ohne Abgleich mit dem Profilbild (dort oft kein eigenes Gesicht).
- Clients ohne App-Attestierung (Browser, heutige App) prueft der **Router**;
  er sieht das Selfie dafuer kurz. Mit Attestierung (ANDROID-APP.md Phase 4)
  kann die App spaeter auf dem Geraet pruefen.
- Keine Gesichter ueber Konten hinweg vergleichen (keine biometrische
  Datenbank, DSGVO Art. 9).

## Modelle (geprueft 2026-11-19)

| Zweck | Modell | Lizenz | Groesse |
|---|---|---|---|
| Gesicht finden + 5 Punkte (Augen, Nase, Mundwinkel) | YuNet (OpenCV Zoo, `face_detection_yunet_2023mar.onnx`) | MIT | ca. 230 KB |
| Gesichtsvergleich (Merkmalsvektor, Kosinus) | SFace (OpenCV Zoo, `face_recognition_sface_2021dec.onnx`) | Apache-2.0 | ca. 37 MB |
| Laufzeit | onnxruntime-web (WASM, schon fuer NudeNet im Projekt) + jpeg-js | MIT | - |

- Nicht genommen: InsightFace (ArcFace, SCRFD, buffalo): Code MIT, die
  vortrainierten Modelle aber nur fuer nicht-kommerzielle Forschung.
- Wie NudeNet laedt das Docker-Image beide Modelle beim Bauen mit fester
  Pruefsumme nach `models/verify` (zusammen ca. 39 MB); eigener Ordner per
  `VERIFY_MODEL_DIR`. Benutzt nur mit `VERIFY=on`.
- Gemessen 2026-11-19 (NASA-Portraits, gemeinfrei): dieselbe Person auf zwei
  Fotos Kosinus 0,87, verschiedene Personen 0,11-0,17; Erkennung ca. 90 ms je
  Bild (WASM, 640x640).

## Ablauf (Stand 2026-11-20: Bildfolge statt drei Einzelbilder)

1. Profil (Dating) hat ein Profilbild. "Profil verifizieren" erklaert vorher,
   was passiert, und fragt nach der Zustimmung.
2. `POST /api/verify/start` -> `{ sessionId, steps, expiresAt, maxFrames }`:
   erst "geradeaus" (Bezugsbild), dann "links"/"rechts" in zufaelliger
   Reihenfolge; 3 Minuten gueltig, je Peer 5 Versuche am Tag.
3. Frontkamera mit **Live-Anleitung im Browser**: YuNet laeuft im Web Worker
   (`client/app/verify-worker.js`, onnxruntime-web, Modell vom eigenen Router).
   Die App sagt "naeher ran", "nur eine Person", "weiter nach links" usw. und
   nimmt automatisch auf, sobald die Haltung passt (strengere Grenzen als der
   Router). Je Schritt 4 Gesichtsausschnitte (256 px, ca. 20 KB), mit Zeit.
   Nur Komfort: entschieden wird beim Router.
4. `POST /api/verify/finish { sessionId, frames: [{ data, step, t }], profileImage, avatarSha256 }`.
5. Router, so wenig Last wie moeglich:
   - ohne Modell: Folge plausibel (Reihenfolge der Schritte, 2-48 Bilder, je
     Schritt mindestens 2, Zeit laeuft vorwaerts, 1,5 s bis 3 min);
   - **Stichprobe**, vom Router zufaellig gewaehlt: je Schritt ein Bild plus
     eins dazu. Wer faelschen will, muesste alle Bilder faelschen;
   - nur fuer die Stichprobe + Profilbild: YuNet + SFace (genau ein Gesicht,
     Kopfhaltung passt, dieselbe Person, Profilbild ueber der Schwelle);
   - im **eigenen Worker-Thread** (`server/verify-worker.js`), der Router
     bleibt ansprechbar (gemessen: hoechstens 6 ms Verzoegerung); Modelle nur
     waehrend Pruefungen im Speicher, nach 5 Minuten Leerlauf entladen;
   - gemessen 2026-11-20: ca. 0,8 s je Pruefung (erste 1,6 s mit Laden).
   - danach Bilder und Merkmale verwerfen, nur "ok/abgelehnt" ins Log.
6. Ergebnis: signierter Haken des Routers
   `{ subject, avatarSha256, issuedAt, expiresAt (90 Tage) }` (ECDSA P-256,
   eigener Router-Schluessel, oeffentlicher Teil in `/api/config`). Der Router
   merkt sich nur `peerId -> gueltig bis` (fuer das Grid).
7. Der Haken reist im Dating-Profil mit (`verified`). Empfaenger pruefen
   Signatur, Ablauf und dass `avatarSha256` zum aktuellen `avatarFull` passt.
   Neues Profilbild = Haken weg, neu pruefen.

Grenzen: ein abgespieltes Video einer anderen Person vor der Kamera kommt
durch (dafuer spaeter ein Anti-Spoofing-Modell oder V5 mit Attestierung).

## Regeln beim Empfaenger (P2)

- Einstellung im Dating: "Nur verifizierte Profile duerfen mir schreiben"
  (zurueckhalten wie die Chat-Regeln, Hinweis beim Absender), Router-Standard
  per `CLIENT_DEFAULTS`.
- Grid-Filter "nur verifiziert"; Haken an Karte und Profil.

## Phasen

| Phase | Inhalt |
|---|---|
| V1 (fertig) | Router: Modul `verify` (aus per Standard, `VERIFY=on` + Modelle), Modelle laden (onnxruntime-web), Sitzungen, Pruefung, Router-Schluessel, signierter Haken, Grenzen; Tests mit ersetzter Modell-Schicht |
| V2 (fertig) | Client: Ablauf mit Frontkamera und Schritten, Zustimmung, Upload, Ergebnis; Haken im eigenen Profil speichern und mitschicken |
| V3 (fertig) | Haken pruefen und zeigen (Profil, Grid-Karte, Chat-Kopf), Grid-Filter |
| V4 (fertig) | Regel "nur Verifizierte duerfen mir schreiben" |
| V5 | App mit Attestierung: Pruefung auf dem Geraet statt auf dem Router (nach ANDROID-APP.md Phase 4) |

## Offen

- Schwelle und Gueltigkeit (Vorschlag: SFace-Kosinus 0,363, 90 Tage) nach
  ersten echten Versuchen nachstellen.
- Zusaetzlicher Schutz gegen Bildschirm/Foto vor der Kamera (z. B. ein
  Anti-Spoofing-Modell) erst, wenn die Kopfhaltung nicht reicht.
- Rechtstext der Zustimmung (biometrische Verarbeitung) mit dem Betreiber.
