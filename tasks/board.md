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

## T3 Nacktbild-Erkennung beim Empfaenger (idee 2026-10-26, besprechen)
- [ ] lokales modell auf dem geraet des empfaengers erkennt nacktbilder in chat-bildern/snaps/alben -> unscharf + "trotzdem ansehen"; bild verlaesst das geraet nie (passt zu E2EE)
  - kontext: app ist nicht fuer nacktbilder gedacht (galerien, normale fotos) -> JMStV-pflichten fuer jugendgefaehrdende inhalte greifen wohl nicht; schutz gegen ungefragte bilder trotzdem sinnvoll
  - vorbild: Bumble "Private Detector" (2022 open source, kommerziell nutzbar; lizenz/framework im repo pruefen), Apple Communication Safety, Instagram-Nacktschutz
  - offen: modell selbst ausliefern (keine CDN, regel 1), groesse (einige MB, lazy laden, im SW-cache), tf.js/onnx im browser + leistung auf alten handys, standard an/aus, auch absender-seitig warnen?
  - grenze: nur schutz, keine durchsetzung (eigener client kann es abschalten); kein melden an den server

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
- [ ] editing improvement
   - [x] emoties und text soll scalable sein, dafür muss man das item verschieben und dabei mit einem 2. Finger rein oder rauszoomen, am pc scrollen während man es dragt.
      - [x] dabei soll er auch drehbar sein, und jeweils bei 90 grad sn die achse snappen, also wenn er parallel zur seite oder dem boden ist.
      - done 2026-10-27: item `scale`/`rotation`, zweiter finger irgendwo, einrasten bei 90 grad (6 grad fangbereich, vibration); hintergrund mit zwei fingern zoomen/drehen/verschieben; pc: mausrad beim ziehen, shift = drehen; `flattenSnapDraft` mit transformationen
      - [ ] verschiedene textarten
      - [ ] opt. ein texthintergrund
   - [ ] die möglichkeit filter drüberzulegen, also s/W, farbenfroh, puff farben (rot), mit uhrzeit an verschiendenen stellen
   - noch weitere ideen anmerkungen?
  - ideen dazu (vorschlag 2026-10-27, noch nicht bestaetigt): loeschen per ziehen auf einen papierkorb, textausrichtung, ortsfreie sticker (uhrzeit, wochentag)

## Eigene rotierende Verschluesselung (geparkt, erst besprechen)
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
- [ ] tailwind 4 migration (behebt die 3 moderate `npm audit`-funde in dev-abhaengigkeiten)

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
