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

## Hyperlocal Mesh (Festival/Club Mode)
- [x] WebRTC over LAN: mDNS und lokale Host-Kandidaten aggressiv priorisieren
  - done P7: `LAN_MODE` (server) und "nur lokales netz" (geraet) -> keine STUN/TURN, nur host/mDNS; verbindungsart per `getStats()` ("im selben WLAN"); STUN standardmaessig ueber den eigenen coturn statt google (`STUN_SERVER`)
  - plan: naechste iteration: host candidates bevorzugen (mDNS nicht strippen), STUN-loser club-modus
- [x] Offline-Mesh: Direkter Traffic im selben WLAN (z. B. auf Prides/in Clubs) ohne Cloud-Routing
  - done P7: README "Club-/LAN-Betrieb": server im event-WLAN mit `LAN_MODE=true`; HTTPS pflicht (lokale CA oder DNS-01); mesh ganz ohne server in einer PWA nicht moeglich (keine lokale geraetesuche)
  - plan: naechste iteration: PWA hat keine lokale discovery API -> signaling server muss im LAN laufen (limitation)

# feat
- [x] chat badges
  - [x] chat needs a badge
  - [x] chats in chatoverview need a badge
  - done 2026-10-26: `client/app/unread.js`; zahl je chat (liste, kontaktleiste, schnellwechsel), summe am chat-tab, seitentitel, app-symbol; punkt am listen-wechsel; lesestand nur lokal (`keys`/`chat-reads`); tests `test/unread.test.js`, e2e `unread-badges`

## chat improvements

# bugs
