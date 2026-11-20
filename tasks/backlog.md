# Backlog
> move things to board when implementing them
Ideen ohne festen Termin. Neue Phasen werden von hier auf `tasks/board.md` geholt.

# client security

- [ ] lets build a real application for android
  - [ ] a special browser for displaying the pwa webapp
  - [ ] signs the requests securely to ensure no manipulated client was used
  - [ ] prevents screenshots/recordings
  - [ ] in the settings there is an option to just send video and image files, if the other client is signed
    - [ ] not for profile data, audio files, and secure streaming snaps.
    - this whole setting/feature (i mean the checking if the other client is signed) can be disabled on the router per DEFAULT config
  - [ ] native API fuer die PWA zum senden/empfangen von bildern im hintergrund/offline (spart akku) -> plan auf dem board unter T4

## Mehrgeraete-Betrieb (nutzer 2026-11-01, "music of the future")
- [x] (2026-11-10, board T36 P4) dieselbe identitaet auf mehreren geraeten gleichzeitig (z. B. PC + handy oder zwei handys): chats, matches, freunde ueberall; kopplung per QR (wie der geplante umzug PWA -> app, `documentation/ANDROID-APP.md`), dazu sync zwischen den eigenen geraeten

## Hyperlocal Mesh (Festival/Club Mode)
- [x] WebRTC over LAN: mDNS und lokale Host-Kandidaten aggressiv priorisieren
  - done P7: `LAN_MODE` (server) und "nur lokales netz" (geraet) -> keine STUN/TURN, nur host/mDNS; verbindungsart per `getStats()` ("im selben WLAN"); STUN standardmaessig ueber den eigenen coturn statt google (`STUN_SERVER`)
  - plan: naechste iteration: host candidates bevorzugen (mDNS nicht strippen), STUN-loser club-modus
- [x] Offline-Mesh: Direkter Traffic im selben WLAN (z. B. auf Prides/in Clubs) ohne Cloud-Routing
  - done P7: README "Club-/LAN-Betrieb": server im event-WLAN mit `LAN_MODE=true`; HTTPS pflicht (lokale CA oder DNS-01); mesh ganz ohne server in einer PWA nicht moeglich (keine lokale geraetesuche)
  - plan: naechste iteration: PWA hat keine lokale discovery API -> signaling server muss im LAN laufen (limitation)

# general

- (2026-10-26 auf das board verschoben: alter/e-mail pruefen)

# feat
- [x] chat badges
  - [x] chat needs a badge
  - [x] chats in chatoverview need a badge
  - done 2026-10-26: `client/app/unread.js`; zahl je chat (liste, kontaktleiste, schnellwechsel), summe am chat-tab, seitentitel, app-symbol; punkt am listen-wechsel; lesestand nur lokal (`keys`/`chat-reads`); tests `test/unread.test.js`, e2e `unread-badges`

- (2026-10-26 auf das board verschoben: bereich beim onboarding waehlen)

## chat improvements
- [x] (2026-11-09 auf das board verschoben: T34) GIFs im chat (nutzer 2026-11-05: "giphy integration or smth like that"; "git integration" vermutlich auch gemeint = GIF)
  - notizen 2026-11-05 (noch nicht besprochen):
    - giphy ist ein externer dienst -> wie nominatim (entscheidung 2026-10-23) nur opt-in, suche direkt aus dem browser auf klick; die suchbegriffe + IP gehen an giphy, nie chats/profile
    - variante A "router-proxy": suche + download laufen ueber den router (`/api/gif/search?q=`), giphy sieht nur den router, nicht den nutzer; api-key liegt beim betreiber (`GIPHY_API_KEY`), ohne key ist die funktion aus; nachteil: router sieht suchbegriffe, mehr last + traffic
    - variante B "direkt": browser fragt giphy selbst (key von `/api/config`); einfacher, aber IP + suchbegriffe bei giphy; braucht eintrag in der CSP (`connect-src`/`img-src`)
    - wichtig fuer beide: das GIF NICHT als giphy-link senden, sondern als datei (wie bilder, P2P/pfad C, AES-GCM) -> der empfaenger laedt nie etwas von giphy, keine tracking-pixel, geht auch offline
    - format: giphy liefert auch MP4/WebP (kleiner als .gif) -> als kurzes stummes video in endlosschleife zeigen; groessen-limit wie bilder (pfad C max. 256 KB chiffrat -> kleine rendition waehlen)
    - giphy-auflagen pruefen: "Powered by GIPHY"-hinweis, api-key (rate limits), nutzungsbedingungen fuer self-hosted apps; alternativen ansehen (z. B. Tenor; was davon noch angeboten wird, vorher pruefen)
    - privacy-variante C "eigene sammlung": betreiber legt ein GIF/sticker-paket auf den router (`data/gifs/`), kein externer dienst; plus "eigene GIFs": aus einem kurzen video im snap-editor ein GIF/loop machen und als favorit lokal (IndexedDB) speichern
    - UI: knopf neben dem emoji/anhang im chat-eingabefeld, suche mit raster, zuletzt benutzt + favoriten lokal; NSFW-filter (`nudity`) und die alters-einstellungen beachten (giphy `rating=g/pg` je nach bereich)
    - vorschlag: erst C (eigene sammlung + eigene loops, kein fremder dienst), dann A als betreiber-option; B nur, wenn der betreiber es ausdruecklich will

### group chats

- [x] group chats with more participating nodes (2026-11-10, board T36 P0-P2)
- [x] swarm sending/caching/routing of images (2026-11-10, board T36 P3)
- [x] lesser usage of the router cache (2026-11-10: originale nur P2P/schwarm, gruppen gebuendelt; board T36 P2c/P3)
- [x] Check the chat hist handshake for exchanging new chat actions (2026-11-10, board T35)
	- [x] does the running ids work right? -> ja, eindeutig und idempotent (SPECE "Pruefung des Chat-Syncs")
	- [x] offline states? -> abgelaufene pfad-C-nachrichten werden jetzt erneut zugestellt; zu grosse sync-pakete behoben

# bugs

- [x] messages sind nicht vollständig swipeable (bei content wie vorschau, bilder oder snaps) -> 2026-11-01 behoben: wischen startet auch auf inhalten (siehe board T29)
- [x] das profil bei exploring scheint nicht das exploring profil zu sein? Ah ich habs analysiert (2026-11-01: schalter entfernt, immer zwei profile, einrichten schreibt in beide; siehe board T28)
	- es liegt daran dass man theoretisch 2 Profile pflegen kann das aber über die option eigenes profil ausschalten kann. nimm diese option samt schalter über dem profil raus, es sollte in jedem fall 2 Profile geben, das was man als erstes hatte bzw beim einrichten sollte in beide geschrieben werden, nicht beides aber ausfüllen müssen. ergo gibt es felder die in beiden existieren sollten beide gefüllt werden ansonsten bleibt das andere leer.

# SNAPPING

## improvements
- [x] (2026-11-09 auf das board verschoben: T33) snap-editor: mehr filter und sticker (nutzer 2026-11-05: "could be more filter or more sticker but its okay")
  - notizen: filter per canvas/CSS-filter (s/w, vintage, waerme, kontrast, unschaerfe), live in der kamera-vorschau; mehr sticker-packs (emoji-sets, ort/uhrzeit/datum-sticker, umfrage-sticker?); alles lokal, keine externen assets; ggf. mit dem GIF-paket aus "chat improvements" teilen
- (2026-10-27 auf das board verschoben: video-flackern, secure-snap-bugs, speicherbar-schalter)
- (2026-10-27 auf das board verschoben: kontaktleiste z-achse, wischen in snap-vorschau, editing improvement)
- [x] einladung im dating-modus (entdecken): unter 18 kann die einladung nicht oeffnen; im chat-modus normal (nutzer 2026-10-27, haengt an T2 alter) -> umgesetzt 2026-10-30, siehe board T2
- [x] chat-threads besprechen (nutzer 2026-10-27; umgesetzt 2026-10-28, siehe board T11): technisch nur EIN chat pro person statt zwei listen; nachrichten aus dem entdecken-bereich werden im social-bereich ausgeblendet
  - ablauf: match -> chat (entdecken) -> adden -> chat (social); im social-chat ein knopf wie "ausgeblendeten hot-chat wieder anzeigen"
  - nur wenn der entdecken-bereich beim nutzer aktiv ist
  - offen: was passiert mit den zwei listen / dem listen-wechsel, ungelesen-zaehler je bereich, snaps/alben aus dem entdecken-teil, wer sieht was beim gegenueber
  - ist-stand (geprueft 2026-10-28): technisch gibt es schon nur EINEN verlauf pro person (`messages` je `peerId`); jede nachricht traegt `scope` (`discovery`/`social`, chat.js); die liste haengt an `chatScopeOf` (freund -> immer social), d. h. nach dem adden wandert der ganze verlauf inkl. entdecken-teil in "Chat & Freunde"
  - vorschlag 2026-10-28 (noch nicht bestaetigt):
    - kein datenmodell-umbau: im social-blick werden nachrichten mit `scope: 'discovery'` ausgeblendet (nur anzeige, nichts geloescht)
    - oben im verlauf eine zeile "Entdecken-Verlauf ausgeblendet (N)" -> tippen blendet ihn fuer diesen chat ein/aus (merken je chat in `keys`)
    - nur wenn der entdecken-bereich beim nutzer aktiv ist; sonst bleibt der teil einfach versteckt
    - jede seite entscheidet fuer sich (gegenueber merkt nichts), ungelesen-zaehler zaehlt nur sichtbare nachrichten
    - snaps/alben aus dem entdecken-teil: mit ausgeblendet; laufende ansichten/limits laufen normal weiter
    - offen: im entdecken-blick (vor dem adden) aendert sich nichts; nach dem adden noch flammen-chat in "Grid & Event" zeigen? (vorschlag: nein, ein ort pro person)

## Ideen 2026-10-28 (nutzer, noch nicht besprechen)
- [x] grid improvement: filter, matches, interests, views (umgesetzt 2026-10-28/29, siehe board T20/T21)
  - per einstellung konfigurierbar: grid zeigt nur profile mit bestimmtem profil-tag (z. B. alter, tribes)
  - anlass: neue invite/match-funktion
- [x] mit der altersverifikation (T2): im entdecken-bereich sehen/kontaktieren sich nur minderjaehrige untereinander und 18+ untereinander -> umgesetzt 2026-10-29 (board T3/T2, UC-61)
  - social ("Chat & Freunde") ist davon nicht betroffen
  - dafuer im social-bereich ein nicht abschaltbarer nacktbild-scan (T3) fuer diese faelle
  - abschaltbar nur per router; die router-option wird NICHT dokumentiert, das verhalten (scan aktiv) aber schon
  - haengt an T2 (alter) und T3 (modell); passt zur backlog-notiz "einladung im dating-modus: unter 18 kann nicht oeffnen"

## Admin-Panel fuer die Web-App (nutzer 2026-10-29)
- [x] betreiber-oberflaeche statt nur env-variablen und `scripts/safety-admin.mjs` -> umgesetzt 2026-10-29 als board T25
  - ideen: status (version, peers online, queue-groesse, push), router-standards (`CLIENT_DEFAULTS`, `AUDIENCE_MINIMUM`, nacktbild-modell/schwelle), nachweise (alters-anker der EU-liste, eigene zertifikate, sperren), meldungen (leak mit wasserzeichen -> sperre), logs
  - live-konfiguration (nutzer 2026-10-29): einstellungen zur laufzeit aendern, ohne neustart/neues deployment; env bleibt der startwert, aenderungen aus dem panel liegen in der datenbank und gewinnen
  - offen: zugang (eigener admin-schluessel/passkey, nur aus dem LAN/per tunnel?), welche einstellungen live gehen (z. B. CLIENT_DEFAULTS, AUDIENCE_MINIMUM, nacktbild-modell/schwelle, nachweis-pflichten) und welche einen neustart brauchen (ports, datenbank, TURN), getrennte route/seite (CSP wie die app), nie nutzerinhalte (die hat der router ohnehin nicht)
- [ ] FR (nutzer 2026-11-12): aus dem admin-panel mit teilnehmern kommunizieren koennen, falls noetig (z. B. nach meldungen, bei stoerungen, ankuendigungen); dafuer admins/mods bestimmen
  - ideen: betreiber-konto als eigener peer ("Betreiber"/"Moderation", kennzeichnung im chat), schreibt E2E wie jeder andere (router sieht weiter nur ciphertext); mods = vom admin benannte peers mit rechten im panel (meldungen ansehen, antworten); rundschreiben an alle evtl. nur als hinweis-banner ohne inhalt in der queue
  - offen: wie werden mods benannt und geprueft (signierte ernennung durch den admin?), was duerfen sie, abschaltbar fuer nutzer?, missbrauchsschutz (kein massen-spam), kein mitlesen fremder chats

# Security

## Hackathon

> to harden things diffrent things should be tried to Hack OG, infrastruktur, protocols, Caching, Turning, everything

- [x] Try to hack into a P2P Conn or read it (2026-11-10: S5 keine forward secrecy offen, sonst ok; `documentation/SECURITY-HACKATHON.md`)
- [x] Try to hack into a client via a P2P connection (S1 behoben, S10 ok)
- [x] Try to hack user via profile request (S2 behoben)
- [x] Try to Modify client, so u can read things you shouldnt read (S12: verschleierung bringt nichts, schutz ueber pruefungen beim empfaenger/router)
	- [x] Implementation of some hashing over the pwa code to ensure things arent touched. -> verworfen (S12), siehe tasks/rejected.md
		- special characters at special positions.
		- js encription? how do u call it, make things very difficult to read, or unreadable. 
			- maybe after the deploy, app code should be readable in the repo, but not in the app? (optional)
- [x] try to listen or catch messages running over the turn server (S11: nur metadaten)
- [x] try to read the reouter cache of other users (S9: token des empfaengers noetig)

# bug and features requests

- [ ] setting for message preview in android message center doesnt apply instantly
- [ ] multi-device: bei chatpartnern erscheint man doppelt (je geraet ein eintrag statt einer person; nutzer 2026-11-19)
- [ ] besides the web client version the apk version should be shown
- [ ] voice messages crashes the apk
- [ ] in apk the cam shows a grey image for 2 seconds before actual cam has loaded
- [ ] profile image doesnt get fetched (the original) or viewed on viewer
- [x] on apk if ur offline it gets buggy, u cant reload usw (2026-11-20 nutzer: mit app 0.3.5 ist offline alles da; offline-modus ab N nachrichten verworfen -> tasks/rejected.md)
	- in the webapp and on apk if offline no data shown up. Well thats actually kinda good and bad yk? we wanna change that if someone has at least one chat witch more than i dont know configurable messages defult is 20? 
		- when hittet this message count, the client also lives offline
- [ ] we need a speech to text function for voice messages in chat, also the own ones.(lokal model obv.)
- [ ] on startup we dont wanna load full app, models just as soon as there gonna be used, ig incoming pic and vids or when transcibing the voice messages. Use a model per configured langueage
- [ ] in the message center when shown message content we couldnt reply maybe this would be a nice functino
- [ ] profile ex and import for backups or things.
- [ ] pin lock
	- [ ] biometry look for apk
- [ ] snap videos? (nutzer 2026-11-20: spaeter; reihenfolge jetzt B offline-modus, dann C sprach-verschriftlichung)
	- plan (2026-11-20): ausloeser gedrueckt halten = video (max 30 s, kurz tippen bleibt foto), nur ziel "chat"; MediaRecorder auf dem kamera-stream, webm (blob-typ auf `video/webm` normieren, sonst passt `isSafeInlineVideo` nicht)
	- versand wie videos im chat (video.js): vorschaubild als `snapData`, video als `original` (nur P2P, sha256), modus snap = einmal-snap (`snapMode: 'replay'`), modus bild = dauerhaft
	- ton: in der app erst stumm (WebView-mikrofon beendet den renderer, siehe T38), im browser mit ton; spaeter nativ (CameraX)
	- empfaenger: replay-karte "Video-Snap", `openReplaySnap` spielt das original im secure-snap-viewer (`#secure-snap-video`), ohne original kein ansehen (zaehlt nicht); beim verbrauchen auch das original loeschen (`originalMediaId`) und `message.original` entfernen (sonst holt der client es neu), absender loescht seins nach `ownKeepUntil`
	- nacktbild-warnung ueber das vorschaubild (`confirmNudeSend`)
- [ ] sticker integration? (2026-11-20 aufs board: T39)
	- [ ] stickers shouldnt be saveable
	- [ ] favorisierbar
	- [ ] hat keinen message body außen drum
	- [ ] transparenz unterstützt, sollte autom gehen
	- [ ] FSK 18 Flag
	- [ ] ausschneide function (model or manual) just loaded when needed

# anti-cheat / integritaet (nutzer 2026-11-20)

- [ ] erweiterte sicherheit + anti-cheat
	- [ ] js-integritaet: eigene app prueft hashes ihrer js-dateien (gegen manifest vom router, sehr schnell)
		- hinweis: ohne attestierung umgehbar (wer js aendert, kann auch die pruefung aendern) -> nur als signal, hart erst mit app-attestierung (ANDROID-APP.md phase 4)
	- [ ] auffaellige verifizierung (z. b. dauert zu lange, frames passen zeitlich nicht) -> geraet als gefaehrlich einstufen und erst mal sperren (admin sieht es, kann freigeben)
	- [ ] screenshots erkennen und ggf. melden
		- hinweis: browser haben dafuer keine api; nur heuristiken (desktop: PrintScreen-taste, fenster verliert fokus). android-app: FLAG_SECURE blockiert ja schon, ab android 14 gibt es zusaetzlich einen screenshot-callback (Activity.ScreenCaptureCallback)
