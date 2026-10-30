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

# bugs


# SNAPPING

## improvements
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

