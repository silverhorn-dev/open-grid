# Routing
- [x] in the kv database just should be the name and the thumbnail
- [ ] Keine Single-Root mehr: Echte Pages/Routes für State-Erhalt bei Refresh und native Smartphone-Zurück-Navigation

# general
- [ ] coloring
- [ ] general config for just chatting or smth else
- [ ] Optional den Cloudcache ausschalten können
- [x] split index.html into separate files (`client/app/*.js`, `client/styles.css`)
- [x] THE GUI IMPROVEMENT
  - [x] mobile first
    - [x] responsive like a smartphone application
    - [x] better menu experienc
      - on mobile
        - menu at the bottom 
          - menu contains grid, chat & profile
        - technikal stuff in the burger menu
          - top right corner for technical burger menu
        - Debug toggle to the technikal stuff

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
- [ ] better performance
  - [ ] er checkt sehr lange die verbindung, man sollte schneller offline sein.
  - [ ] es sollte einen silent modus geben wo man zwar im router ist und zum chat verfügbar ist aber nicht im grid ist
  - [ ] GEO
	  - [ ] die geolocation sollte beim registrieren an den router übergeben werden
		  - Der Router darf die geolocation niemals weitergeben
	  - geolocation != echte location
		  - am client wird zwar eine adresse angegeben, aber an den server werden die KOOrdinaten dieser gemeldet, damit dieser rechnen kann.
		  - mann hat im profil die möglichkeit eine echte adresse einzugeben
			  - validierung mit google oder einer open api
			  - optional sichtbarkeit
		  - der router gibt die profile mit der entfernung zur eigenen loc zurück
			  - heißt, man sieht die ungefähre entfernung
		  - ist das ne gute idee, oder sollte man die aktuelle genaue pos übergeben
			    sollte man einstellen können!
- [ ] Konfigurierbare Profil-TTL: "Live"-Modus checkt Online-Status im Grid, bevor das Profil sichtbar wird

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
  - [ ] normale Chat-Funktionen: reagieren, antworten (auch auf eigene), suchen, markieren
  - [ ] Foto- & Medienwelt:
    - [ ] Medien-Übersicht des Chats
    - [ ] Geteilte Alben im Chat: Deckfoto anzeigen, erneuter Klick öffnet das Album

## status
- [ ] aktuell kann der status P2P Connected ausgelesen werden. im debug sollte das so sein. ohne würde ich da analog zu snap :eyes: platzieren
- [ ] nachrichtenstatus hnäg teilweise bei establishing secure channel

## Snapping 
- [ ] enable it
  - [ ] use camera
	  - [ ] hier funkt die kameraanbindung nicht so gut
  - [ ] better gui
  - [ ] bilder können im PCache landen, aber da gibt es eine TTL also sollte der sender auf das ablaufen dieser gefasst sein. 
  - [ ] angelehnt an die snapchat GUI

# Debug
- [x] wenn man nicht im debug modus ist sämtliche technischen bezeichnungen aus sein, bezieht sich nicht nur auf den chat
- [x] die ganzen notifications mit warnungen und technischen hinweisen und fehlern sollten nur im debugmodus erscheinen.

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

# Push (feature request)
- [x] Web Push via VAPID, sender ciphertext travels inside the push
- [x] service worker stores message in IndexedDB + ACKs the queue
- [x] notification click opens the chat
- [x] test on real devices (Android Chrome, Firefox, iOS PWA)

# Media & Albums (Access Control)
- [ ] Mehrere Alben unterstützen
- [ ] Zugriffssteuerung pro Album: teilen / nicht mehr teilen (Revoke-Management)

# Advanced Encryption (Media & Performance)
- [ ] Rolling-Key / Double-Key Verfahren für Medien:
  - [ ] Zusammengesetzter Key: Schlüssel Sender + Key Empfänger = Media-Key
  - [ ] Schlüssel rotieren/ablaufen lassen (z.B. per Hour-Flag)
  - [ ] Parameterisiertes Verfahren: Nur der Client-Schlüssel wird manipuliert, nicht die rohen Daten neu verschlüsseln (CPU schonen)
  - [ ] TTL für Verschlüsselungs-Parameter (stündlicher Wechsel, vom Client pünktlich getauscht)
  - [ ] Verlässliche Server-Zeit für Rotation (Geräte-Zeit ignorieren wg. Manipulationssicherheit)

# Privacy & Location (Anti-Triangulation)
- [ ] Grid-Snapping (Fuzzy Location): Koordinaten mathematisch auf den Mittelpunkt der Geohash-Zelle runden, um Trilateration zu verhindern
- [ ] Safe Zones (Privacy Bubbles): Eigene Geofences (z. B. Zuhause, Arbeit) definieren, in denen der Client automatisch aus dem Grid verschwindet

# E2E View-Once & Watermarking
- [ ] Kryptografisches Zeroing: Symmetrische Schlüssel für ephemere Medien (Snaps) nach X Sekunden im RAM mit Nullen überschreiben
- [ ] Personalisierte Steganografie-Wasserzeichen: Empfänger-ID als Rauschen ins Bild rechnen (Leaker-Identifikation bei Screenshots)

# Matching & Chat-Modi
- [ ] 3-stufige Chat-Berechtigungen (jederzeit wechselbar):
  - [ ] A (Alles): Jeder Peer kann uneingeschränkt schreiben
  - [ ] B (Eingeschränkt): Max. 5 Nachrichten (optional ohne Bilder) bis zum gegenseitigen "Match"
  - [ ] C (Nur Matches): Chat ist blockiert, bis auf "Match" geklickt wurde
- [ ] Flame / Match Ping Logik: Leichtgewichtiger Interaktions-Ping (ähnlich Grindr Taps) zum Signalisieren von Interesse und Triggern von Matches
- [ ] 3-stufige Profil-Sichtbarkeit:
  - [ ] Stufe 1: Alles sofort für jeden im Grid sichtbar
  - [ ] Stufe 2: Teilsichtbar (Eine Hälfte oder die Bilder-Galerie erst nach "Match" sichtbar; erzeugt optionalen Ping)
  - [ ] Stufe 3: Unsichtbar (Profil-Details und Bilder erst nach "Match" sichtbar; erzeugt zwingend Ping)

# Hyperlocal Mesh (Festival/Club Mode)
- [ ] WebRTC over LAN: mDNS und lokale Host-Kandidaten aggressiv priorisieren
- [ ] Offline-Mesh: Direkter Traffic im selben WLAN (z. B. auf Prides/in Clubs) ohne Cloud-Routing
