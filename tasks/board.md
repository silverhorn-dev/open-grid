# Routing
- [x] in the kv database just should be the name and the thumbnail

# general
- [ ] coloring
- [ ] general config for just chatting or smth else

# Grid
- [x] GRID layout improvement
  - [x] better popups
  - [x] better dynamic refreshing
- [x] persist P2P-loaded profile data in IndexedDB on the requesting client
  - [x] load cached profile data after refresh or browser restart
  - [x] refresh the local cache after receiving a newer P2P profile response
- [x] on smartphone there is the bug if i close the tab it is crushed, so there are multible profs
  - [x] steady handshake. on a refresh or a new peer the existent should be persisted (just in the loaded geo chunk)
  - [x] not reachable peer should be 'abwesend' or offline
    - [x] wenn sich jmd abgemeldet hat ist er ganz weg
- [] better performance
  - [] er checkt sehr lange die verbindung, man sollte schneller offline sein.
  - [] es sollte einen silent modus geben wo man zwar im router ist und zum chat verfügbar ist aber nicht im grid ist

# Chat
- [x] functional chat
  - [x] P2P got not initiated by click on chat
  - [x] handshake for messages implemented?
  - [x] der chat sollte auf beiden seiten persistent gespeichert sein
  - [x] wenn beide offline gehen und einer wieder on geht sieht er den chat nicht mehr
  - [x] delete cache! auf dem router. wenn jemand den chat l�scht oder jmd blockiert bleibt das persistent auf dem server
  - [x] jeder client pr�ft diese tabelle
  - [ ] unter den nachrichten stimmt beim empfänger die herkunft nicht immer, bei path c zb steht E2E P2P und nicht E2EE PC oder so
  - [x] blocking und chat delete sollte den chat jeweils vollständig löschen!
  - [x] im chat bereich sollten nicht alle peers erscheinen, nur jene zu denen ein chat existiert
## status
- [ ] aktuell kann der status P2P Connected ausgelesen werden. im debug sollte das so sein. ohne würde ich da analog zu snap :eyes: platzieren
- [ ] nachrichtenstatus hnäg teilweise bei establishing secure channel

## Snapping 
- [ ] enable it
  - [ ] use camera
  - [ ] better gui
  - [ ] 

# Debug
- [ ] wenn man nicht im debug modus ist sämtliche technischen bezeichnungen aus sein, bezieht sich nicht nur auf den chat

# Self-hosting
- [x] migrate Cloudflare Worker, KV, Durable Objects and metadata to Fastify
- [x] persist grid routing and encrypted message queue data in SQLite
- [x] serve the client-only PWA and WebSocket signaling from one container
- [x] add Docker Compose with a persistent SQLite volume
- [x] keep TLS termination outside the container for reverse-proxy deployments

# Onboarding
- [x] show a profile setup dialog before first registration
  - [x] render all configured profile fields
  - [x] validate required fields
  - [x] continue only after encrypted local persistence succeeds

# Chat synchronization
- [x] synchronize chat changes after offline periods
  - [x] compare the latest 20 operation IDs during the secure handshake
  - [x] reconcile older operation IDs in background pages
  - [x] propagate message deletions to the other client
  - [x] retain at most 100 delete tombstones per chat

# Path C
- [x] enqueue encrypted chat operations when direct P2P delivery fails
- [x] retrieve and decrypt queued operations after reconnect
- [x] delete server queue entries only after successful local application
- [x] persist non-exportable ECDH identity keys for cross-session decryption