# Backlog
> move things to board when implementing them
Ideen ohne festen Termin. Neue Phasen werden von hier auf `tasks/board.md` geholt.

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
- [ ] new swipe actions in chat
  - [ ] swipe header (the one with the contact info) down opens contact
  - [ ] swipe right for chats works for incomming chats also on the empty space besides the message
## chat improvements
- [ ] audio messages
  - if there is a lokal api for audio to text this function too, if not leave it
- [ ] videos?
  - only via __p2p__
- [ ] ui ux improvement
  - einheitlichkeit & modularität
    - modularerere gestaltung
  - besseres UX
  - 

# bugs
- [ ] u can swipe a message but the animation just comes at the first time?