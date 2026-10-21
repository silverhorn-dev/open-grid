# Routing
- [x] in the kv database just should be the name and the thumbnail

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
# Chat
- [x] functional chat
  - [x] P2P got not initiated by click on chat
  - [x] handshake for messages implemented?
  - [x] der chat sollte auf beiden seiten persistent gespeichert sein