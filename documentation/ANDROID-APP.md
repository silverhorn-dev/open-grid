# Android-App fuer OpenGrid: Plan

Stand: 2026-11-01. Plan fuer Board T4 und die Backlog-Ideen "real application for
android". Noch kein Code; erst Entscheidungen (Abschnitt "Offene Entscheidungen"),
dann Phase fuer Phase.

## Ziel

Eine schlanke Android-App, die die OpenGrid-PWA des eigenen Routers anzeigt und
ihr koennen gibt, die der Browser nicht hat:

1. Bildschirmfotos und -aufnahmen sperren.
2. Push ohne Browser und ohne Google (Akku, Hintergrund).
3. Nachweisen, dass die App echt und unveraendert ist (signierte Anfragen),
   z. B. damit Bilder und Videos nur an solche Apps gehen.
4. Eine native Schnittstelle, um Nachrichten im Hintergrund oder offline zu
   senden und zu empfangen (spart Akku gegenueber einer dauernd offenen PWA).

Die PWA bleibt das Hauptprodukt (Regel 4): alles geht weiter im Browser, die App
ist ein optionaler Zusatz. Ohne App bleibt alles wie heute.

## Grundsatzfrage: TWA oder eigene WebView

| | Trusted Web Activity (TWA) | Eigene WebView-App |
|---|---|---|
| Was | Chrome zeigt die PWA im Vollbild | eigene Activity mit Android-WebView |
| Bildschirmfotos sperren (`FLAG_SECURE`) | nein (Fenster gehoert Chrome) | ja, ganz oder nur fuer Medienansichten |
| Bruecke JS <-> App | kaum (Custom-Tabs-postMessage, eingeschraenkt) | ja (`WebViewCompat.addWebMessageListener`, nur fuer den eigenen Router-Ursprung) |
| Web Push | ja (ueber Chrome) | nein (WebView kann kein Web Push) -> nativ |
| Service Worker, IndexedDB, WebRTC, Kamera | ja | ja (Rechte ueber die App) |
| Passkeys (Admin-Panel) | ja | ja, ueber androidx.webkit (zu pruefen: Mindestversion) |
| Digital Credentials API (EUDI-Wallet) | ja | zu pruefen |
| Aufwand | klein | mittel |

**Empfehlung: eigene WebView-App.** Ohne sie gehen weder `FLAG_SECURE` noch die
Bruecke; das sind die eigentlichen Gruende fuer die App. Web Push ersetzt die App
nativ (siehe Phase 3).

Wichtig: Die WebView speichert ihre Daten (IndexedDB, Schluessel) getrennt vom
Browser. Wer von der PWA zur App wechselt, hat dort zunaechst eine neue
Identitaet. Einen Export/Import gibt es noch nicht; Umzug siehe Entscheidung 7.

## Phasen

### Phase 1: Huelle (WebView)

- Erster Start: Router-Adresse eingeben oder QR-Code scannen (der Router zeigt
  ihn im Admin-Panel bzw. auf der Info-Seite); danach laedt die App nur diesen
  Ursprung. Fremde Links oeffnen im Browser.
- `FLAG_SECURE` fuer das ganze Fenster (Standard) oder nur, solange die PWA es
  verlangt (Phase 2).
- Rechte: Kamera, Mikrofon, Standort (fuer den Geohash), Dateiauswahl,
  Benachrichtigungen; `WebChromeClient.onPermissionRequest` nur fuer den Router.
- WebRTC, Service Worker (Offline-App-Shell), Zurueck-Taste an die PWA
  (`history.back`), Deep Links `/invite#...` und `/age-callback`.
- Die PWA erkennt die App an einer Kennung im User-Agent bzw. an der Bruecke
  (`window.OpenGridNative`), sonst verhaelt sie sich wie heute.
- Verteilung (Regel 4, keine App-Stores): APK direkt vom Router
  (`/app/opengrid.apk`, Link auf der Info-Seite), optional F-Droid. Updates:
  die App vergleicht ihre Version mit `/api/config` und bietet das neue APK an.

### Phase 2: Bruecke (PWA <-> App)

- `addWebMessageListener` mit genau einem erlaubten Ursprung (der Router).
  Nachrichten mit `type` und `id`, Antworten per Promise in der PWA.
- Erste Funktionen: `secureScreen(on|off)` (z. B. nur in Snaps, Alben, Bildern),
  `capabilities()`, Teilen-Ziel (Bilder aus anderen Apps, wie heute
  `share_target`), Haptik.
- Nichts davon bekommt Klartext ausser dem, was die Funktion braucht.

### Phase 3: Push ohne Browser (UnifiedPush)

- WebView kann kein Web Push; die App empfaengt Push nativ.
- Empfehlung: **UnifiedPush** (offener Standard, z. B. ntfy als Verteiler, auch
  selbst gehostet), kein Google. UnifiedPush-Endpunkte nehmen dieselben
  verschluesselten Web-Push-Nachrichten (RFC 8291/aes128gcm) an, die der Router
  heute schon verschickt (`server/push.js`): Server-seitig fast nichts Neues,
  nur der Endpunkt kommt von der App statt vom Browser.
- Optional zusaetzlich FCM (Google), nur wenn der Betreiber es will (Regel 1:
  Push ueber Anbieter ist ok, solange der Inhalt verschluesselt und minimal ist,
  Entscheidung 2026-10-22).
- Anzeige wie heute: Variante A/B nach "Kompakte Meldung" (Board T4, entschieden
  2026-10-27): kompakt = die App bekommt nie Schluessel und zeigt nur "Neue
  Nachrichten"; Vorschau = die App bekommt die noetigen Schluessel im Android
  Keystore und entschluesselt Name + Vorschau.

### Phase 4: Echtheitsnachweis (signierte Anfragen)

- **Android Key Attestation**: die App erzeugt im sicheren Speicher (TEE bzw.
  StrongBox) ein Schluesselpaar; Android liefert dazu eine Zertifikatskette
  (Wurzel: Google-Attestation-CA) mit Paketname, Signatur-Zertifikat der App,
  Version und Zustand des Geraets (verified boot).
- Der Router prueft die Kette einmal bei der Registrierung, ohne pro Anfrage
  einen fremden Dienst zu fragen: Wurzelzertifikate fest hinterlegt,
  Sperrliste von Google (oeffentliche JSON-Datei, taeglich, wie die EU-Liste
  fuer Altersnachweise). Erwartet werden der Paketname und der Fingerabdruck
  des APK-Signaturschluessels (vom Betreiber eingestellt).
- Danach signiert die App Anfragen (z. B. Registrierung, Push-Anmeldung) mit
  diesem Schluessel; der Router merkt sich "Peer nutzt die echte App".
- **Nicht Play Integrity**: braucht pro Pruefung einen Aufruf bei Google und
  ein Google-Konto des Betreibers (Regel 1).
- Grenzen: belegt die echte App auf einem unveraenderten Geraet, nicht den
  Inhalt der WebView. Die PWA kommt vom eigenen Router (gleicher Ursprung);
  wer die Inhalte zusaetzlich pruefen will, kann die App-Dateien spaeter ins
  APK packen (eigene Entscheidung).

### Phase 5: Bilder und Videos nur an die echte App

- Einstellung beim Absender: "Bilder und Videos nur an Empfaenger mit der
  OpenGrid-App" (nicht fuer Profildaten, Sprachnachrichten und Secure-Stream-
  Snaps, laut Backlog).
- Woher der Absender das weiss: der Router stellt fuer Peers mit gepruefter
  App ein signiertes Ticket aus (`appAttested`, Ablauf), das im
  Schluesselaustausch mitgeht; der Absender prueft die Router-Signatur.
- Der Router kann die Funktion per Standard abschalten (Backlog:
  `CLIENT_DEFAULTS`), z. B. fuer Server ohne App.

### Phase 6: Senden/Empfangen im Hintergrund (Board T4)

- Ausgehend: die PWA gibt der App schon verschluesselte Nachrichten
  (Pfad-C-Ciphertext, Empfaenger, `msgId`); die App liefert sie ueber
  `/api/cache` und Push aus und meldet den Stand zurueck. Kein Klartext.
- Eingehend: Push weckt die App, sie holt den Ciphertext aus `/api/cache` und
  legt ihn ab; beim Oeffnen uebernimmt die PWA ihn (wie heute der Service
  Worker, `MESSAGE_PUT`). Mit Variante B zeigt die App Name und Vorschau.
- P2P im Hintergrund (natives WebRTC) erst, wenn noetig: doppelte Logik.

## Entscheidungen

Entschieden 2026-11-01 (Nutzer):

1. **Art der App**: eigene WebView-App.
2. **Verteilung**: beides, APK vom eigenen Router und F-Droid.
3. **Signatur**: das Projekt signiert seine APKs (Standard-Fingerabdruck im
   Router); Betreiber koennen weitere Signatur-Schluessel eintragen (eigene
   Builds), z. B. Router-Einstellung `ANDROID_APP_SIGNERS` (Liste von SHA-256),
   live im Admin-Panel.
6. **Bildschirmfotos**: nur in Medienansichten (Snaps, Alben, Bilder im
   Betrachter und im Chat), in Profilen aus dem Grid und im Flirt-Modus; die
   PWA schaltet `FLAG_SECURE` dort ueber die Bruecke ein und beim Verlassen aus.

Noch offen:

4. **Push**: nur UnifiedPush oder zusaetzlich FCM? (Besprechung, siehe Chat)
5. **Echtheitsnachweis**: Android Key Attestation? (Erklaerung offen)
7. **Umzug PWA -> App**: wann und wie? (Vorschlag offen)

## Reihenfolge (Vorschlag)

Phase 1 + 2 zusammen (sichtbarer Nutzen: keine Screenshots), dann 3 (Push),
dann 4 + 5 (Echtheit), zuletzt 6. Jede Phase einzeln nutzbar.

Code liegt in einem eigenen Ordner `android/` im Repo (Kotlin, Gradle); Build
im Docker-Container wie die Tests, damit niemand ein Android-SDK lokal braucht.
