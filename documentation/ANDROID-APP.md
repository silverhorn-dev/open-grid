# Android-App fuer OpenGrid: Plan

Stand: 2026-11-01. Plan fuer Board T4 und die Backlog-Ideen "real application for
android". Phase 1 + 2 sind als Code da (`android/`, `client/app/native.js`,
`server/android-app.js`, Details in `SPECE.md` 9.0a), aber noch nicht gebaut
und nicht auf einem Geraet geprueft.

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
- Router hinter Cloudflare Access (Tunnel mit Zugriffsregeln, z. B. E-Mail-Code):
  die Anmeldeseite (`https://*.cloudflareaccess.com`) bleibt in der WebView,
  damit das Anmelde-Cookie dort landet und die Weiterleitung zurueck zum Router
  in der App ankommt (Bruecke und Rechte weiter nur fuer den Router). Die
  Update-Pruefung laeuft erst, wenn der Router geladen ist, und schickt das
  Cookie der WebView mit. Der APK-Download oeffnet im Browser und braucht dort
  dieselbe Anmeldung. Google als Anmeldeweg geht in WebViews nicht (Google
  sperrt eingebettete Anmeldungen).

### Phase 2: Bruecke (PWA <-> App)

- `addWebMessageListener` mit genau einem erlaubten Ursprung (der Router).
  Nachrichten mit `type` und `id`, Antworten per Promise in der PWA.
- Erste Funktionen: `secureScreen(on|off)` (z. B. nur in Snaps, Alben, Bildern),
  `capabilities()`, Teilen-Ziel (Bilder aus anderen Apps, wie heute
  `share_target`), Haptik.
- Nichts davon bekommt Klartext ausser dem, was die Funktion braucht.

### Hintergrund und Benachrichtigungen (umgesetzt 2026-11-11, App 0.2.0)

- Die WebView kann weder Web Push noch die Notification-API. Die PWA zeigt
  Benachrichtigungen deshalb ueber die Bruecke (`notify { title, body, tag,
  peerId }`), nativ im Kanal "Nachrichten"; Antippen oeffnet den Chat
  (Ereignis `openChat`). Nur wenn die Seite nicht sichtbar ist, nach den
  Schaltern je Art; "Kompakte Meldung" (Standard an) schickt nur "Neue
  Nachrichten". Ausloeser: neue Nachricht eines anderen (`storage.js`) und
  alles, was `notifyInApp` meldet (Match, Flamme, Adden, Profilbesuch ...).
- Recht: Android 13+ fragt die App beim ersten Start nach `POST_NOTIFICATIONS`;
  danach ueber Einstellungen > Benachrichtigungen (`notifications { request }`),
  nach zweimal Ablehnen oeffnet sie die System-Einstellungen.
- Aktiv bleiben (`KeepAliveService`, Vordergrund-Dienst `specialUse` mit
  stiller Meldung und "Beenden"): beim Verlassen startet er fuer die
  eingestellte Dauer (Einstellungen > Benachrichtigungen, nur in der App:
  aus / 15 min / 1 h (Standard) / 4 h / 8 h / immer; `background { minutes }`).
  Die WebView ueberlebt dabei auch das Wegwischen der App (`WebViewHolder`,
  `MutableContextWrapper`) und wird beim Oeffnen ohne Neuladen weiter genutzt;
  ihr Renderer bleibt "wichtig" (`RENDERER_PRIORITY_IMPORTANT`). So bleiben
  Router-Verbindung, P2P (Profilbilder, Originale), Abgleich und
  Benachrichtigungen aktiv. Bei "immer" fragt die App nach dem Abschalten der
  Akku-Optimierung, sonst trennt Android im Ruhezustand (Doze) das Netz.
- Grenzen: nach "Beenden", Ablauf der Dauer, Neustart des Handys oder wenn das
  System den Dienst beendet, gibt es keine Benachrichtigungen mehr (dafuer
  Phase 3). Die stille Meldung des Dienstes ist Pflicht (Android).

### Kern im Hintergrund (Variante B, entschieden 2026-11-11, Plan)

Ziel (Nutzer): die App ist der Nachrichten-Client im Hintergrund. Kommt eine
Nachricht, nimmt die App sie an und reicht sie an die Web-App weiter; schliesst
man die App, wird die Oberflaeche (PWA) entladen, der Nachrichten-Teil bleibt
online (P2P, Profilbilder ausliefern, Abgleich, Benachrichtigungen).

Entschieden: **kein** nativer Nachbau (Kotlin, eigenes WebRTC, doppelte
Protokoll-Logik) und **kein** lokaler HTTP-Server (127.0.0.1 waere fuer jede
App und Webseite auf dem Geraet erreichbar). Stattdessen laeuft der vorhandene
JS-Code in zwei Rollen:

- **Kern** (`/core.html`, unsichtbare WebView im Dienst der App): Router-WS
  (Registrierung, Signaling, Praesenz), WebRTC/P2P, Krypto (inkl. Forward
  Secrecy), Pfad C, Chat-Operationen und Abgleich, Gruppen, Geraete, Schwarm
  (Profile, Originale), Benachrichtigungen ueber die Bruecke. Keine Oberflaeche.
- **Oberflaeche** (`/`, die bekannte PWA in der App): zeigt an, nimmt Eingaben
  an, Kamera/Editor. Baut selbst keine Verbindungen auf; Transport geht an den
  Kern.
- **Voll** (Browser ohne App, wie heute): beides in einer Seite, nichts aendert
  sich.

Beide Seiten haben denselben Ursprung in derselben App: sie teilen IndexedDB
(also auch die nicht exportierbaren Schluessel) und den Service Worker. Die
Verbindung zwischen ihnen ist ein `BroadcastChannel` (nur innerhalb des
Ursprungs, von aussen nicht erreichbar); die Bruecke zur App bleibt fuer
Benachrichtigungen und Lebenszyklus.

Schnittstelle Oberflaeche <-> Kern (`BroadcastChannel('opengrid-core')`,
versioniert):

- Anfragen der Oberflaeche (RPC mit `id`, Antwort/Fehler): an der heutigen
  Transport-Naht, z. B. `sendSecurePayload`, `initiateP2PConnection`,
  `requestMissingOriginals`, `requestMissingProfile`, Secure-Snap-Stream
  oeffnen, Praesenz abonnieren, Grid-Anmeldung/Sichtbarkeit.
- Ereignisse des Kerns: `chat-changed { peerId }` (Oberflaeche liest den Chat
  neu aus IndexedDB), `profile-changed`, `presence`, `connection { peerId,
  state }`, `toast`, `original-progress`, Secure-Snap-Bilder, Gruppen/Geraete
  geaendert.
- Herzschlag: die Oberflaeche meldet "sichtbar"; ohne Oberflaeche (oder
  unsichtbar) zeigt der Kern Benachrichtigungen ueber die Bruecke.
- Rueckfall: antwortet kein Kern (z. B. Dienst aus), arbeitet die Oberflaeche
  als "Voll" wie heute.

Phasen:

| Phase | Inhalt |
|---|---|
| K1 | **Erledigt 2026-11-11.** Rollen `full`/`core`/`ui` (`APP_ROLE` in `config.js`, aus `<html data-role>`), Kern-Seite `/core.html` = dieselbe App-Shell mit `data-role="core"` (gleiche CSP, im Precache, offline eigene Shell im Service Worker). Abweichung vom Plan: keine eigene Skriptliste; der Kern laedt alles und rendert in ein unsichtbares DOM, so muss der Transport-Code nicht sofort entkoppelt werden (Verschlanken spaeter, K5). Kern: arbeitet immer (`isAppActive()` statt "Seite sichtbar" fuer Signaling-Pruefung, Grid-Abruf und -Anmeldung), ohne eigenes Profil bleibt er still (kein Einrichten), kein Nacktbild-Modell. E2E `core-role`: Kern allein empfaengt und speichert (P2P), liefert das Profil aus, sendet. |
| K2 | Schnittstelle: Kanal, RPC, Ereignisse, Herzschlag, Rueckfall; Rolle `ui` nutzt sie. E2E simuliert die App mit zwei Seiten im selben Browser-Kontext (`core.html` + `/`). |
| K3 | Live-Funktionen ueber den Kern: Secure-Snap-Stream, Fortschritt der Originale, Praesenz/Tippen/Chat-Fokus, Alben-Schluessel, Status, Sprach-Rest, Geraete-Kopplung. |
| K4 | **Kern auf Abruf** (Nutzer 2026-11-11: kein dauerhaft laufender Browser). Dauerhaft laeuft nur ein kleiner nativer Posteingang (Router-WS im Modus "erreichbar", spaeter alternativ UnifiedPush), keine JS-Engine. Er weckt die Kern-WebView, wenn etwas ansteht (Nachricht im Zwischenspeicher, P2P-Angebot, Profil-/Original-/Snap-Anfrage); der Kern arbeitet und schlaeft nach einigen Minuten Ruhe wieder (WebView zerstoert). Oberflaechen-WebView wird beim Schliessen zerstoert (`WebViewHolder`/Keep-Alive aus 0.2.0 entfaellt). Einstellung "Im Hintergrund erreichbar" (Standard immer), Akku-Optimierung, Start nach Neustart. Service-Worker-Update: Kern laedt beim naechsten Wecken neu. |
| R1 | Router "erreichbar + wecken": Posteingang meldet sich als `reachable` (nicht `online`: Praesenz "erreichbar", P2P-Versuche ohne sofortigen Rueckfall); P2P-Angebote und Signaling an einen schlafenden Peer haelt der Router kurz fest (z. B. 30 s), schickt dem Posteingang `WAKE` und stellt sie zu, sobald der Kern verbunden ist. Absender warten bei "erreichbar" laenger auf den direkten Kanal (z. B. 20 s), bevor sie Pfad C nehmen; Pfad C bleibt Rueckfall. |
| K5 | Messen auf Geraeten (RAM, Akku, Hersteller mit aggressivem Beenden), Feinschliff. |

Entschieden (Nutzer, 2026-11-11): "Im Hintergrund erreichbar" standardmaessig
**immer**; nach einem Neustart des Handys startet der Kern automatisch; eine
Datenquelle (dieselbe IndexedDB fuer beide Seiten), die Oberflaeche schreibt
eigene neue Nachrichten und gibt nur das Senden an den Kern, alles Eingehende
schreibt der Kern.

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

4. **Push**: UnifiedPush (Standard; ntfy als Verteiler in der Doku bzw. im
   Compose-Beispiel empfehlen, ggf. ein einfacher Verteiler in der App). Kein
   FCM, hoechstens spaeter, falls Nutzer ohne Verteiler nicht zurechtkommen.
5. **Echtheitsnachweis**: Android Key Attestation (kein Play Integrity).
7. **Umzug PWA -> App**: per QR-Code (eigene Phase direkt nach Phase 1 + 2, vor
   der Bekanntmachung der App):
   - PWA: "Auf App uebertragen" zeigt einen QR-Code mit Einmal-Schluessel.
   - Die App scannt ihn, beide verbinden sich direkt (WebRTC wie Chats, der
     Router vermittelt nur den Aufbau).
   - Uebertragen werden Identitaet, Schluessel, Chats und Profile,
     verschluesselt mit dem Einmal-Schluessel; danach fragt die PWA, ob sie
     ihre Kopie loescht (eine Identitaet soll nicht doppelt laufen).
   - Derselbe Weg dient als "Handy zu neuem Handy".
   - Zukunft: geplant ist ein Mehrgeraete-Betrieb (z. B. PC und Handy oder zwei
     Handys gleichzeitig, Backlog). Der Uebertrag soll dazu passen: das
     Datenformat und die Kopplung per QR so bauen, dass sie spaeter auch fuer
     ein zweites, gleichzeitig aktives Geraet taugen (nicht nur "umziehen und
     loeschen").

## Reihenfolge (Vorschlag)

Phase 1 + 2 zusammen (sichtbarer Nutzen: keine Screenshots), dann 3 (Push),
dann 4 + 5 (Echtheit), zuletzt 6. Jede Phase einzeln nutzbar.

Code liegt in einem eigenen Ordner `android/` im Repo (Kotlin, Gradle); Build
im Docker-Container wie die Tests, damit niemand ein Android-SDK lokal braucht.
Der Ordner bleibt eigenstaendig (keine Pfade ausserhalb), und die Bruecke
traegt eine Protokollversion; so liesse sich die App spaeter in ein eigenes
Repository verschieben. Jenkins baut das APK vorerst nicht (zu schwach).

## Bauen

- `sh android/build.sh` baut ein Debug-APK (Debug-Schluessel) in Docker
  (`android/Dockerfile`: JDK 17, Gradle, Android-SDK 34; Gradle-Cache im
  Volume `opengrid-android-gradle`). Ergebnis: `android/dist/opengrid.apk`
  und `opengrid.apk.json` (Version), zum Ausliefern nach `ANDROID_APK_PATH`
  kopieren.
- `sh android/build.sh release` signiert mit `OPENGRID_KEYSTORE`
  (+ `OPENGRID_KEYSTORE_PASSWORD`, `OPENGRID_KEY_ALIAS`, `OPENGRID_KEY_PASSWORD`).
  Schluessel nie ins Repository.
- Platzbedarf: Image etwa 1,5 GB plus Gradle-Cache.
- Eigene Builds mit App-Links fuer die eigene Domain:
  `gradle -Popengrid.appLinkHost=grid.example.org ...`; dazu den Fingerabdruck
  des eigenen Schluessels in `ANDROID_APP_SIGNERS` eintragen.

## Noch offen in Phase 1 + 2

- Projekt-Release-Schluessel anlegen und seinen Fingerabdruck in
  `PROJECT_APP_SIGNERS` (`server/android-app.js`) eintragen.
- QR-Code `opengrid://connect?url=...` im Admin-Panel bzw. auf der Info-Seite
  zeigen (die App nimmt den Link schon an).
- Altersnachweis mit Weiterleitung (OIDC, Wallet): der Anbieter oeffnet im
  Browser; zurueck in die App kommt `/age-callback` nur mit verifiziertem
  App-Link (eigener Build mit `appLinkHost`). Loesung fuer die Projekt-App
  offen (z. B. Custom Tab und Rueckweg ueber `opengrid://open`).
- Benachrichtigungen ohne laufende App (komplett beendet, nach Neustart des
  Handys): erst mit Phase 3 (UnifiedPush). Solange der Hintergrund-Dienst
  laeuft, kommen sie schon (siehe "Hintergrund und Benachrichtigungen").
- Erster Build und Pruefung auf einem Geraet (Kamera, WebRTC, Service Worker,
  `FLAG_SECURE`, Teilen).
