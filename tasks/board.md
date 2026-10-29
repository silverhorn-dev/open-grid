# bugs

- [x] discovering of new social chats happens just on klick on profile?
  - ursache: profil kommt nur ueber eine P2P-sitzung; erste nachricht ueber router-cache/push baut keine auf, erst der klick (PROFILE_REQUEST) tat es
  - fix 2026-10-26: `requestMissingProfile` (storage.js) bei neuem chat und wenn der peer online kommt (direkt, startet P2P) + schwarm-abfrage; je weg max. 1x/min; e2e `new-chat-profile`
- [x] u can swipe a message but the animation just comes at the first time?
  - ursache (wahrscheinlich): der kleine aktionen-pfeil sitzt oben links auf fremden nachrichten, genau wo der daumen ansetzt; ein wischen, das dort startet, wurde komplett ignoriert -> wirkte zufaellig
  - fix 2026-10-26: wischen startet in der ganzen zeile (auch auf dem pfeil, der dann nicht aufklappt), pointer capture; e2e `chat-gestures` (mobil, echte touch-events, 3x hintereinander)



# Runde T (2026-10-26)

## T1 Bereich beim Onboarding: Nur Entdecken / Social / Entdecken & Freunde
- [x] Wenn man sich initial einloggt sollte man zwischen social, entdecken und beides auswählen können und dann erst in einer ganz verschachtelten Einstellung enable all wieder alle anschalten können.
  - entschieden 2026-10-26 (nutzer):
    - Nur Entdecken = Grid + Event; Flamme -> Match -> Chat; kein Adden, auch nicht nach einem Match; nur Liste "Grid & Event", kein Listen-Wechsel
    - Social = Chat + Freunde; Grid ja (Freunde-Grid, nur Kontakte), kein Matching (keine Flamme); nur Adden; nur Liste "Chat & Freunde"
    - Entdecken & Freunde = alle 4 Modi, wie heute (Flamme in Grid/Event, Adden nach Match optional)
  - plan: `keys`/`app-mode` bekommt `scope` (`discovery` | `social` | `all`); fehlt er (bestehende Nutzer) = `all`
  - plan: onboarding-schritt mit den 3 karten; entfaellt, wenn `APP_MODES` nur einen bereich erlaubt (dann dieser)
  - plan: erlaubte modi = `APP_MODES` ∩ bereich; menue-chips, modus-auswahl, listen-wechsel und `modeForChatScope` nutzen das
  - plan: einstellungen und knoepfe mit `data-scope="discovery|social"`; ausgeblendet, wenn der bereich aus ist
    - nur Entdecken blendet aus: status, freunde-sichtbarkeit, "Matches koennen mich adden", listen-wechsel, chat-&-freunde-einstellungen
    - Social blendet aus: flamme/match, event-code, "Grid & Event"-chat-einstellungen, grid "mehr laden"; ort/radius/sichtbarkeit bleiben (freunde-grid)
  - plan: nur Entdecken -> `canAddMatch()` immer false, eigenes profil sendet `allowMatchFriends: false` (gespeicherter schalterwert bleibt fuer spaeter)
  - plan: Einstellungen > Allgemein > Erweitert: bereich aendern + schalter "Alle Modi anzeigen" (= Entdecken & Freunde)
  - plan: tests (erlaubte modi je bereich, canAddMatch, payload-flag), e2e onboarding + ausgeblendete einstellungen; SPECE/USE-CASE/README
  - done 2026-10-26: `scope` in `keys`/`app-mode`, `effectiveModeScope`/`scopeIncludes`/`setModeScope` (modes.js), `data-scope` + `.scope-hidden`, onboarding-karten, Erweitert in der App-Modus-karte; tests `test/modes.test.js`, `test/friends.test.js`, e2e `mode-scope`; UC-45

## T2 Alter / E-Mail pruefen (erst besprechen)
- [ ] for security reasons we need to verify email or age, what u think
  - nutzer 2026-10-26:
    - beides muss auf dem router (betreiber) konfigurierbar sein; in der EU / besonders Deutschland gibt es strenge regeln (jugendschutz)
    - alters-pruefung ueber einen drittanbieter soll moeglich sein, ohne bezug zu den nutzerdaten (so etwas wie bei OnlyFans gesehen)
    - e-mail: wenn jemand deine fotos weitergibt und du findest den nutzer (wasserzeichen), hilft dir das heute nichts -> es braucht eine erreichbare/verantwortliche identitaet
  - offen: welche anbieter (datensparsam, nur "ja, 18+" als signiertes token), wo liegt die e-mail (nur beim betreiber, gehasht?), wie passt das zu "kein konto" und regel 1 (keine externen datendienste)
  - offen: einfaches 18+-bestaetigen im onboarding als minimum (`REQUIRE_AGE_CONFIRM`)
  - entschieden (nutzer 2026-10-29): alle wege ausliefern, damit es rechtlich passt: EU-Wallet/EU-Altersnachweis UND andere anbieter (z. B. KJM-anerkannte) UND e-mail; der betreiber waehlt per konfiguration, was gilt (mehrere gleichzeitig moeglich)
  - diskussion 2026-10-26 (stand, noch nicht entschieden):
    - alter: router-konfig `AGE_CHECK=off|confirm|provider`; `confirm` = "ich bin 18+" im onboarding; `provider` = externer nachweis, router prueft nur ein signiertes "18+"-token und merkt sich "node X geprueft bis Y"
    - bevorzugt EU-Wallet (EUDI / EU-Altersnachweis): nur "18+" + pseudonym pro seite; das pseudonym entsteht in der wallet, der aussteller erfaehrt nicht, wo es gezeigt wird -> auch per gerichtsbeschluss keine zuordnung zur person (gewollt); bann auf das pseudonym haelt trotzdem (neues konto = gleiches pseudonym)
    - alternative zur wallet: e-mail als option (`EMAIL_CHECK=off|required`), bestaetigungslink; router speichert die adresse verschluesselt (betreiber-schluessel) + hash fuer bann-abgleich; herausgabe nur per beschluss; schwach gegen wegwerf-adressen
    - rueckverfolgung im ernstfall (foto-leak): optionales ip-protokoll `ABUSE_LOG_DAYS=0..14` (standard 0 = aus), node-id + ip + zeit, herausgabe nur per beschluss; info-seite nennt es offen
    - meldeweg: opfer meldet leak mit wasserzeichen-nachweis -> betreiber bannt node + pseudonym bzw. e-mail-hash
    - offen: anbieter-auswahl, rechtliche pruefung (JMStV/KJM, DSA), wie e-mail ohne externen mail-dienst verschickt wird (regel 1: smtp des betreibers?)
  - recherche 2026-10-26 (quellen meist sekundaer/anbieter-blogs, rechtlich nicht geprueft):
    - EU-Altersnachweis (ageverification.dev): mini-wallet bzw. teil der EUDI-Wallet, staaten sollen bis 31.12.2026 eine loesung anbieten (empfehlung, nicht bindend); pilotlaender u. a. FR, DK, GR, IT, ES, CY, IE, deutschland (noch) nicht dabei
    - liefert nur "ueber 18: ja/nein"; uebertragung per OpenID4VP / W3C Digital Credentials API; open-source verifier-backend vorhanden -> technisch selbst hostbar
    - ZKP (unverknuepfbarkeit) erst angekuendigt bzw. nur im geschlossenen prototyp; EFF: wiederverwendete tokens koennen verknuepfbar sein, aussteller koennte nutzung protokollieren
    - korrektur: ein festes pseudonym pro seite liefert der altersnachweis nicht sicher -> "bann haelt per pseudonym" ist offen
    - einige laender (IE, ES) verlangen eine registrierung als relying party; fuer selbst gehostete instanzen pruefen
    - DE: JMStV verlangt fuer jugendgefaehrdende inhalte eine geschlossene benutzergruppe mit KJM-anerkannter pruefung (selbstauskunft reicht nicht); keine quelle, dass dating-apps an sich darunter fallen -> haengt an den inhalten (snaps), anwalt fragen
    - KJM-anerkannte kommerzielle anbieter z. B. AgeGO, Mobbeel (sehen ausweis/gesicht)
    - Grindr (UK, Online Safety Act seit 25.07.2025): einmalige pruefung ueber FaceTec, video-selfie (alters-schaetzung) oder selfie + ausweis; daten laut Grindr danach geloescht; sonst konto per e-mail/telefon
    - Snapchat: konto per e-mail/telefon, geburtstag selbst angegeben + alters-erkennung aus signalen; AU (seit 11/2025, unter-16-verbot): bankkonto (ConnectID), ausweis oder selfie-schaetzung (k-ID), ~415k konten gesperrt; UK: "highly effective age assurance", >1 mio als 18+ bestaetigt (09/2026); behoerden bekommen bestandsdaten (nutzername, e-mail, telefon) + IP-daten per rechtsweg, sicherung 90 tage (+90)
    - IP-speicherung DE: kabinettsentwurf 22.04.2026, provider speichern IP + port 3 monate, nur zuordnung IP -> anschlussinhaber; anhoerung rechtsausschuss 07.10.2026, noch nicht beschlossen -> mit kurzem eigenem ip-protokoll waere rueckverfolgung ueber den normalen rechtsweg moeglich

- gebaut 2026-10-26 auf branch `feature/safety-checks`, am 2026-10-29 nach main gemerged (T2 bleibt ohne env aus), alles standardmaessig aus:
  - [x] router-konfig `AGE_CHECK=off|confirm|provider`, `AGE_PROVIDER` (nur `dev` zum testen), `EMAIL_CHECK=off|required`, `EMAIL_TRANSPORT` (nur `log`), `SAFETY_KEY`, `ABUSE_LOG_DAYS` (`server/safety.js`, `server/safety-store.js`)
  - [x] sperre: ohne nachweis registriert, aber unsichtbar und kein grid; gesperrte peers/e-mails/pseudonyme (HMAC); ip-protokoll mit loeschfrist
  - [x] client: nachweis-fenster (18+ bestaetigen, anbieter-knopf, e-mail-code), karte unter Privatsphaere (`client/app/safety.js`)
  - [x] betreiber-werkzeug `scripts/safety-admin.mjs` (sperren, ip-protokoll, e-mail entschluesseln)
  - [x] tests `test/safety.test.js`, e2e `safety-gate` (nur mit `E2E_SAFETY=1` gegen `AGE_CHECK=confirm`)
  - [ ] echter anbieter (EU-Altersnachweis per OpenID4VP oder KJM-anbieter) -> entscheidung
  - [x] SMTP-versand der codes (2026-10-29, nutzer: nodemailer, optional): `EMAIL_TRANSPORT=smtp`, `SMTP_URL`, `SMTP_FROM` (`server/email-smtp.js`), nodemailer in `optionalDependencies`, erst beim ersten versand geladen; fehlversand -> 502, code verworfen; tests `test/email-smtp.test.js`, `test/safety.test.js`; einmal echt gegen mailpit verschickt
  - [ ] meldeweg mit wasserzeichen-nachweis -> sperre (nur werkzeug da, kein UI)

## T3 Nacktbild-Erkennung beim Empfaenger (idee 2026-10-26, besprechen)
- [ ] lokales modell auf dem geraet des empfaengers erkennt nacktbilder in chat-bildern/snaps/alben -> unscharf + "trotzdem ansehen"; bild verlaesst das geraet nie (passt zu E2EE)
  - kontext: app ist nicht fuer nacktbilder gedacht (galerien, normale fotos) -> JMStV-pflichten fuer jugendgefaehrdende inhalte greifen wohl nicht; schutz gegen ungefragte bilder trotzdem sinnvoll
  - vorbild: Bumble "Private Detector" (2022 open source, kommerziell nutzbar; lizenz/framework im repo pruefen), Apple Communication Safety, Instagram-Nacktschutz
  - offen: modell selbst ausliefern (keine CDN, regel 1), groesse (einige MB, lazy laden, im SW-cache), tf.js/onnx im browser + leistung auf alten handys, standard an/aus, auch absender-seitig warnen?
  - grenze: nur schutz, keine durchsetzung (eigener client kann es abschalten); kein melden an den server
  - gebaut 2026-10-26 auf branch `feature/safety-checks`, am 2026-10-29 nach main gemerged (T2 bleibt ohne env aus), standardmaessig aus:
    - [x] `client/app/nudity.js`: einstellung Medien > Schutz (`keys`/`nudity-settings`, `CLIENT_DEFAULTS.nudityFilter`), modell-schnittstelle `registerNudityClassifier`, unscharf + "Tippen zum Ansehen" in `drawSecureImage` (chat, snaps, alben, status, viewer), eigene bilder nie
    - [x] tests `test/nudity.test.js`, e2e `nudity-filter` (test-modell)
    - [x] modell ausliefern (2026-10-29): NSFWJS MobileNetV2 vom router (`server/nudity-model.js`, routen `/vendor/nsfwjs/<version>/...`), router-konfig `NUDITY_MODEL` (nsfwjs|off), `NUDITY_THRESHOLD` (0.5-0.95, std 0.7), `NUDITY_CLASSES` (std Porn,Hentai) -> `/api/config.nudity`; web worker (`client/app/nudity-worker.js`) startet erst beim ersten bild bei eingeschaltetem filter; testseite im debug-modus (medien > schutz > "Erkennung testen"); tests `test/nudity-model.test.js`, e2e `nudity-filter` mit echtem modell
    - [x] nutzer-test 2026-10-29: MobileNetV2 erkennt ein maennliches nacktbild (badezimmer-selfie) nicht (Neutral 85 %, Porn+Hentai 1 %) -> alle drei nsfwjs-modelle ausgeliefert, `NUDITY_MODEL=nsfwjs|nsfwjs-mid|nsfwjs-inception`, auswahl auf der testseite zum vergleichen
    - [x] nutzer 2026-10-29: "male nudes are not very trained" -> beide staerkeren modelle optional ausliefern
      - `bumble` (Apache-2.0): SavedModel rechnet in float16, TF.js kann das nicht -> graph eingefroren, auf float32 umgeschrieben (abweichung 0.0), uint8-quantisiert (~51 MB, TF.js weicht < 0.002 ab); `scripts/nudity-models/convert-bumble.py`
      - `nudenet` 320n: GitHub-release braucht login -> aus dem PyPI-wheel nudenet 3.4.2 (sha256 fest); metadaten sagen MIT, die LICENSE-datei im wheel ist AGPL-3.0 -> als AGPL behandelt (passt zu GPL-3.0 von OpenGrid)
      - installation: `scripts/nudity-models/fetch.sh --volume <volume> nudenet bumble` -> `NUDITY_MODEL_DIR` (std data/nudity-models); `onnxruntime-web` optionale abhaengigkeit; nur der worker bekommt `'wasm-unsafe-eval'`; TF.js als ES2017-build (der ES5-build braucht `Function()`)
      - e2e (headless, ohne GPU): nudenet 1,2 s/bild, bumble 68 s/bild (CPU) -> auf dem handy mit WebGL messen
    - [ ] nutzer vergleicht nsfwjs-mid/-inception, bumble, nudenet mit echten bildern auf dem handy (treffer + zeit), danach `NUDITY_MODEL` + schwelle festlegen
    - [ ] nutzer testet auf dem handy mit echten bildern (maennliche nacktheit, fehlalarme bei badehose/oberkoerper), danach schwelle/klassen festlegen; falls zu schwach: Bumble Private Detector umwandeln
    - [ ] docker-image wird groesser (nsfwjs bringt alle drei modelle + tfjs mit); bei bedarf nur mobilenet_v2 + bibliothek ins image kopieren
    - [ ] absender-warnung vor dem senden -> entscheidung
  - recherche 2026-10-29 (primaerquellen: repos/model cards; leistung auf handys nicht gemessen):
    - **NSFWJS** (infinitered/nsfwjs): code MIT, modell aus GantMan/nsfw_model ebenfalls MIT; TF.js, laeuft im browser, modell selbst hostbar; MobileNetV2 224x224 ca. 2,6-3,5 MB, ~90 % genauigkeit (mid-modell ~93 %); klassen Drawing/Hentai/Neutral/Porn/Sexy; trainingsdaten aus nsfw_data_scraper (vermutlich ueberwiegend weibliche motive -> fuer eine app mit vielen schwulen nutzern muss maennliche nacktheit eigens getestet werden)
    - **Bumble Private Detector**: Apache-2.0, EfficientNet-v2, binaer "lewd", fuer ungefragte nacktbilder gebaut; nur als TF SavedModel -> wir muessten selbst nach TF.js/ONNX umwandeln und quantisieren; groesse und messwerte im repo nicht angegeben
    - **NudeNet v3**: erkennt koerperteile einzeln (u. a. MALE_GENITALIA_EXPOSED), ONNX, laeuft im browser; aber lizenz AGPL-3.0 und basiert auf Ultralytics YOLOv8 (ebenfalls AGPL, laut Ultralytics gilt das auch fuer trainierte modelle) -> lizenzrisiko, nicht ohne klaerung
    - **viddexa/nsfw-detection-2-nano**: Apache-2.0, EfficientNet, ONNX ueber onnxruntime-web moeglich; keine angaben zu daten/genauigkeit -> nur beobachten
    - laufzeit: onnxruntime-web/TF.js mit WASM+SIMD+threads im browser machbar; WebGPU auf mobil noch nicht verlaesslich; vorsicht bei dauerlast (hitze, drosselung)
  - empfehlung (vorschlag, nutzer entscheidet): start mit NSFWJS MobileNetV2 (MIT/MIT, klein, erprobt), modell + TF.js vom eigenen router ausliefern (keine CDN, regel 1), nur laden wenn der filter an ist, im SW-cache halten, im web worker rechnen; unscharf ab porn+hentai >= 0.7 ("sexy" nicht); vorher eigene testsammlung (auch maennliche motive) zur abschaetzung von fehlalarmen/treffern; Bumble als zweiter kandidat, falls die erkennung nicht reicht (umwandlung noetig)

## T4 Wrapper-App: native API zum Senden/Empfangen (wunsch 2026-10-27, erst planen)
- [ ] die wrapper-app (siehe backlog "real application for android") stellt der PWA eine API bereit, um bilder zu senden und zu empfangen, auch offline bzw. wenn die app im hintergrund ist; grund: dauernd geladene PWA zieht viel akku
  - idee: PWA erkennt die bruecke (z. B. `window.OpenGridNative` bzw. `postMessage`-kanal der WebView) und gibt ihr ausgehende, schon verschluesselte nachrichten (pfad-C-ciphertext + empfaenger + msgId); die app liefert sie im hintergrund aus (router-cache/push, spaeter P2P) und meldet den status zurueck
  - empfangen: app nimmt web-push/FCM im hintergrund an, holt ciphertext aus `/api/cache`, legt ihn in einen eigenen speicher; beim oeffnen uebernimmt die PWA ihn (wie heute der SW, `MESSAGE_PUT`)
  - ohne bruecke (normaler browser) bleibt alles wie heute
  - entschieden 2026-10-27 (nutzer): variante haengt an der einstellung "Kompakte Meldung" (`keys`/`push-settings.compactNotifications`)
    - kompakt an (standard) = variante A: app bekommt nie schluessel, reicht nur ciphertext weiter, meldung nur "Neue Nachrichten"
    - kompakt aus (vorschau gewuenscht) = variante B: app bekommt die noetigen schluessel und entschluesselt fuer name + vorschau
    - umschalten auf kompakt -> PWA weist die app an, alle schluessel sofort zu loeschen; nur ueber die bruecke, nie ueber den server
    - plan: schluessel in der app nur im geschuetzten speicher (Android Keystore), nie im klartext auf platte
  - offen: plattform (android zuerst? kotlin + WebView oder TWA), hintergrund-grenzen (WorkManager, doze), verhaeltnis zum service worker (doppelte zustellung vermeiden)
  - offen: api-vertrag versionieren (`apiVersion`), nur fuer signierte app (siehe backlog: signierte clients)

## T5 Teilen-Menues des Systems (ideen 2026-10-27)
- [x] teilen aus OpenGrid: installiert als app oeffnen teilen-knoepfe (einladungslink, chat-bilder im social-bereich) das native teilen-menue (Web Share API) statt kopieren/download
  - nutzer 2026-10-27: download bleibt, teilen kommt als zweite moeglichkeit dazu
  - done 2026-10-27: bildbetrachter "Teilen" neben "Speichern" (`canShareFiles`, `shareCanvasImage`, `shareViewerImage`), nur mit derselben freigabe wie speichern; einladungslink hatte schon kopieren + teilen; e2e `image-share`; UC-48 (UC-46/47 liegen auf `feature/safety-checks`)
- [x] videos auch speichern/teilen + einstellung "medien nur fuer freunde herunterladbar" (nutzer 2026-10-27; freunde = geaddete)
  - entschieden: einstellung des absenders, betreiber gibt den standard vor (`CLIENT_DEFAULTS.mediaDownload`)
  - done 2026-10-27: `client/app/media-rights.js` (`canDownloadMedia`, feld `downloadable` an bild-/video-nachrichten), bildbetrachter je bild, video-betrachter mit speichern/teilen; einstellung Medien > Schutz; tests `test/media-rights.test.js`, e2e `media-rights`, `voice-video`
- [x] teilen nach OpenGrid: OpenGrid erscheint im teilen-menue anderer apps (Share Target API im manifest), z. B. foto aus der galerie -> chat auswaehlen -> senden
  - done 2026-10-27: manifest jetzt unter `/manifest.webmanifest` mit `share_target`; SW `handleShareTarget` -> cache `opengrid-share-inbox` -> `/chat?share=1`; `client/app/share-target.js` ("Senden an", bilder als chat-bilder, text nur ins eingabefeld); `createChatPickerList` (chat-switch.js) geteilt mit dem quick-switcher; tests `test/server.test.js`, e2e `share-target`; UC-49
  - offen: nur installierte PWA; iOS unterstuetzt share target nicht

## T6 Bugs + Snap-Vorschau (2026-10-27)
- [x] when a video is in chat, sometimes it horribly flickers, wurde hier die media platzhalter funktion auch für videos umgesetzt?
  - ursache: platzhalter (groesse) gab es schon, aber jedes neuzeichnen des chats (waehrend einer video-uebertragung oft) legte neue, erst leere canvas an
  - fix 2026-10-27: gezeichnete canvas werden beim neuzeichnen weiterverwendet (`collectReusableSecureImages`, `reuseKey`, secure-canvas.js); gilt fuer bilder und video-vorschauen; e2e `media-rights`
- [x] when displaying the first view of a secure snap its very very short
  - ursache: erste neuverhandlung fuer den live-stream langsamer als 6 s -> sender stoppt den stream und schickt den schluessel; empfaenger hatte das video gerade gestartet und ignorierte den schluessel
  - fix 2026-10-27: grant gilt auch waehrend eines laufenden streams, anzeige wechselt aufs bild, die zeit laeuft weiter; e2e `secure-snap`
- [x] man kann sich seine eigenen secure snaps nicht mehr ansehen, das soll bei den eigenen wie bei den normalen funken
  - fix 2026-10-27: `openOwnSecureSnap` (lokal, ohne zeitlimit), solange der empfaenger noch ansichten hat
  - nutzer 2026-10-27: nur bis der empfaenger alle ansichten verbraucht hat, danach auch beim sender weg (schluessel + ciphertext geloescht)
  - nutzer 2026-10-27: dazu eine eigene frist, um ihn noch selbst zu speichern, einstellbar unter der snap-ablauf-einstellung
  - done 2026-10-27: "Eigene Snaps behalten" (sofort/15 min/1 h/24 h, standard 1 h, `CLIENT_DEFAULTS.ownSnapKeep`), gilt fuer einmal- und secure snaps (`ownKeepUntil`, `expireOwnKeptSnaps`); eigener secure snap mit "Speichern" (datei); e2e `secure-snap`
- [x] secure snaps werden auf dem endgeraet teilweise sehr klein dargestellt und sind nicht zoombar (nutzer 2026-10-27)
  - ursache: video/canvas nur in eigener pixelgroesse (max-w/max-h), der live-stream startet oft mit kleiner aufloesung
  - fix 2026-10-27: immer bildschirmfuellend (`w-full h-full object-contain`), pinch-zoom bis 5x + verschieben, mausrad am pc; e2e `secure-snap`
- [x] secure snaps bugs, when waiting for "Freigabe" on receiving a secure snap it waits forever, auch wenn der andere client wieder on ist
  - ursache: kein timeout nach SNAP_VIEW_REQUEST; ging die anfrage in einem halb toten kanal verloren, passierte nie etwas
  - fix 2026-10-27: nach 8 s kanal neu aufbauen und einmal erneut fragen, danach "Der Absender antwortet nicht"; e2e `secure-snap`
  - dabei gefunden: neues angebot nach einseitigem neuaufbau wurde abgelehnt (m-lines passten nach einem snap-stream nicht zur alten verbindung), aufbau hing ~16 s; fix `applyRemoteOffer` (p2p.client.js) verwirft die alte verbindung und antwortet frisch
- [x] on taken image / snap preview toggle for safeable
  - nutzer 2026-10-27: schalter neben den bearbeitungs-icons; download-icon mit kleinem kontakt-icon schraeg versetzt; angeklickt durchgestrichen + notiz "nicht speicherbar"; standard vom router, normal "speicherbar"
  - done 2026-10-27: `#snap-saveable-btn` (snaps.js `toggleSnapSaveable`, `snapSaveOptions`), `downloadable: 'none'`, `CLIENT_DEFAULTS.snapSaveable`; einmal-snap "Speichern" beim empfaenger ausgeblendet; e2e `snap-camera`

## T7 Bugs + Snap-Editor (2026-10-27)
- [x] on smartphone when swiping the profile bar in chat down, the messages especially the videos are in foreground and the bar in background, fix the y-or z-axis
  - ursache: kontaktleiste hatte nur am desktop einen z-index, mobil halb durchsichtig; nachrichten (video-vorschau mit eigenem stapel) lagen davor
  - fix 2026-10-27: `.chat-header` immer `z-index: 20`, beim ziehen deckend (`is-pulling`); e2e `chat-gestures` (mobil)
- [x] general swiping in snap / iamge preview or when taking photos, swiping up and to the sides is not good
  - nutzer 2026-10-27: galerie-wischen ging nur auf dem galerie-icon und dem ausloeser; seitlich snap/bild ging nicht; editor-gesten (skalieren, drehen) bitte mit zwei fingern: element = erst ein finger drauf, dann zweiter; hintergrund = beide
  - ursache seitlich: das typische wischen von rechts begann auf dem umschalt-knopf am rechten rand; in der vorschau gab es gar keine wisch-geste
  - fix 2026-10-27: leisten lassen gesten durch (`.snap-overlay`), hoch = galerie ueberall im kamerabild, wischen ab dem umschalt-knopf zaehlt, im editor ein finger seitlich = snap/bild; e2e `snap-editor-gestures` (mobil, echte mehrfinger-touches)
- [x] editing improvement
   - [x] emoties und text soll scalable sein, dafür muss man das item verschieben und dabei mit einem 2. Finger rein oder rauszoomen, am pc scrollen während man es dragt.
      - [x] dabei soll er auch drehbar sein, und jeweils bei 90 grad sn die achse snappen, also wenn er parallel zur seite oder dem boden ist.
      - done 2026-10-27: item `scale`/`rotation`, zweiter finger irgendwo, einrasten bei 90 grad (6 grad fangbereich, vibration); hintergrund mit zwei fingern zoomen/drehen/verschieben; pc: mausrad beim ziehen, shift = drehen; `flattenSnapDraft` mit transformationen
      - [x] verschiedene textarten
      - [x] opt. ein texthintergrund
      - done 2026-10-27: textart (klassisch, serif kursiv, mono, handschrift, neon) und hintergrund (keiner, abgedunkelt, voll) per knopf in der texteingabe
   - [x] die möglichkeit filter drüberzulegen, also s/W, farbenfroh, puff farben (rot), mit uhrzeit an verschiendenen stellen
      - [x] text nachbearbeiten und hintergrund-aenderungen rueckgaengig machen (nutzer 2026-10-27)
        - done 2026-10-27: ein tipp auf text = bearbeiten (vorbelegt), doppelt tippen = loeschen; rueckgaengig auch fuer hintergrund, filter, verschieben/skalieren/drehen, bearbeiten, loeschen; e2e `snap-editor-gestures`
      - done 2026-10-27: filter-leiste ueber der bildunterschrift (Original, S/W, Farbenfroh, Rot); uhrzeit als erster sticker im emoji-feld, frei verschieb-/skalier-/drehbar; tests `test/snap-editor.test.js`, e2e `snap-editor-gestures`
   - noch weitere ideen anmerkungen?
  - ideen dazu (vorschlag 2026-10-27, noch nicht bestaetigt): loeschen per ziehen auf einen papierkorb, textausrichtung, ortsfreie sticker (uhrzeit, wochentag)

## T8 Bug: Profil-Schemas vom Router (gefunden 2026-10-27)
- [x] `validateProfileSchema` (config.js) nahm nur Text-Labels an; die eingebauten Schemas haben `{de,en}` -> der Client verwarf alle Schemas vom Router, "Nur Chat" bekam nie Name + Status
  - fix 2026-10-27: Labels als Text oder je Sprache; `compose.yaml` reicht `PROFILE_SCHEMA` durch (`PROFILE_SCHEMAS` steht dort direkt, nutzer 2026-10-27; dabei `"String"` -> `"string"` und "Über" von ISO-8859-1 nach UTF-8 korrigiert); test `test/profile-schema.test.js` (router-standard -> client-pruefung)

## T9 Einladung + Album-Vorschau (2026-10-27)
- [x] einladung aus "Entdecken", geoeffnet im chat-modus: chat landete in der falschen liste
  - entschieden (nutzer): einladung traegt den modus; geht in dessen modus/liste; ist der bereich beim empfaenger aus, oeffnet sich nichts, nur "modus deaktiviert"
  - done 2026-10-27: link `#<peer>.<fingerprint>~<modus>`, `inviteTarget`, hinweis `modes.inviteModeDisabled`; tests `test/modes.test.js`, e2e `invite-modes`
  - [x] chat-sperre des einladenden ("Nur Matches") im entdecken-bereich
    - entschieden (nutzer 2026-10-28): sperre bleibt, auch fuer eingeladene (erst flamme/match)
    - done 2026-10-28: ohne bekanntes profil bleibt die eingabe in "Grid & Event"-chats gesperrt ("Profil wird geladen"), profil wird aktiv angefragt; danach zeigt der hinweis die sperre statt still zurueckgehaltener nachrichten; test `test/matching.test.js`
- [x] album: besitzer waehlt die vorschau (normal / unscharf / keine)
  - done 2026-10-27: `album.preview`, "Vorschau im Chat" in der album-karte, unscharf beim besitzer gerechnet; e2e `album-preview`; UC-50

## T10 Album-Schluessel: 1 Woche und pro Person (nutzer 2026-10-27)
- [x] gueltigkeit der album-schluessel auch "1 Woche" (2 wochen verworfen)
- [x] gueltigkeit pro person ueberschreibbar
  - done 2026-10-27: `ALBUM_KEY_EPOCH_OPTIONS` + 10080 (album, einstellungs-standard, `CLIENT_DEFAULTS`), `album.viewerKeyEpochs`, auswahl neben jeder person; rollende keys pro epochenlaenge (`<epochMs>:<epoch>`), damit verschiedene laengen nicht kollidieren; tests `test/albums.test.js`, e2e `album-preview`

## T11 Bug: egal welcher Modus, das Entdecken-Profil wird geholt (nutzer 2026-10-27)
- [x] ursache: `buildProfilePayloadFor` filterte die felder nach dem schema des EIGENEN aktiven modus; wer in "Entdecken" war, schickte chat-kontakten sein dating-profil (alter, rolle), und umgekehrt
  - fix 2026-10-27: `profileSchemaForPeer` (matching.js) nach der chat-liste; tests `test/matching.test.js`, e2e `profile-scope` (schlaegt ohne fix fehl)

## T12 Alben-Menue an die einheitliche Oberflaeche anpassen (nutzer 2026-10-27)
- [x] alben-verwaltung im profil im stil der einstellungen
  - done 2026-10-27: `settings-card`; "Standard fuer neue Alben" eingeklappt als setting-rows; je album eine karte (vorschaubild, name, "2 Bilder · mit 2 geteilt", icon-knoepfe hinzufuegen/loeschen), "Einstellungen" eingeklappt (schluessel gilt, vorab, vorschau im chat), zugriff als zeilen (name, gueltigkeit, entziehen); leerer zustand; texte ohne feste deutsche reste (`albumEpochLabel`, epochen)

## T13 Flackern bei Album-Vorschau, ein Punkt fuer alle Canvas (nutzer 2026-10-27)
- [x] album-vorschau flackert wieder; canvas-darstellung ueber eine funktion
  - ursache: album-karte im chat nutzte die wiederverwendung nicht; album-verwaltung lud das vorschaubild bei jedem neuaufbau asynchron
  - fix 2026-10-27: register in `createSecureImage` (secure-canvas.js) statt collect/release je ansicht; schluessel fuer chat-bild, video, album-karte, album-verwaltung; vorschaubild der verwaltung einmal geladen und synchron; e2e `album-preview` (schlaegt mit altem code fehl)

## T14 Reaktions- und Kontextmenue (nutzer 2026-10-27)
- [x] gui von reaktionsmenue und nachrichten-kontextmenue ueberarbeiten; bug: geht manchmal fast sofort wieder zu, nachdem man mehrere sachen gemacht hat
  - ursachen: (1) aktionsleiste war nur eine css-klasse an der nachricht, die reaktionsauswahl ein element darin; jedes neuzeichnen des chats (zustellbestaetigung, reaktion, neue nachricht) warf beides weg; (2) nach langem druecken landete der klick beim loslassen auf dem neuen hintergrund; (3) reaktionsauswahl schloss nie beim tippen daneben
  - done 2026-10-27: ein kontextmenue (`openMessageMenu`, chat-tools.js) am `<body>`, reaktionen oben + aktionsliste; uebersteht neuzeichnen (`syncMessageMenu`); hintergrund schliesst nur bei eigenem tipp; aktionen ueber `replaceModal`; desktop: hover-leiste (antworten, reagieren, mehr) + rechtsklick; e2e `message-menu` (desktop + mobil)

## T15 Sprachnachrichten-Player (nutzer 2026-10-27)
- [x] beim abspielen flackern play-knopf und leiste bei einem redraw; schieben und geschwindigkeit
  - ursache: neu gezeichneter player stand bis zum naechsten zeit-update auf "play"/0 % (der stand wurde im dom gesucht, bevor das neue element drin war)
  - done 2026-10-27: `applyVoicePlayerState` am neuen element, symbol nur bei aenderung; leiste mit griff zum springen (`seekVoicePlayback`), 1x/1,5x/2x (`opengrid-voice-rate`); e2e `voice-video`; UC-52

## T16 Album begrenzt teilen (nutzer 2026-10-27)
- [x] album wie einen snap 1x/2x/3x oder 15 min/1 h/24 h teilen, im sendemenue einstellbar, ueberspringbar; begrenzte nutzer in der alben-verwaltung; ab 3 personen eingeklappt
  - nutzer 2026-10-28: eintrag soll nach der frist aus der zugriffsliste verschwinden; pruefen, ob der entzug ueber pfad c laeuft
    - befund: verschwinden klappte; der entzug ging aber nur als direktnachricht ohne pfad c (offline = verloren, schluessel bis epochenende); das vergessen loeschte die schluessel-buendel nicht
  - nutzer 2026-10-28: album/schluessel selbstzerstoererisch? entschieden: (1) jetzt, (2)+(3) geparkt (siehe "Eigene rotierende Verschluesselung")
    - done (1) 2026-10-28: nach einer ansicht auch die verschluesselten bilder loeschen; zeitlich begrenzt: `limitedUntil` im buendel, betrachter vergisst zur frist selbst (`runAlbumSelfDestruct`); e2e `album-views`, `album-revoke`
  - nutzer 2026-10-28: alben mit 1-3 ansichten laufen beim oeffnen nicht ab
    - befund: nach dem schliessen blieben schluessel + ansichts-buendel 15 min lang, beliebig oft neu oeffnen; entzug erst nach 15 min
    - fix 2026-10-28: ansicht endet beim schliessen (`endLimitedAlbumView`, `ALBUM_VIEW_CLOSED`, `handleAlbumViewClosed`), spaete ansichts-buendel verworfen; e2e `album-views`
    - fix 2026-10-28: `ALBUM_REVOKE` als chat-operation mit pfad-c-rueckfall, `forgetReceivedAlbum` loescht buendel + ticket; e2e `album-revoke` (schlaegt mit altem code fehl)
  - done 2026-10-27: `album.limits`, `openAlbumShareOptions`, ansichten ueber `handleAlbumKeyRequest` (15-min-ansicht, `session`), zeit ueber gekuerzte buendel, `enforceAlbumLimits`; tests `test/albums.test.js`, e2e `album-preview`; UC-51

## Eigene rotierende Verschluesselung (geparkt, erst besprechen)
- besprochen 2026-10-29 (nutzer): eigener algorithmus verworfen (siehe `tasks/rejected.md`); key-splitting (router-haelfte pro bild, beim ansehen ausgegeben, nach frist geloescht), zeitscheiben (ohne splitting nur mit neu-verschluesseln pro scheibe) und stream bringen in der praxis wenig: wer gerade ansieht, kann immer kopieren/screenshotten; splitting schuetzt nur kopierte app-daten nach der frist. fazit nutzer: "so ganz bringen tut das beides nicht wirklich was" -> geparkt, aktueller schutz (schluessel je epoche/ansicht, ende beim schliessen, selbstzerstoerung, sofortiger entzug ueber pfad c, wasserzeichen) bleibt
- nutzer-idee 2026-10-29 "lese-muster vom router + geheimnis vom peer + zeitstempel" besprochen: zeitpruefung im code ist umgehbar, echter schutz nur durch ein nach der frist geloeschtes router-geheimnis = key-splitting; saubere fassung (HKDF mit router-geheimnis als salt) in `tasks/feature-request-rotating-encryption.md` abschnitt 8, geparkt
- [ ] (geparkt 2026-10-28) echt selbstzerstoererische alben: key-splitting mit dem server (bildschluessel = haelfte besitzer + haelfte server; server gibt seine haelfte nur so oft/lange wie erlaubt und loescht sie dann; album danach kryptografisch tot, auch ohne besitzer online). beruehrt die regel "server sieht nur ciphertext + iv + routing-ids" (zufaellige schluesselhaelfte) -> zusammen mit der rotierenden verschluesselung entscheiden
- [ ] (geparkt 2026-10-28) begrenzte album-ansichten als stream wie secure snaps (empfaenger bekommt keine bilddaten; besitzer muss online sein)
- [ ] gestohlene album-schluessel sollen nach der epoche wertlos sein; idee: eigener, vom server getakteter algorithmus -> `tasks/feature-request-rotating-encryption.md`
  - offen: konflikt mit regel "crypto nur ueber `crypto.subtle`"; alternative: server-epochen-geheimnis + `CK_e` per HKDF (AES-GCM bleibt)

## R6 Adden (Chat- und Freunde-Modus)

## R7 Status-Feed (geplant)

# Runde S (2026-10-24)
## S1 Bugs

## S2 Schnell zwischen Chats wechseln (feature request 2026-10-24)

## S2c Bug: Chatliste auf dem Smartphone in einer Box

## S2b Bug: P2P geht verloren, beide nutzen Path C bis zum Neuladen (handy + pc, gleiches WLAN)

## S2d Neue Wuensche (2026-10-24, je feature ein changy)
- [x] einmal-snaps laufen nach dem ersten ansehen nach einer bestimmten zeit ab (z. B. 15, 30 oder 60 min) (wunsch 2026-10-25)
  - entschieden 2026-10-26: einstellung des absenders, als enum (`15m`/`30m`/`60m`/`off`) im snap, standard 30 min vom router (`CLIENT_DEFAULTS.snapExpiry`), keine restzeit beim empfaenger
  - done: `isReplaySnapUsedUp`/`scheduleReplaySnapExpiry` (snaps.js), tests `test/snap-expiry.test.js`, e2e in `snap-camera`
- [x] e2e-stabilitaet: einzelne tests haengen gelegentlich beim P2P-aufbau unter last (auch vor dem heartbeat-commit, 1 von 3 laeufen); verbindungsaufbau im test robuster machen bzw. ursache finden
  - 2026-10-26: nutzer: nachrichtenfeld-bug auf dem smartphone seit dem uebersetzungs-fix nicht mehr aufgetreten
  - 2026-10-26: 3 volle laeufe (je 17 tests) mit protokolliertem schluesselaustausch: kein einziges erneutes KEY_HELLO noetig, kein ausfall; ursache des frueheren haengers nicht mehr nachstellbar (vermutlich zusammen mit `CACHE_WAITING`/wachhund behoben). retry bleibt als sicherheitsnetz, im debug-log sichtbar ("sende KEY_HELLO erneut"); `E2E_DEBUG=1 sh scripts/e2e.sh` zeigt es
  - gefunden: schluesselaustausch blieb gelegentlich haengen (kanal offen, kein sitzungsschluessel, laut log weder empfang noch fehler) -> KEY_HELLO wiederholen + logs; ursache noch offen, weiter beobachten
  - gefunden: echter bug, online empfaenger ohne push holte den router-cache erst beim naechsten verbinden ab -> `CACHE_WAITING` vom server (e2e `p2p-recovery`: ohne fix kam die nachricht nie an)
  - done teilweise: wachhund fuer haengende verbindungsversuche (verlorenes angebot -> nach 8 s neu, e2e `e2e/p2p-recovery.e2e.cjs`); danach 2 von 3 laeufen komplett gruen, ein lauf mit einem ausfall -> weiter beobachten


## S3 Aufraeumen
- [x] jenkins: sub-branches bauen, aber nie deployen (nutzer 2026-10-28)
  - deploy lief schon nur auf main; neu: stage "Image bauen (ohne Deploy)" baut auf anderen branches das echte image zur probe und loescht es wieder
- [x] tailwind 4 migration (behebt die 3 moderate `npm audit`-funde in dev-abhaengigkeiten)
  - done 2026-10-28: `@tailwindcss/cli` 4, konfiguration in `client/tailwind.input.css` (`@theme inline` aus css-variablen, schriften wie v3, rahmenfarbe wie v3), `tailwind.config.cjs` entfernt; klassen per upgrade-tool umbenannt, dessen 3 fehler zurueckgenommen (`'blur'`-wert der album-vorschau, api-parameter `ring`, text-schluessel `grid.ring`); `npm audit` 0 funde; vorher/nachher-screenshots: farben/hell/dunkel gleich, nur etwas engere abstaende wo versteckte elemente bei `space-y` vorher extra luecken machten

# test

# feat
- [x] new swipe actions in chat
  - [x] swipe header (the one with the contact info) down opens contact
  - [x] swipe right for chats works for incomming chats also on the empty space besides the message
  - done 2026-10-26: kontaktleiste nach unten ziehen (>= 60 px) = profil (`initChatSwitchSwipe`, chat-switch.js); wischen ab der ganzen nachrichtenzeile (gestures.js); e2e `chat-gestures`

- [x] info-website aus der doku, fuer nicht-techies, sprachen + fachbegriffe umschaltbar (wunsch 2026-10-26)
  - done: subdomain per `INFO_HOST` (sonst `/info`), seiten `info-site/pages/<sprache>/*.md`, begriffe `info-site/i18n/*.properties` mit `.plain`-varianten und `${ui:...}`; app-uebersetzungen vorher auf schluessel umgestellt (`i18n/*.properties`); tests `test/info-site.test.js`, e2e `info-site`
- [x] echte umlaute in den app-texten (`i18n/de.properties` noch mit ae/oe/ue, auf der info-seite fallen `${ui:...}`-beschriftungen wie "Privatsphaere" auf); e2e-tests pruefen teils diese schreibweise
  - done 2026-10-26: werte in `de.properties` + rueckfalltexte im markup mit ä/ö/ü/ß (schluessel bleiben ascii), e2e-selektoren angepasst
- [x] info-seite: push-texte des service workers sind noch nur deutsch
  - done 2026-10-26: schluessel `sw.*`, server setzt sie in `/sw.js` ein, sprache = browsersprache (nutzer: reicht so); test in `test/push.test.js`

## chat improvements
- [x] audio messages
  - if there is a lokal api for audio to text this function too, if not leave it
  - done 2026-10-26: `client/app/voice.js`, opus ~12 kbit/s, inline im MESSAGE_PUT (P2P oder pfad C, cache-limit 256 KB); mikrofon statt senden bei leerem feld
  - 2026-10-26 (wunsch): laenger als 60 s (bis 15 min): ab 60 s zweiter recorder, rest als original nur per P2P, wiedergabe wartet am ende des anfangs und laeuft weiter, sobald der rest da ist; kein auto-senden am maximum; e2e `voice-video`
  - verschriftlichung nur lokal: `SpeechRecognition` mit `processLocally` (chrome, sofern `available`); sonst kein text. die normale web speech api schickt audio an google -> verboten
- [x] videos?
  - only via __p2p__
  - done 2026-10-26: `client/app/video.js`, vorschaubild + infos in der nachricht, video ueber den original-weg (originals.js, nur DataChannel), max 25 MB; e2e `voice-video`
- [x] ui ux improvement
  - einheitlichkeit & modularität
    - modularerere gestaltung
  - besseres UX
  - 2026-10-26 bestandsaufnahme (screenshots mobil/desktop, hell/dunkel), nutzer waehlt aus:
    - [x] U1 sprache einheitlich deutsch: profil-felder "Display Name", "Age", "Position / Role", "About Me" + englische beispielwerte ("Privacy-first tech enthusiast!"), grid "6 peers • Updated 01:54:30 PM", "Enable Notifications", kontaktleiste "offline"
      - nutzer 2026-10-26: uebersetzungsdateien, sprache umschaltbar
      - done: `client/i18n.js` (`t()`, deutsch = schluessel), `client/i18n/en.js` (510 eintraege), statisches markup beim start uebersetzt, einstellung Allgemein > Sprache (auto/de/en, `CLIENT_DEFAULTS.language`), schema-labels `{de,en}`, englische quelltexte auf deutsch umgestellt; `scripts/i18n-keys.mjs`, tests `test/i18n.test.js`, e2e `i18n`
      - done 2026-10-26: service worker (push-texte) nach browsersprache
    - [x] U2 zeitformat einheitlich: chatliste "01:54 PM" (locale des browsers), nachrichten "21:01", grid mit sekunden -> ueberall 24h ohne sekunden (bzw. "gestern", datum)
      - done mit U1: `formatClockTime` (24 h ohne sekunden), chatliste "Gestern" bzw. datum
    - [x] U3 einstellungen: eine sehr lange seite (~9 bildschirme) -> abschnitte mit sprungleiste/tabs (Konto & Modus, Chat, Privatsphaere, Medien & Snaps, Benachrichtigungen, Darstellung); chat-wechsel-optionen stehen unter "Darstellung", wasserzeichen unter "Secure Snaps"
      - nutzer 2026-10-26: schalter statt checkboxen, auf dem smartphone angenehmer
      - done: tabs Allgemein/Privatsphaere/Chat/Medien/Darstellung/Debug (sticky unter der kopfzeile, letzter tab gemerkt), zeilen mit titel + kurzer beschreibung und schalter/auswahl rechts, `.switch`, `.setting-row`, `.btn-primary`/`.btn-secondary` (styles.css); U4 gleich mit erledigt (keine "1 -"/"A -"-codes mehr)
    - [x] U4 interne codes sichtbar: "1 - Alles fuer alle", "A - Alle" -> nur klartext (mit U3)
    - [x] U5 buttons: gleiche hoehe/form in der eingabeleiste (snap/video/mic unterschiedlich hoch), ein primaer-stil, ein sekundaer-stil, ein icon-knopf-stil als wiederverwendbare klassen (statt langer tailwind-ketten pro knopf)
      - done 2026-10-26: eingabeleiste mit `.compose-btn`/`.compose-btn-primary` (44 px, gleiche form), eingabefeld gleich hoch, platzhalter einzeilig
    - [x] U6 desktop: avatar-leiste im chat doppelt zur sichtbaren chatliste -> auf desktop ausblenden; aktionen-pfeil auf desktop nur beim hovern
      - done 2026-10-26: avatar-leiste ab 768 px ausgeblendet; aktionen-pfeil ist auf echtem desktop schon nur beim hovern (headless-chromium meldet hover:none, daher in screenshots sichtbar)
    - [x] U7 leere zustaende/ladeanzeigen einheitlich (grid leer, chatliste leer, "Chat wird geladen", album leer) mit gleichem icon+text-muster
      - done 2026-10-26: `client/app/ui.js` (`createEmptyState`/`showEmptyState`): grid, chatliste (neu, mit "Kontakt einladen"), kein chat, keine nachrichten, suche, laden, medien-fenster, blockierte peers
    - [x] U8 profil-tab: "Speichern" oben rechts, aenderungen ohne hinweis auf ungespeichert -> sticky speicherleiste unten, sobald etwas geaendert ist
      - done 2026-10-26: "Speichern" oben entfernt, leiste "Nicht gespeichert · Verwerfen · Speichern" unten (sticky ueber der navigation), verschwindet beim zuruecksetzen; avatar mit kamera-badge, auf dem smartphone tippbar (vorher nur per hover); e2e `profile-save`
    - [x] U9 menue: nur 3 punkte, viel leerraum -> modus-wechsel, kontakt einladen und changelog/version mit hinein
      - nutzer 2026-10-26: profil-kopf und drei eintraege fuer einstellungen doppelt -> zahnrad im profil, einstellungen per wischen wie 4. tab, menue = modus direkt + einstellungen/changelog/debug/abmelden
      - done 2026-10-26: profilkopf (avatar, name, modus), Modus wechseln, Kontakt einladen, Einstellungen, Changelog (jetzt immer sichtbar), Debug-Modus; Abmelden und version unten abgesetzt

## T11 Entdecken-Verlauf im Freundes-Chat (nutzer 2026-10-28)
- [x] nach dem adden (chat wandert nach "Chat & Freunde") ist der entdecken-teil des verlaufs ausgeblendet, oben einblendbar; standard an, aber einstellung
  - done 2026-10-28: kein datenmodell-umbau (ein verlauf pro person, `message.scope`); `keys`/`discovery-history = { hide, flipped }`, router-standard `hideDiscoveryHistory`; zeile "Entdecken-Verlauf ausgeblendet (N) · anzeigen"; einstellung Chat > "Nach dem Adden" (nur bei beiden bereichen); ohne entdecken-bereich immer verborgen; ungelesen zaehlt nur sichtbares; tests `test/friends.test.js`, e2e `friends`; UC-53
- [x] flirt-schalter im chat (nutzer 2026-10-28: "so kann man nicht mehr im chat flirten")
  - entschieden: flamme im chat-kopf pro chat; flirt-modus zeigt alles (flirt markiert) und schreibt `scope: 'discovery'`; normal = social, flirt-teil verborgen (einstellung); punkt an der flamme bei neuer verborgener nachricht
  - done 2026-10-28: `keys`/`discovery-history = { hide, flirt }` (ersetzt die zeile oben im verlauf), `canFlirt`/`isFlirting`/`messageScopeFor`, album-knopf im flirt-modus sichtbar; tests `test/friends.test.js`, e2e `friends`
- [x] chat laedt und zeichnet immer den ganzen verlauf (keine seiten) -> bei langen chats evtl. nur die letzten N zeichnen, aeltere beim hochscrollen nachladen (frage nutzer 2026-10-28)
  - entschieden (nutzer): dazu option "seiten pro tag" mit tagesleiste unter der kontaktleiste, wischbar, pfeile links/rechts
  - done 2026-10-28: durchgehend 150 + je 150 beim hochscrollen (position bleibt, knopf "aeltere laden"); `keys`/`chat-view.byDay`, `CLIENT_DEFAULTS.chatPagesByDay`; tagesleiste mit pfeilen/wischen, nur tage mit nachrichten, senden springt zu heute; suche ueber alles; zitat holt nicht gezeichnete nachricht; tests `test/chat-pages.test.js`, e2e `chat-pages`; UC-55

## T12 Bug: Album-Ansichten und Neu laden (nutzer 2026-10-28)
- [x] album mit 1x/2x/3x ansehen: oeffnen + neu laden zaehlte nicht (wie frueher bei snaps)
  - ursache: neu laden ueberspringt das schliessen -> ansichts-buendel blieben gespeichert (oeffnen ohne nachfrage), und der besitzer wertete jede anfrage innerhalb der 15-min-ansicht als dieselbe ansicht
  - done 2026-10-28: `viewId` pro oeffnung in `ALBUM_KEY_REQUEST` (besitzer zaehlt neu bei anderer/fehlender viewId), `endInterruptedAlbumViews` beim start; tests `test/albums.test.js`, e2e `album-views` (mit neu laden)

## T13 Bugs: Chat loeschen offline, Flamme in Social-Chats (nutzer 2026-10-28)
- [x] chat loeschen/blockieren kam beim offline partner nicht an
  - validiert: `deleteActiveChat` reihte den `CHAT_WIPE` per path c ein und setzte danach `DELETE_CHAT` am router; der loescht alle wartenden payloads des chats in beide richtungen, also auch den wipe. gleiches beim blockieren. e2e mit altem code: wipe kommt nie an
  - done 2026-10-28: `wipeChatWithPeer`: direkt bei offenem kanal -> chat-steuerung -> danach path c; lokale warteschlange verworfen; empfaenger ignoriert doppelte wipes (`appliedChatWipes`); e2e `chat-wipe-offline`
- [x] flamme (flirt-modus) erschien in chats, die nur in social liefen
  - validiert: bedingung war match ODER `discovery`-nachrichten; ein match ohne flirt-chat (flammen im grid) bzw. markierte nachrichten aelterer chats ohne listen-zuordnung (aus der grid-liste beschrieben) reichten
  - done 2026-10-28: `hasFlirtPart` = match UND flirt-nachrichten; ohne flirt-teil keine flamme und nichts ausgeblendet; test `test/friends.test.js`
- [x] album mit x-ansichten: besitzer merkte das ende nicht, person blieb in den album-einstellungen (nutzer 2026-10-28)
  - validiert: `ALBUM_VIEW_CLOSED` ging nur direkt (P2P), ohne pfad c; ohne offenen kanal (handy, app im hintergrund) kam es nie an -> entzug erst nach 15 min und nur bei laufender besitzer-app. e2e mit altem code: person bleibt
  - done 2026-10-28: `ALBUM_VIEW_CLOSED` auch als chat-operation (offen -> direkt, sonst sofort pfad c), besitzer bekommt hinweis "X hat ... fertig angesehen"; tests `test/albums.test.js`, e2e `album-views` (schliessen ohne kanal)

## T14 Wischgesten: Album-Ansicht, Profil im Chat (nutzer 2026-10-28)
- [x] album-ansicht nach unten wischen ist zu empfindlich (1x-alben enden zu schnell)
  - done 2026-10-28: `attachSwipeToClose(..., { trigger })`; album-ansicht ab 40 % der bildschirmhoehe (mind. 220 px) statt 100 px; ab der schwelle wird die karte durchsichtig; `touchcancel` setzt zurueck; e2e `chat-gestures` (mobil)
- [x] profil im chat nach unten wischen = schliessen
  - validiert 2026-10-28: gab es schon (profil-fenster, auch aus dem chat geoeffnet); funktioniert im e2e vom profilbild und von weiter unten aus; nur wenn das fenster ganz oben ist (sonst scrollt es erst). jetzt im e2e `chat-gestures` abgedeckt
- [x] wisch-wunsch (nutzer 2026-10-28): im profil nach links = menue; einstellungen seitlich = bereiche blaettern (ausnahme regler); einstellungen verlassen nur nach unten
  - done 2026-10-28: `SWIPE_TABS` ohne einstellungen, `stepSettingsTab`, runterziehen ab 120 px oben = zurueck ins profil; `overscroll-behavior-y: contain` solange die einstellungen offen sind (kein neu laden); e2e `mobile-layout`

## T15 Praesenz: Abwesend + Benachrichtigung bei verstecktem Tab (nutzer 2026-10-28)
- [x] PWA auf dem handy weggewischt/im hintergrund (und browser-tab/fenster am pc nicht sichtbar): status bleibt "online", nachrichten kommen an, aber keine benachrichtigung
  - ursache: benachrichtigungen kamen nur per web push vom service worker; solange die app im hintergrund noch verbunden ist, stellt der absender direkt (P2P) zu und es geht kein push raus; die seite selbst zeigte nichts
  - done 2026-10-28: `PRESENCE_AWAY` (versteckt/`pagehide`) -> partner sehen "Abwesend" (gelb); direkt zugestellt an einen abwesenden partner -> `POST /api/push/nudge` -> push ohne inhalt `{ type: 'NUDGE', senderId }` -> SW zeigt kompakt bzw. "Neue Nachricht von X" (nicht bei sichtbarem fenster); server prueft abwesend/offline, block, subscription, 15 s pro paar, rate-limit `nudge`; tests `test/server.test.js`, `test/push.test.js`, e2e `presence-away`
  - nebenbei: doppelte i18n-schluessel (`chat.moreActions`) entfernt, neuer test findet doppelte schluessel
  - wunsch: zustand "abwesend" (o. ae.), wenn die app nicht sichtbar ist
  - zu pruefen: wird bei `visibilityState === 'hidden'` eine benachrichtigung gezeigt (seite selbst bzw. SW), oder unterdrueckt die app sie, weil die seite noch "lebt"? push kommt evtl. gar nicht, solange die WS-verbindung steht (server haelt peer fuer online)
- [x] flirt-lasche ueber dem senden-knopf (nutzer 2026-10-28): ersetzt die flamme im chat-kopf; lasche tippen = flirt-modus, lasche lange druecken = in diesem chat ausblenden (zurueck ueber ⋮), senden lange druecken = diese nachricht als flirt; im flirt-modus lasche + senden als ein block, eingabefeld mit rand und "Flirt-Nachricht…"; einstellung "Flirt-Knopf über Senden"; verlauf unten mit platz fuer die lasche; e2e `friends`
  - nachgezogen 2026-10-28 (nutzer): fokus des eingabefelds bleibt beim tippen auf die lasche; lasche hoeher und auf der oberkante der eingabeleiste (antwort-leiste darunter, nichts verdeckt, verlauf unten mehr platz, runter-knopf ueber der lasche); punkt fuer jede neue verborgene flirt-nachricht seit dem letzten blick (`seen`), nicht nur die letzte; im flirt-modus album + video hinter einem medien-knopf, der nach oben aufklappt (+ foto aus der galerie)
- [x] pc: hover-leiste an nachrichten flackert (nutzer 2026-10-28)
  - ursache: der verlauf zeichnet sich neu, das neue element verliert kurz `:hover` und die leiste blendete von 0 ein
  - done 2026-10-28: `state.hoveredMessageId` (mouseover), neu gezeichnete nachricht bekommt `.is-hovered` ohne ueberblenden

## T16 Wisch-Bugs (nutzer 2026-10-28)
- [x] seitenmenue laesst sich nicht per wischen (nach rechts) schliessen
  - done 2026-10-28: `attachSwipeRight` am menue
- [x] profil im chat laesst sich (beim nutzer) nicht nach unten wischen; im e2e geht es -> auf echtem geraet pruefen
  - wahrscheinliche ursache: im browser startet oben das eigene pull-to-refresh und bricht die geste ab (`touchcancel`); das e2e schickt rohe touch-events und sieht das nicht
  - done 2026-10-28: `overscroll-behavior-y: contain` solange profil/medien-fenster, menue, einstellungen oder chat offen sind; profil startet immer oben (`scrollTop = 0`). auf dem geraet bestaetigen
- [x] profil und einstellungen: wischen soll auch auf schaltern und auswahlen starten duerfen (die reagieren auf klick, nicht auf wischen)
  - done 2026-10-28: `blocksTabSwipe` sperrt nur noch textfelder und regler
- [x] einstellungen auch per wischen nach rechts schliessen (an "Allgemein" -> zurueck ins profil)
  - done 2026-10-28: `stepSettingsTab` am ersten bereich nach rechts = profil
- [x] im chat auf der eingabeleiste nach rechts wischen = chat schliessen (zur chat-uebersicht); einstellbar, standard vom router (`CLIENT_DEFAULTS`) (nutzer 2026-10-28)
  - done 2026-10-28: `keys`/`chat-swipe-close`, `CLIENT_DEFAULTS.inputSwipeClosesChat`, schalter unter Chat; e2e `chat-gestures`

- [x] gui der neuen eingabeleisten-funktionen ueberarbeitet (nutzer 2026-10-28): lasche genau ueber dem senden-knopf und optisch teil der leiste; medien-menue im stil des chat-menues (symbol + text); "foto aus der galerie" entfernt (fuehrte ins snap-menue)

- [x] flirt-lasche beim hochscrollen (nutzer 2026-10-28): ab halbem bildschirm faehrt sie smooth zum streifen ein (gleicher hintergrund), tippen/fokus im eingabefeld klappt aus, unten wieder da; liegt jetzt vor der aktionsleiste der nachrichten (z-index); e2e `friends`
- [x] eigenes profil: wischen auch ueber (nicht fokussierte) eingabefelder (nutzer 2026-10-28); e2e `mobile-layout`
- [x] chatliste/chat-wechsler/profil zeigten nur gruen/offline, nicht "abwesend" (nutzer 2026-10-28)
  - done: `presenceStatusOf`/`createPresenceDot` an allen stellen; e2e `presence-away` prueft den gelben punkt in der liste
- [x] bug: im chat am ende hochziehen flackerte (nutzer 2026-10-28)
  - ursache: anzeige waechst -> verlauf schrumpft -> nicht mehr "ganz unten" -> anzeige 0 -> wieder unten -> waechst ...
  - done: "unten" nur beim aufsetzen pruefen, verlauf waehrend des ziehens unten anheften, `touchcancel`; e2e `pull-up` prueft, dass die anzeige nur waechst (mit altem code: 0,12,18,18,24,0,36,0,...)

## T17 Mehrere Bilder/Snaps vor dem Senden durchsehen (nutzer 2026-10-28)
- [x] beim versenden mehrerer bilder/snaps (mehrfachauswahl aus der galerie) alle vor dem senden durchsehen koennen
  - done 2026-10-28: durchsicht im medienfenster: grosses bild, seitlich wischen/pfeile, zaehler, leiste mit allen, einzelne entfernen, "Alle senden (N)"; art (snap/bild/secure/status) wie im snap-menue gewaehlt; e2e `snap-camera` (4 waehlen, blaettern, eins entfernen, 3 kommen an)
  - done 2026-10-28 (nachtrag): art pro bild (snap/bild/secure), einzelnes bild im snap-editor bearbeiten ("Uebernehmen"/schliessen -> zurueck zur durchsicht); e2e `snap-camera`
  - ist-stand: `sendPickedImages` (snaps.js) schickt bei mehrfachauswahl jedes bild sofort einzeln, ohne editor/vorschau
  - idee: vorschau-streifen mit allen bildern, durchwischen, einzelne entfernen, ggf. pro bild snap/bild/secure; dann "alle senden"

## T18 Benachrichtigungen je Art (nutzer 2026-10-28)
- [x] in den einstellungen einzeln einstellbar: match, flamme, adden, entdecken-nachricht, chat-nachricht, profilbesuch (entdecken), chat-ereignisse
  - entschieden (nutzer): ein schalter = push + hinweis in der app; profilbesuche neu bauen, opt-in auf beiden seiten
  - done 2026-10-28: `keys`/`notification-settings`, `notifyInApp`, `POST /api/push/settings` (stumme arten, spalte `muted_kinds`), `notifyKind` beim cache-eintrag und `kind` beim anstupsen, SW-texte je art; push jetzt auch fuer flamme/match/anfrage/profilbesuch; `PROFILE_VIEW` (opt-in, nur entdecken, 6 h pro person); tests `test/push.test.js`, e2e `notifications`
  - metadaten: der router erfaehrt die art eines ereignisses (nicht den inhalt), sonst bestrafen browser still verworfene pushes (decisions log in claudy.md)
  - nutzer hat auf dem geraet getestet (2026-10-28): passt
  - done 2026-10-28: router-standards `CLIENT_DEFAULTS.notifyMatch` ... `notifyChatEvents`, `shareProfileViews`

## T19 Skalierung: mehrere Router, der Client waehlt (nutzer 2026-10-28)
- [ ] ein 2. container registriert sich beim 1.; der 1. gibt ihn per config an die clients; die clients entscheiden selbst, wohin sie ihren verkehr schicken (kein weiterleiten zwischen routern)
  - entschieden (nutzer): aufteilung nach region (geohash); kein forwarding; zellen sind teilbar (laengeres praefix), sonst bekommt ein router alles; optional "sharing": zellen unter einem praefix abwechselnd verteilen (2 router = gerade/ungerade); der client ordnet anhand des hashs zu, ohne vorher einen router anzupingen; die regeln kommen mit der config vom router
  - stand 2026-10-28: P1-modul (regeln, zuordnung, beitritt) auf branch `feature/federation` (`7c1c377`), nicht in main; dort steht der genaue stand. vorerst geparkt (nutzer: "musik aus der zukunft")
  - plan P1 (router-seite, ein router bleibt wie heute):
    - `POST /api/federation/join { id, url, token }` vom 2. container (token aus `FEDERATION_PEERS`), health-check, faellt er aus -> seine zellen zurueck an den 1.
    - regeln per env (`FEDERATION_RULES`, z. B. `[{"prefix":"u1","routers":["r1"]},{"prefix":"u1hx","routers":["r2"]},{"prefix":"u0","routers":["r1","r2"],"mode":"share"}]`)
    - `/api/config` liefert `routers: [{ id, url }]` + `rules`
    - unit-tests: laengstes praefix gewinnt, share = wert des letzten zeichens mod anzahl, ausgefallener router faellt zurueck
  - plan P2 (client):
    - `routerForCell(cell)` (gleiche regeln wie der server, test fuer gleichlauf wie sw-parity)
    - heimat-router = router der eigenen zelle: registrieren + WS dort
    - grid: die 9 zellen (eigene + nachbarn) je router abfragen (parallel), ergebnisse mischen
    - signaling an einen peer auf einem anderen router: kurzer WS dorthin (mit derselben identitaet registrieren), nach dem verbindungsaufbau wieder zu
    - praesenz: WS auch zu den routern aktiver chat-partner (begrenzt)
  - plan P3: pfad C und push immer beim heimat-router des empfaengers; peers nennen ihren heimat-router (grid-ergebnis, profil bzw. P2P); unbekannt -> alle router (wenige) versuchen
  - plan P4: e2e mit zwei containern (compose mit r1 + r2), zelle teilen, sharing gerade/ungerade, ausfall von r2
  - spaeter: automatisches teilen voller zellen, uebersicht fuer betreiber
  - entschieden (nutzer 2026-10-28): router beisteuern darf jeder, den der router-admin freigibt
    - freigabe: admin traegt freigegebene router mit eigenem token ein (`FEDERATION_PEERS`, z. B. `[{"id":"r2","token":"..."}]`); beitreten nur mit passendem token (statt einem gemeinsamen `FEDERATION_SECRET`), einzeln entziehbar
  - metadaten: jeder router sieht nur seine zellen

## T20 Grid: drei Bereiche, Filter, "nur zeigen fuer" (nutzer 2026-10-28)
- [x] grid in drei tabs: **Grid** · **Interaktionen** (wer hat mein profil angesehen, wer hat mir eine flamme geschickt; nur lokal, nichts ueber den router) · **Matches** (eigener tab, nur bei aktivem matching)
  - matches-tab: noch nicht angeschriebene matches oben, jede karte mit chat-knopf (keine doppelung zur chatliste)
  - done 2026-10-28: `client/app/grid-tabs.js`, `keys`/`interactions`, badge, flamme zurueck / schreiben; e2e `grid-tabs`; UC-56
  - interaktionen: neueste oben, "flamme zurueck"-knopf, badge am tab fuer neue
- [x] filter (lokal auf die grid-ergebnisse): alter von-bis, entfernung, gerade online, mit foto, plus jedes select-/tag-feld aus dem profil-schema; mehrere selektoren: UND zwischen feldern, ODER innerhalb eines felds; zu wenige treffer -> "mehr laden"
  - entschieden (nutzer 2026-10-28): kein filter-code auf der karte; stattdessen die ersten ~10 profile im hintergrund laden und auf dem client filtern/sortieren; filter auch in interaktionen und matches; panel nur ueber pfeil-knopf; dazu im profil seitlich zwischen den karten wischen
  - nachtrag (nutzer 2026-10-28): animation beim seitlichen wischen im profil (karte folgt dem finger, faehrt hinaus, neues kommt herein; gummiband am ende); e2e `chat-gestures`
  - test-stabilitaet: e2e `pull-up` leerte gelegentlich seine testchats (laufender db-abgleich der chatliste beim start), jetzt vor jedem ziehen sichergestellt
  - nachtrag (nutzer 2026-10-28): profil-version auf der grid-karte (`profileVersion` beim registrieren, spalte `peers.profile_version`, nur ein zaehler); prefetch nur bei fehlendem oder veraltetem profil
  - done 2026-10-28: `client/app/grid-filter.js` (`keys`/`grid-filter`), entfernung/foto/zahlen/auswahl, unbekannte hinten (abschaltbar), direktes `PROFILE_REQUEST` fuer die ersten 10, neu sortieren bei ankunft, blaettern im profil (wischen, pfeiltasten); tests `test/grid-filter.test.js`, e2e `grid-filter`
- [x] "nur zeigen fuer ..." (sichtbarkeitsregel), auf jedem select-/tag-feld (z. B. tribe: twink, femme), symmetrisch zum filter
  - entschieden (nutzer 2026-10-28): der router setzt die regel durch (P2P-pruefung skaliert nicht und wirkt offline nicht); die regel darf klartext sein ("wen ich sehen lassen will", keine aussage ueber den eigenen typ) - das ist der preis, deshalb steht ein hinweis bei der einstellung
  - korrigiert (nutzer 2026-10-28): der router bekommt NIE die tags des betrachters. er liefert jede grid-karte mit der regel des besitzers (klartext) aus, die **app des betrachters filtert** mit ihren eigenen tags (die das geraet nie verlassen)
    - preis (hinweis bei der einstellung): die regel sieht jeder, der die karte abruft; ein manipulierter client koennte sie ignorieren
    - zusaetzlich: ist die app des besitzers online, gibt sie volles profil/fotos nicht an betrachter ausserhalb der regel (kostet nur bei anfragen)
  - kodierung (nutzer 2026-10-28: so klein wie moeglich, binaer, baumartig, min/max):
    - `code = version (1 byte) + eintraege`, base64url; eintrag = feldnummer (index im profil-schema) + art
    - art "tags": bitmaske der erlaubten werte (option n = bit n), 1-4 byte; art "range": min + max (je 1 byte, z. B. alter)
    - beispiel "tribe twink|femme, alter 21-35" = 8 byte (~11 zeichen auf der karte)
    - pruefung beim betrachter: pro feld `regel & meine bits != 0` (ODER im feld), range `min <= wert <= max`, UND zwischen feldern
    - schema geaendert -> version/feldnummer passt nicht -> regel wird ignoriert statt falsch angewendet
    - filter (was ich sehe) nutzen dieselben masken, nur lokal
  - done 2026-10-28: `client/app/audience.js` (kodierung wie oben, + schema-fingerabdruck), einstellung unter privatsphaere mit hinweis, router speichert nur den code (`peers.audience`), karte traegt ihn, app des betrachters blendet aus; tests `test/audience.test.js`, server-test, e2e `audience`; UC-57
  - nicht gebaut: zusaetzliche pruefung beim besitzer (profil/fotos verweigern) - der besitzer kennt das profil des betrachters meist nicht, das waere fail-closed fuer fast alle
  - plan: profil-schema feldtyp `tags` (mehrfachauswahl); router speichert pro peer nur die regel `audience` (feld -> erlaubte werte, begrenzt) und liefert sie mit der karte; client blendet karten aus, deren regel nicht zu den eigenen tags passt (eigene tags fehlen fuer das feld -> nicht passend); besitzer-app prueft bei PROFILE_REQUEST; tests (regel greift, regel entfernen, fehlende eigene tags)

## T21 Grid-Kopf und Router-Standards fuer "nur zeigen fuer" (nutzer 2026-10-28)
- [x] grid-kopf: tabs ueber die kachel, graue zahlen an den tabs (rot bleibt fuer neues), kachel "in deiner naehe" zur schmalen statuszeile, aktualisieren per runterziehen (eigene geste, iOS-PWA hat keins), am PC kleiner knopf; e2e `mobile-layout`
- [x] router-standards fuer die sichtbarkeitsregel
  - entschieden (nutzer 2026-10-28): startregel fuer neue nutzer (`CLIENT_DEFAULTS.audience`), router erzwingt mindestwerte (`AUDIENCE_MINIMUM`, router mischt sie in jeden karten-code, auch ohne eigene regel); relative regeln: alter "wie ich" (+-3), "aelter als ich" (>=), "juenger als ich" (<=); auswahlfelder "wie ich"
  - folge: wer den wert (z. B. alter) nicht angibt, sieht bei einem mindestwert niemanden (fail closed, gewollt fuer 18+)
  - done 2026-10-28: `resolveAudienceRule`, `CLIENT_DEFAULTS.audience`, `AUDIENCE_MINIMUM` + `server/audience.js` (gleicher code, parity-test), `audienceMinimum` in `/api/config`, hinweis "Vom Server vorgegeben"; tests `test/audience-parity.test.js`, server-tests
- [x] einstellung "nur zeigen fuer" in die karte "Sichtbarkeit im Grid" verschoben, GUI ueberarbeitet (titel je feld, chips umbrechen, "wie ich" gestrichelt) (nutzer 2026-10-28)
- [x] entdecken-profil um dating-felder erweitert: groesse, gewicht, koerperbau, tribes, sucht nach, beziehungsstatus; mehrfachauswahl im profil-editor als chips (nutzer 2026-10-28)
- [x] router laesst fuer die regel alles zu: alter + alle auswahlfelder (freitext-tags gehen nicht, keine feste liste)
- [x] neu laden einstellbar (nutzer 2026-10-28): "ganze seite" (browser, standard vom router `CLIENT_DEFAULTS.reloadMode`, sonst full) oder "nur daten"; gilt fuer grid, chatliste (neu: runterziehen) und hochziehen im chat; bei "nur daten" menue-eintrag "seite neu laden"; hinweis "grid aktualisiert" entfernt (spam); e2e `mobile-layout`

## T22 Profil loeschen (nutzer 2026-10-28)
- [x] es gibt keinen loesch-knopf fuer das eigene profil ("Abmelden" nimmt nur aus dem grid, die daten bleiben)
  - plan: Einstellungen > Allgemein "Profil loeschen" mit doppelter bestaetigung
  - router: alles zu mir entfernen (grid-eintrag, zugang/credentials, push-subscription, chat-steuerung, wartende nachrichten von und an mich)
  - geraet: IndexedDB, localStorage, caches loeschen, danach startet die app mit dem onboarding
  - entschieden (nutzer 2026-10-28): bei den kontakten alles loeschen (chats, bilder), der chat bleibt aber in der liste mit "Profil wurde geloescht", im chat dieselbe zeile
  - done 2026-10-28: `client/app/account.js`, `PROFILE_DELETED` (direkt + pfad C), `DELETE /api/account/:peerId` (`deleteIdentity`, tombstone, WS getrennt), geraet komplett geleert; tests server-test, e2e `profile-delete` (mit offline-kontakt); UC-58

## T23 Interaktionen: eine Zeile pro Person? (nutzer 2026-10-28, besprechen)
- [x] heute: jedes ereignis eine zeile (gleiche person + art innerhalb 10 min zusammengefasst); jemand kann mehrfach als "hat dir eine flamme geschickt" erscheinen
  - entschieden + done 2026-10-28: eine zeile pro person, neueste aktivitaet oben, zusammengefasst; badge zaehlt personen; e2e `grid-tabs`
  - nutzer: "ungewoehnlich aber nicht schlecht"
  - vorschlag: eine zeile pro person, neueste aktivitaet oben, kurz zusammengefasst ("flamme · 3x angesehen · zuletzt 18:05")
- [x] bug: "nur zeigen fuer" ohne waehlbare felder, wenn die app im chat-modus startet (aktives schema = chat-schema) (nutzer 2026-10-28)
  - done: regel nutzt immer das schema von "entdecken" (event: event-schema), neu zeichnen beim oeffnen von privatsphaere; e2e `audience` (start im chat-modus, mit altem code rot)

## T24 Rueckmeldungen (nutzer 2026-10-28)
- [x] neu laden in der chatliste und im profil klappt nicht gut
  - ursache: das pull-to-refresh des browsers war in chatliste und profil noch an und konkurrierte mit unserer geste; im profil gab es keine eigene
  - done 2026-10-29: browser-geste ueberall aus, runterziehen im profil (ganze seite bzw. profil neu laden); e2e `mobile-layout`
- [x] "nur zeigen fuer": als schalter ein-/ausschaltbar (regel bleibt gespeichert, wirkt nur wenn an); das badge "Regel aktiv" bleibt (gefaellt); zuruecksetzbar bleibt
  - done 2026-10-29: `audience-rule.enabled`, schalter neben dem badge, felder bei aus abgedunkelt; e2e `audience`
- [x] sprache: seitenerkennung fuer google translate kaputt?
  - befund: `index.html` hat fest `lang="de"`, auch wenn die app englisch anzeigt -> falsche erkennung; dazu `translate="no"` + `notranslate`, das schaltet uebersetzen bewusst ab
  - entschieden (nutzer 2026-10-29): nur die oberflaeche uebersetzen; deutsch/englisch sollen keinen uebersetzer brauchen
  - done 2026-10-29: `lang` schon im kopf richtig gesetzt (kein angebot mehr fuer DE/EN), sperre an `<html>`/meta entfernt, nutzerinhalte + eingabeleiste `translate="no"` (eingabeleiste: frueherer nachrichtenfeld-bug durch uebersetzen); tests `test/i18n.test.js`, `test/markup-actions.test.js`, e2e `i18n`
  - e2e-hinweis: `p2p-recovery` schlug im gesamtlauf einmal knapp fehl (wachhund-zeit unter last), einzeln 3/3 gruen
- [x] grid laedt die naechsten ringe nicht automatisch + "mehr laden"-knopf fehlt (nutzer 2026-10-29)
  - ursache: router meldete `hasMore` nur, wenn ring + 1 neue peers hatte; war der leer, endete das nachladen und der knopf blieb versteckt, obwohl weiter weg jemand war
  - done 2026-10-29: router sucht alle folgenden ringe und liefert `nextRing`, app springt direkt dorthin (auto bis ring 3, knopf bis 5), unter dem grid "Mehr laden" bzw. "Alle in Reichweite geladen"; tests server-test, chat-ui
- [x] hinweis "Peer is currently unavailable" spammt (nutzer 2026-10-29)
  - ursache: debug-toast bei jedem `PEER_OFFLINE_FALLBACK`, auch fuer hintergrund-versuche (grid-prefetch, wiederverbinden)
  - done 2026-10-29: toast nur fuer den offenen chat, hoechstens alle 5 min je peer, sonst nur debug-log; test `test/p2p-transport.test.js`
- [x] entdecken-chat: album- und video-knopf getrennt, sollen einer sein (nutzer 2026-10-29)
  - done 2026-10-29: medien-knopf (wie im flirt-modus) in allen chats ausser dem reinen freundes-chat (`media-combined`, `updateChatAlbumButton`); e2e `friends`
