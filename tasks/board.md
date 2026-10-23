# Routing
- [x] in the kv database just should be the name and the thumbnail
- [x] Keine Single-Root mehr: Echte Pages/Routes für State-Erhalt bei Refresh und native Smartphone-Zurück-Navigation
  - done P3: `client/app/router.js`, routen `/grid` `/chat` `/chat/:peerId` `/profile` `/settings` `/cloud`, server liefert app-shell fuer alle, push oeffnet `/chat/<id>`
  - done P3: menue/profil/snap-modal = eigener history entry, zurueck schliesst modal

# general
- [ ] coloring
- [x] general config for just chatting or smth else (P8: App-Modi)
  - done P8: `client/app/modes.js`, `/api/config`, register `scope`/`eventHash`, freunde- und event-grid, einladungslink + QR mit fingerprint-pruefung, onboarding-auswahl, event auto-ende nach 12 h
  - done: test `client-state.test.js` verhindert nicht deklarierte `state`-felder (ursache des startup-crashs)
  - entschieden 2026-10-23: 4 modi (discovery, chat only, friends nearby, event/club); betreiber erlaubt modi (`APP_MODES`, `DEFAULT_APP_MODE`), nutzer waehlt (onboarding + einstellungen)
  - done: P8.1 server: `GET /api/config` {modes, defaultMode}; register `scope` (public|friends|event) + `eventHash`; public grid nur `scope=public`
  - done: P8.2 chat only: grid-tab weg, immer silent; kontakte per einladungslink `/invite#<peerId>.<fingerprint>` + QR (lokale lib), fingerprint wird beim ersten KEY_HELLO geprueft (MITM)
  - done: P8.3 friends nearby: `/api/grid?scope=friends` nur gegenseitige kontakte (presence-abos im server), mit distanz-buckets; fremde sehen einen nicht
  - done: P8.4 event: code -> SHA-256 im client, server sieht nur den hash; `/api/grid?scope=event&eventHash=`; auto-verlassen nach 12 h
- [x] klären ob die PWA offline funktioniert (letztens offline problem gehabt)
  - done: SW precache (versioniert, jede antwort geprueft), network-first fuer seiten mit app-shell-fallback, cache-first fuer assets; tailwind vorab kompiliert, font-awesome + platzhalter + icon lokal (keine CDNs mehr); offline-hinweis; update-banner mit knopf statt auto `skipWaiting`
  - offen: test auf echtem geraet im flugmodus (installierte PWA)
  - done: PNG-icons 180/192/512 fuer manifest + apple-touch-icon (iOS)
  - reihenfolge: erst nach allen phasen (nach P6), entschieden 2026-10-23
  - befund 2026-10-23: `client/sw.js` hat keinen `install`/`fetch` handler und nutzt keine Cache API -> app-shell laedt offline gar nicht (nur push laeuft im SW)
  - zusaetzlich: tailwind (`cdn.tailwindcss.com`, runtime JIT) und font-awesome kommen vom CDN -> offline kein styling/icons
  - plan: app-shell + `clientAssetFiles` beim install in einen versionierten staging cache laden, alle antworten pruefen (status 200), erst dann ist der SW installierbar (Hard rule 5, kein auto `skipWaiting()`)
  - plan: fetch handler: navigationen (`/grid`, `/chat/:id`, ...) -> network first, offline fallback auf gecachte app-shell; assets -> cache first mit `?v=` version
  - plan: CDN-abhaengigkeiten lokal ausliefern (tailwind als build-CSS statt runtime JIT, font-awesome css+fonts) oder mit-cachen
  - plan: offline-zustand im UI: grid/router nicht erreichbar -> lokale chats + cache weiter nutzbar (graceful failover auf IndexedDB), hinweis "offline"
  - plan: neuer SW wartet -> "Update verfuegbar" hinweis mit knopf (nutzer loest `skipWaiting` aus)
  - test: devtools offline + echtes geraet im flugmodus, installierte PWA neu starten
- [x] Optional den Cloudcache ausschalten können
  - done P2: `grid-settings.cacheEnabled` (default an), betrifft nur eigene nachrichten: aus -> kein Path C, op bleibt lokal (P2P/sync); eingehende Path-C-nachrichten kommen weiter an
  - plan: P2: aus -> sender skippt `queuePayloadInCache`; register flag `acceptsCache:false`, server lehnt `POST /api/cache` fuer diesen recipient ab
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
- [x] better performance
  - [x] er checkt sehr lange die verbindung, man sollte schneller offline sein.
    - plan: P1: presence probe 8 s -> 4 s (`probePeerPresence`, `client/app/chat.js`), P2P disconnect timer 5 s -> 3 s (`client/p2p.client.js`)
    - plan: P1: server broadcastet `PEER_OFFLINE` bei WS close (`server/signaling.js`) -> peers markieren sofort offline
  - [x] es sollte einen silent modus geben wo man zwar im router ist und zum chat verfügbar ist aber nicht im grid ist
    - plan: P2: `silent` column auf `peers` (`server/database.js`), flag in `/api/register`, `/api/grid` filtert silent peers
    - plan: P2: toggle in settings, bei aenderung re-register; signaling + Path C bleiben erreichbar
  - [x] GEO
    - done P2: geraetestandort (opt-in) -> lokal zu geohash 6 kodiert, nur die zelle geht an den router; router kuerzt auf 6 zeichen und gibt nie coords/geohash raus
    - done P2: buckets (entschieden 2026-10-23): Sehr nah (<1 km) / In der Naehe (1-5) / In der Stadt (5-20) / 20-100 / 100-300 / 300-500 / > 500 km
    - done P2: chunk loading: `/api/grid?geohash=..&ring=0-5`, ring 0 = eigene zelle, ring 1 = +8 nachbarn, ring 2-5 = praezision 5..2 + 8 nachbarn; nachbarn rechnet der router (`server/geohash.js`), `hasMore` steuert "Mehr laden", grid gruppiert nach bucket
    - done P2: adresse statt geraetestandort: browser fragt auf klick OpenStreetMap Nominatim (entschieden 2026-10-23: drittanbieter ok, wenn man den eigenen standort nicht nutzen will), nur zelle geht an den router
    - plan: offen: "optional sichtbarkeit" der echten adresse fuer andere (per P2P im profil) - noch nicht gebaut
	  - [x] die geolocation sollte beim registrieren an den router übergeben werden
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
- [x] Konfigurierbare Profil-TTL: "Live"-Modus checkt Online-Status im Grid, bevor das Profil sichtbar wird
  - done P2: `ttlMinutes` beim register (1/10/30/60, router clampt 1-60)
  - done P2: Live-Grid = `/api/grid?live=1`, router filtert auf peers mit aktivem WebSocket (statt P2P-probe pro tile, spart verbindungen)

# Chat
- [ ] bug: the icon bar after clicking the arrow icon menu have no background, therefore the are not well lookable
- [x] bug: arrow menu icon too big. on textmessages it should be in the message top corner and the text should be margined so it fits in
  - done: 24 px pfeil in der oberen ecke der bubble (eigene rechts, fremde links), text bekommt 2rem innenabstand; offen waechst der pfeil wieder und sitzt aussen an der leiste
- [x] functional chat
  - [x] P2P got not initiated by click on chat
  - [x] handshake for messages implemented?
  - [x] der chat sollte auf beiden seiten persistent gespeichert sein
  - [x] wenn beide offline gehen und einer wieder on geht sieht er den chat nicht mehr
  - [x] delete cache! auf dem router. wenn jemand den chat löscht oder jmd blockiert bleibt das persistent auf dem server
  - [x] jeder client prüft diese tabelle
  - [x] unter den nachrichten stimmt beim empfänger die herkunft nicht immer, bei path c zb steht E2E P2P und nicht E2EE PC oder so
    - plan: P1: `applyChatOperation` (`client/app/storage.js`) bekommt `deliveredVia` param statt hardcoded `E2EE P2P`
    - plan: P1: Path C retrieval -> `Encrypted Path C`, sync -> `E2EE Sync`, SW bleibt `E2EE Push`
  - [x] blocking und chat delete sollte den chat jeweils vollständig löschen!
  - [x] im chat bereich sollten nicht alle peers erscheinen, nur jene zu denen ein chat existiert
  - [x] normale Chat-Funktionen: reagieren, antworten (auch auf eigene), suchen, markieren
    - done P3: antworten (`replyTo` in `MESSAGE_PUT`), reagieren (op `MESSAGE_REACT`, 6 emojis, neueste pro absender gewinnt), markieren (lokal `starred`), suchen (lokaler filter + nur markierte)
    - note: SW wendet weiter nur `MESSAGE_PUT` an; reactions schicken keinen push und bleiben in der queue bis die app sie abholt
  - [x] Foto- & Medienwelt:
    - [x] Medien-Übersicht des Chats
      - done P4: knopf im chat-kopf, zeigt alle snaps + geteilten alben, klick = gross / album oeffnen
      - [x] opt. switch eigene, andere, beide
        - done: umschalter Beide/Eigene/Andere oben in der medienuebersicht, auswahl bleibt in der sitzung
    - [x] Geteilte Alben im Chat: Deckfoto anzeigen, erneuter Klick öffnet das Album
      - done P4: `message.album` mit deckfoto (max 30 KB), klick laedt album per P2P (`ALBUM_REQUEST`), besitzer muss online sein

## status
- [ ] the status is from time to time very fuzzy
- [x] aktuell kann der status P2P Connected ausgelesen werden. im debug sollte das so sein. ohne würde ich da analog zu snap :eyes: platzieren
  - plan: P1: pill bleibt `debug-only`; ohne debug zwei zustaende als icon:
  - plan: P1: P2P/E2EE connected -> gruener punkt
  - plan: P1: peer hat den chat offen -> :eyes: icon, neues P2P payload `CHAT_FOCUS {open}` (chat open/close + `visibilitychange`), reset bei disconnect, nur ueber DataChannel
- [x] nachrichtenstatus hängt teilweise bei establishing secure channel
  - plan: P1: fallback timer im queue-zweig von `sendSecurePayload` (~10 s -> `queuePayloadInCache`, sonst `Pending`)
  - plan: P1: beim laden haengende labels zuruecksetzen

## Snapping 
- [x] enable it
  - befund P4: snap-modal markup fehlte seit dem split von index.html (`3530481`), nur das JS war noch da
  - [x] use camera
	  - [x] hier funkt die kameraanbindung nicht so gut
	  - done P4: front/rear switch, fallback `{video:true}`, kamera wird beim schliessen immer freigegeben, bild aus galerie als fallback
  - [x] better gui
  - [x] bilder können im PCache landen, aber da gibt es eine TTL also sollte der sender auf das ablaufen dieser gefasst sein. 
    - done P4: snaps max 70 KB data-URL (passt immer in Path C), sender speichert `cacheExpiresAt`, bestaetigung ueber chat-sync (`deliveryConfirmed`), sonst hinweis "nicht abgeholt - wird bei der naechsten direkten verbindung zugestellt"
  - [x] angelehnt an die snapchat GUI
    - done P4: vollbild, runder ausloeser, vorschau mit bildunterschrift, nochmal/senden

## Bugs (2026-10-23)
- [x] bottom bar ueberlappt ueberall den inhalt
  - done: tailwind `p-4` (zur laufzeit eingefuegt) hat das `padding-bottom` von `.app-main` ueberschrieben -> `!important`
- [x] profil: "ueber mich" feld zu klein
  - done: volle breite, 6 zeilen, waechst mit dem text
- [x] icons fuer antworten/reagieren/... zu klein
  - done: 36 px buttons in einer leiste, die zur haelfte ueber der nachricht sitzt (desktop: hover, touch: tipp auf die nachricht)
- [x] bilder kann man nicht richtig anschauen -> eigener viewer
  - done: `client/app/viewer.js`, vollbild, wischen zum blaettern, pinch/doppeltipp/mausrad-zoom, verschieben, nach unten wischen schliesst; fuer snaps, alben, medienuebersicht und profilbilder
- manchmal denkt der client er ist offline obwohl man einfach lang nicht mehr reloaded hat

## Bugs (2026-10-23, runde 2)
- [x] image viewer: seitwaerts wischen sehr abgehackt
  - done: 3-slide-spur (vorher/aktuell/naechstes), updates per requestAnimationFrame, groessen nur beim gestenstart messen, schnelles wischen zaehlt auch bei kurzer strecke
- [x] nachrichten etwas groesser + konfigurierbar
  - done: standard 15 px statt 12 px, einstellung "Darstellung" (klein/normal/gross/sehr gross), pro geraet
- [x] snaps standardmaessig nur einmal ansehbar + einmal wiederholbar, "speichern" behaelt ihn; nur bei normalen snaps, secure snaps nie speicherbar
  - done: `snapMode: 'replay'`, nach der wiederholung wird das bild auch aus dem operations-log geloescht; alte snaps bleiben wie sie sind
- [x] smartphones: aktionen nur per tipp auf die nachricht, kein hinweis
  - done: pfeil (chevron) an der aussenseite jeder nachricht auf touch-geraeten, tipp ausserhalb schliesst
- [x] eigene nachrichten: aktionsleiste ragt aus dem bildschirm
  - done: eigene rechtsbuendig, fremde linksbuendig
- [x] wischgesten -> feature request `tasks/feature-request-gestures.md`
  - done: wischen = antworten, lange druecken = aktionen, doppelt tippen = herz, tabs seitlich wischen, fenster nach unten schliessen, chat am ende hochziehen = aktualisieren, "kopieren"-aktion (`client/app/gestures.js`); kante + pull-to-refresh bleiben bei OS/browser (entschieden)
  - ein reload sollte einen seiten reload wenn möglich triggern, diese popum messages nerven
  - fix nebenbei: schriftgroessen-regel war seit `840764d` versehentlich geloescht, wiederhergestellt + test
  - plan: P1 = wischen zum antworten, long press = aktionen, kante wischen = zurueck; offene fragen im FR abschnitt 7

## Bugs (2026-10-23, runde 3)
- [x] online-status haengt am geohash: chat-partner nur online, wenn beide im selben grid geladen sind
  - done: presence fuer chat-partner ueber den signaling-server (`PRESENCE_SUBSCRIBE`/`PRESENCE`), unabhaengig von zelle + silent; nur gegenseitig, nie bei block; kein "zuletzt online" gespeichert (entschieden)
  - done: `PEER_OFFLINE` war O(N) DB-abfragen pro verbindungsende (O(N^2) gesamt) -> zellen-index im speicher
  - done: partner kommt online + wartende nachrichten/offener chat -> P2P sofort aufbauen
- [x] chat-menue-pfeil rechts-/linksbuendig und als aeusseres icon der leiste, damit man sie wieder zuklappen kann
  - done: pfeil ist teil der aktionsleiste (eigene: ganz rechts, fremde: ganz links), zu = nur pfeil an der bubble-ecke, tipp klappt auf/zu

## Bugs (2026-10-23, runde 4)
- [x] startup: "Startup failed: Cannot read properties of undefined"
  - ursache: `state.matchState` war in `config.js` nicht deklariert; chatliste/grid rufen `isMatched()` beim laden (`loadChatPeerIds`, `loadCachedGridPeers`) bevor `loadMatchState()` das objekt anlegt -> crash bei allen, die schon chats haben (seit P6)
  - done: `matchState: {}` in `state`; statische pruefung: alle anderen `state.*`-felder sind deklariert
  - offen: e2e-test mit echtem browser (playwright) - platte war voll

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
- [x] Mehrere Alben unterstützen
  - done P4: store `albums` (IndexedDB v8), verwaltung im profil, `client/app/albums.js`
- [x] Zugriffssteuerung pro Album: teilen / nicht mehr teilen (Revoke-Management)
  - done P4: teilen = peer in `acl` + chat-nachricht; entziehen = aus `acl` + `ALBUM_REVOKED`, `IMAGE_REQUEST` prueft `acl`
  - done P5: entziehen erhoeht `keyVersion` (rolling keys)

# Advanced Encryption (Media & Performance)
- [x] Rolling-Key / Double-Key Verfahren für Medien:
  - entschieden 2026-10-23: gilt fuer alben + view-once; alte medien laufen ab (nur ciphertext beim betrachter, schluessel pro epoche neu holen); epoche serverseitig `MEDIA_KEY_EPOCH_MINUTES` (test 5 min, echt 180 = 3 h, siehe `compose.yaml`)
  - [x] Zusammengesetzter Key: Schlüssel Sender + Key Empfänger = Media-Key
    - done P5: HKDF(albumgeheimnis des besitzers, album + keyVersion, bild + betrachter-ID)
  - [x] Schlüssel rotieren/ablaufen lassen (z.B. per Hour-Flag)
    - done P5: schluessel nur im RAM des betrachters, verfallen bei `epochEndsAt`; entziehen erhoeht `keyVersion`
  - [x] Parameterisiertes Verfahren: Nur der Client-Schlüssel wird manipuliert, nicht die rohen Daten neu verschlüsseln (CPU schonen)
    - done P5: der betrachter behaelt den ciphertext, pro epoche wechselt nur die schluessel-freigabe; neu verschluesselt wird erst bei neuer `keyVersion`
  - [x] TTL für Verschlüsselungs-Parameter (stündlicher Wechsel, vom Client pünktlich getauscht)
    - done P5: client fragt bei ablauf sofort neu an, wenn das album offen ist
  - [x] Verlässliche Server-Zeit für Rotation (Geräte-Zeit ignorieren wg. Manipulationssicherheit)
    - done P5: `GET /api/time` (now, epoch, epochMs, epochEndsAt)
  - limit: wer ein bild einmal entschluesselt sieht, kann es mit manipuliertem client behalten; rotation schuetzt ehrliche clients + erzwingt "besitzer muss zustimmen"

# Privacy & Location (Anti-Triangulation)
- [x] Grid-Snapping (Fuzzy Location): Koordinaten mathematisch auf den Mittelpunkt der Geohash-Zelle runden, um Trilateration zu verhindern
  - done P2: siehe GEO, alle peers einer zelle haben denselben mittelpunkt
- [x] Safe Zones (Privacy Bubbles): Eigene Geofences (z. B. Zuhause, Arbeit) definieren, in denen der Client automatisch aus dem Grid verschwindet
  - done P2: safe zones = geohash-6-zellen nur lokal (`grid-settings.safeZones`); eigene zelle in zone -> register als silent

# E2E View-Once & Watermarking
- [x] Secure Snaps als opt-in toggle in den einstellungen (sender entscheidet), der empfaenger akzeptiert immer beide arten
  - done P5: `client/app/secure-snaps.js`; entschieden: beides = erst live-stream, fallback schluessel pro ansicht (sender zaehlt immer)
  - done P5: setting `snap-settings.secureSnaps` (default aus); aus = snap wie bisher (`snapData` in der nachricht)
  - done P5: an + beide online -> live-snap: sender behaelt das bild, empfaenger tippt "ansehen", sender streamt es als video track (`canvas.captureStream()`) ueber die bestehende RTCPeerConnection (renegotiation), anzeigedauer z.b. 10 s, sender kann abbrechen, danach "gesehen"
  - done P5: empfaenger offline -> snap kommt verschluesselt an (auch Path C), ansehen braucht den sender online; fallback = schluessel pro ansicht, nach der letzten ansicht wird der ciphertext geloescht
  - done P5: empfaenger-client versteht immer: normalen snap, live-snap (`SNAP_STREAM_START`/`SNAP_STREAM_END`), schluessel-freigabe (`SNAP_VIEW_GRANT`)
  - limit: screenshots/bildschirmaufnahme lassen sich im browser nicht verhindern -> wasserzeichen (unten) als abschreckung
  - done P5: pro snap im vorschau-screen waehlbar, defaults in den einstellungen: ansichten 1x/2x/3x (default 1x), dauer pro ansicht 5 s/10 s/30 s/unendlich bis schliessen (default 10 s)
  - done P5: empfaenger sieht "noch 2x ansehen" + countdown-ring, danach "abgelaufen"; sender sieht "gesehen" (mit anzahl)
  - done P5: der sender zaehlt jede ansicht (live und fallback); nach der letzten loeschen beide seiten schluessel/ciphertext
- [x] Kryptografisches Zeroing: Symmetrische Schlüssel für ephemere Medien (Snaps) nach X Sekunden im RAM mit Nullen überschreiben
  - done P5: gilt fuer secure snaps; schluessel/puffer nach der anzeige ueberschrieben, blob-URL widerrufen (best effort, JS garantiert kein RAM-zeroing)
- [x] Personalisierte Steganografie-Wasserzeichen: Empfänger-ID als Rauschen ins Bild rechnen (Leaker-Identifikation bei Screenshots)
  - done P5: unsichtbar, QIM auf 16x16-block-helligkeit (`client/app/watermark.js`), uebersteht JPEG bis q40 + 1:1-screenshots, nicht skalieren/zuschneiden; pruefen im debug-modus

# Matching & Chat-Modi
- [x] 3-stufige Chat-Berechtigungen (jederzeit wechselbar):
  - done P6: `myProfile.chatPolicy`, durchsetzung beim empfaenger (`held`), freigabe beim match; `client/app/matching.js`
  - [x] A (Alles): Jeder Peer kann uneingeschränkt schreiben
  - [x] B (Eingeschränkt): Max. 5 Nachrichten (optional ohne Bilder) bis zum gegenseitigen "Match"
    - entschieden: anzahl waehlbar (1/3/5/10), schalter fuer bilder
  - [x] C (Nur Matches): Chat ist blockiert, bis auf "Match" geklickt wurde
  - note: chat gilt auch als angenommen, wenn man selbst schon geschrieben hat; SW bekommt `chat-gate` und zeigt bei nicht angenommenen nur die kompakte meldung
- [x] Flame / Match Ping Logik: Leichtgewichtiger Interaktions-Ping (ähnlich Grindr Taps) zum Signalisieren von Interesse und Triggern von Matches
  - done P6: `MATCH_PING`/`MATCH_RESET` als chat-operationen, match = gegenseitige flamme (entschieden), 1 flamme pro peer/24 h, "match loesen" im profil
- [x] 3-stufige Profil-Sichtbarkeit:
  - done P6: profil pro betrachter gebaut (`audience`), match-profile nie per swarm, galerie-bilder nur mit match (ab stufe 2)
  - [x] Stufe 1: Alles sofort für jeden im Grid sichtbar
  - [x] Stufe 2: Teilsichtbar (Eine Hälfte oder die Bilder-Galerie erst nach "Match" sichtbar; erzeugt optionalen Ping)
    - entschieden: felder einzeln "nur fuer matches" markierbar + galerie
  - [x] Stufe 3: Unsichtbar (Profil-Details und Bilder erst nach "Match" sichtbar; erzeugt zwingend Ping)
    - entschieden: im grid silhouette ohne namen, router bekommt weder namen noch bild
  - im chat modus sollte das grid und ein paar profildetails gar nicht an sein. wenn man einen chatpartner hinzufügt sollte ein profilhandshake passieren

# Hyperlocal Mesh (Festival/Club Mode)
- [ ] WebRTC over LAN: mDNS und lokale Host-Kandidaten aggressiv priorisieren
  - plan: naechste iteration: host candidates bevorzugen (mDNS nicht strippen), STUN-loser club-modus
- [ ] Offline-Mesh: Direkter Traffic im selben WLAN (z. B. auf Prides/in Clubs) ohne Cloud-Routing
  - plan: naechste iteration: PWA hat keine lokale discovery API -> signaling server muss im LAN laufen (limitation)
