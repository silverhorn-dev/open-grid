# bugs

- [x] discovering of new social chats happens just on klick on profile?
  - ursache: profil kommt nur ueber eine P2P-sitzung; erste nachricht ueber router-cache/push baut keine auf, erst der klick (PROFILE_REQUEST) tat es
  - fix 2026-10-26: `requestMissingProfile` (storage.js) bei neuem chat und wenn der peer online kommt (direkt, startet P2P) + schwarm-abfrage; je weg max. 1x/min; e2e `new-chat-profile`
- [x] u can swipe a message but the animation just comes at the first time?
  - ursache (wahrscheinlich): der kleine aktionen-pfeil sitzt oben links auf fremden nachrichten, genau wo der daumen ansetzt; ein wischen, das dort startet, wurde komplett ignoriert -> wirkte zufaellig
  - fix 2026-10-26: wischen startet in der ganzen zeile (auch auf dem pfeil, der dann nicht aufklappt), pointer capture; e2e `chat-gestures` (mobil, echte touch-events, 3x hintereinander)



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

## chat improvements
- [x] audio messages
  - if there is a lokal api for audio to text this function too, if not leave it
  - done 2026-10-26: `client/app/voice.js`, opus ~12 kbit/s, inline im MESSAGE_PUT (P2P oder pfad C, cache-limit 256 KB); mikrofon statt senden bei leerem feld
  - 2026-10-26 (wunsch): laenger als 60 s (bis 15 min): ab 60 s zweiter recorder, rest als original nur per P2P, wiedergabe wartet am ende des anfangs und laeuft weiter, sobald der rest da ist; kein auto-senden am maximum; e2e `voice-video`
  - verschriftlichung nur lokal: `SpeechRecognition` mit `processLocally` (chrome, sofern `available`); sonst kein text. die normale web speech api schickt audio an google -> verboten
- [x] videos?
  - only via __p2p__
  - done 2026-10-26: `client/app/video.js`, vorschaubild + infos in der nachricht, video ueber den original-weg (originals.js, nur DataChannel), max 25 MB; e2e `voice-video`
- [ ] ui ux improvement
  - einheitlichkeit & modularität
    - modularerere gestaltung
  - besseres UX
  - 2026-10-26 bestandsaufnahme (screenshots mobil/desktop, hell/dunkel), nutzer waehlt aus:
    - plan: U1 sprache einheitlich deutsch: profil-felder "Display Name", "Age", "Position / Role", "About Me" + englische beispielwerte ("Privacy-first tech enthusiast!"), grid "6 peers • Updated 01:54:30 PM", "Enable Notifications", kontaktleiste "offline"
    - plan: U2 zeitformat einheitlich: chatliste "01:54 PM" (locale des browsers), nachrichten "21:01", grid mit sekunden -> ueberall 24h ohne sekunden (bzw. "gestern", datum)
    - plan: U3 einstellungen: eine sehr lange seite (~9 bildschirme) -> abschnitte mit sprungleiste/tabs (Konto & Modus, Chat, Privatsphaere, Medien & Snaps, Benachrichtigungen, Darstellung); chat-wechsel-optionen stehen unter "Darstellung", wasserzeichen unter "Secure Snaps"
    - plan: U4 interne codes sichtbar: "1 - Alles fuer alle", "A - Alle" -> nur klartext
    - plan: U5 buttons: gleiche hoehe/form in der eingabeleiste (snap/video/mic unterschiedlich hoch), ein primaer-stil, ein sekundaer-stil, ein icon-knopf-stil als wiederverwendbare klassen (statt langer tailwind-ketten pro knopf)
    - plan: U6 desktop: avatar-leiste im chat doppelt zur sichtbaren chatliste -> auf desktop ausblenden; aktionen-pfeil auf desktop nur beim hovern
    - plan: U7 leere zustaende/ladeanzeigen einheitlich (grid leer, chatliste leer, "Chat wird geladen", album leer) mit gleichem icon+text-muster
    - plan: U8 profil-tab: "Speichern" oben rechts, aenderungen ohne hinweis auf ungespeichert -> sticky speicherleiste unten, sobald etwas geaendert ist
    - plan: U9 menue: nur 3 punkte, viel leerraum -> modus-wechsel, kontakt einladen und changelog/version mit hinein
