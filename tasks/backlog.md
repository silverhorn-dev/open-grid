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
- [ ] chat badges
  - [ ] chat needs a badge
  - [ ] chats in chatoverview need a badge