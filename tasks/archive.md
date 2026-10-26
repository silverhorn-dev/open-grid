# Functional Grid
- grid refresh works
- no profile shattering by not deleting the old registration
- use kv instead of local hashmap lol

# Routing
- [x] in the kv database just should be the name and the thumbnail
- [x] Keine Single-Root mehr: Echte Pages/Routes für State-Erhalt bei Refresh und native Smartphone-Zurück-Navigation
  - done P3: `client/app/router.js`, routen `/grid` `/chat` `/chat/:peerId` `/profile` `/settings` `/cloud`, server liefert app-shell fuer alle, push oeffnet `/chat/<id>`
  - done P3: menue/profil/snap-modal = eigener history entry, zurueck schliesst modal

# general
- [x] coloring (P10)
  - done P10: `client/app/theme.js` (im head), farbrad + vorgaben, system/hell/dunkel; `slate`/`brand` als CSS-variablen
  - plan: P10: akzentfarbe per rundem farbrad wie im zen-browser (konischer verlauf + ziehbarer punkt + presets), pro geraet gespeichert
  - plan: P10: `brand`-farben als CSS-variablen in `tailwind.config.cjs`, picker schreibt 50-900 nach `:root`
  - plan: P10: hell/dunkel/system fuer die ganze app: `slate`-palette als CSS-variablen, `.theme-light` tauscht sie; keine klassen im markup aendern
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
- [x] grid: "mehr laden" erst nach einer weile sichtbar; bei wenig/keinen leuten automatisch weitere ringe laden, max 3, keine dauerschleife
  - done P9
  - plan: P9: knopf direkt nach der ersten antwort; < 6 peers und `hasMore` -> naechster ring automatisch, hoechstens bis ring 3, einmal pro refresh-zyklus; `hasMore=false` stoppt sofort
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
- [x] bug: the icon bar after clicking the arrow icon menu have no background, therefore the are not well lookable
  - done P9
  - plan: P9: ursache: geschlossene regel mit `:hover` ist spezifischer als die offene, `:hover` bleibt auf touch nach dem tippen haengen -> `:hover`-selektor raus
- [x] bug: im chat modus sieht man das grid noch
  - done P9
  - plan: P9: `.nav-top-btn`/`.nav-bottom-btn` setzen `display:flex` in `styles.css` (laedt nach tailwind) und ueberschreiben `.hidden` -> gezielte `.hidden`-regeln, uebrige `display`-regeln pruefen
- [x] kontaktleiste ueberarbeiten: online-badge sitzt ganz rechts hinter blockieren/chat loeschen/suchen
  - done P9
  - plan: P9: links zurueck + avatar mit online-punkt + name + untertitel (online/offline/hat den chat offen); rechts nur suche + `...`-menue (medien, chat loeschen, blockieren, profil)
- [x] chat-uebersicht: vorschau der letzten nachricht
  - done P9
  - plan: P9: letzte sichtbare nachricht pro chat (text/Snap/Album/Secure Snap, eigene mit "Du:") + uhrzeit, neuester chat oben; `state.chatPreviews`
- [x] reaktionen auf nachrichten sind zu klein und unter der nachricht
  - done P9
  - plan: P9: chips ~1.5x groesser, ueberlappen die untere kante der bubble (eigene unten links, fremde unten rechts)
- [x] sender soll den eigenen snap speichern koennen; hat der empfaenger seine views verbraucht, wird der snap auch beim sender geloescht
  - done P9
  - plan: P9: speichern-knopf auch fuer eigene snaps; empfaenger sendet nach der letzten ansicht chat-operation `SNAP_CONSUMED` (P2P/Path C, kein push), sender loescht `snapData` + aus dem operations-log, ausser er hat gespeichert
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
- [x] Alben v2: verschluesselung aus eigenem key, key des source und einem rollenden source key, der vom source-client gestellt und per P2P oder cache-forwarding geliefert wird (P12)
  - entschieden 2026-10-23: besitzer pusht den rollenden key fuer aktuelle + naechste epoche
  - plan: P12: pro bild zufaelliger inhaltsschluessel `CK`; pro album und epoche zufaelliger rollender key `R_e`
  - plan: P12: `KEK_e = HKDF(ECDH(eigener key, source key), salt = R_e, info = albumId:epoch)`; besitzer schickt `R_e` + mit `KEK_e` verpackte `CK`s an alle in der ACL: P2P, sonst als Path-C-chat-operation `ALBUM_KEYS` (kein push)
  - plan: P12: gepusht beim start des besitzers, beim epochenwechsel (timer ueber `/api/time`) und wenn ein betrachter sich verbindet; betrachter entpackt `CK` nicht exportierbar nur im RAM
  - plan: P12: entziehen = kein push mehr + neue `keyVersion` -> nach spaetestens einer epoche kein zugriff; v1-alben werden beim naechsten start des besitzers neu verteilt
  - done P12: `ALBUM_KEYS`-buendel (P2P, sonst Path C), betrachter speichert nur buendel; inhaltsschluessel bleiben deterministisch -> v1-ciphertext bleibt gueltig, kein neuer download noetig
- [x] Zugriffssteuerung pro Album: teilen / nicht mehr teilen (Revoke-Management)
  - done P4: teilen = peer in `acl` + chat-nachricht; entziehen = aus `acl` + `ALBUM_REVOKED`, `IMAGE_REQUEST` prueft `acl`
  - done P5: entziehen erhoeht `keyVersion` (rolling keys)
- [x] der renderer sollte screenshots und aufnahmen blockieren (P13: nur recherche, entschieden 2026-10-23)
  - done P13: recherche unten dokumentiert, bewusst nicht gebaut
  - bringt hier eine frequenz was?
  - am schönsten wäre es die wasserzeichen nachträglich beim rendern noch durch ein negativzeichen auszublenden
  - plan: P13: notiz: browser koennen screenshots nicht blockieren (nur DRM-video per EME). frequenz-idee: zwei frames im wechsel (bild + verstaerktes wasserzeichen, bild - wasserzeichen), das auge mittelt, ein screenshot faengt einen frame mit starkem wasserzeichen. nachteile: flackern auf 60-Hz-displays, akku, fotosensible nutzer, bildschirmaufnahmen mitteln es wieder raus
  - plan: P13: wasserzeichen beim rendern abziehen wuerde es auch aus screenshots entfernen -> nur in kombination mit der frequenz-idee sinnvoll; nicht gebaut

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
  - [x] im chat modus sollte das grid und ein paar profildetails gar nicht an sein. wenn man einen chatpartner hinzufügt sollte ein profilhandshake passieren (P11)
    - done P11: `PROFILE_SCHEMAS` pro modus (chat: name + status), nur felder des aktiven schemas gehen raus, automatischer `PROFILE_REQUEST` nach dem ersten `KEY_HELLO`
    - da wäre es sogar besser pro modus verschiedene default profil schemas als router anzubieten
    - plan: P11: router bietet pro modus ein profil-schema (`PROFILE_SCHEMAS` JSON, fallback `PROFILE_SCHEMA`), chat-modus: name + status; ueber `/api/config` + index-template
    - plan: P11: nach dem ersten `KEY_HELLO` ohne gecachtes profil schicken beide automatisch `PROFILE_REQUEST`

# Hardening (H1-H4, geplant 2026-10-23)

## H1 Sicherheit Server (kritisch zuerst)
- [x] Push-Subscriptions: SSRF verhindern
  - done H1 (`server/security.js`)
  - befund: `isPushSubscription` (`server/app.js`) akzeptiert jede https-URL, der server POSTet dorthin (auch interne hosts)
  - plan: nur bekannte push-dienste erlauben (fcm.googleapis.com, *.push.services.mozilla.com, web.push.apple.com, *.notify.windows.com), konfigurierbar per `PUSH_HOST_ALLOWLIST`; zusaetzlich private/loopback-IPs ablehnen
- [x] Rate-Limits und Quoten
  - done H1 (`server/security.js`)
  - befund: keine limits auf register, grid, cache, signaling; queue pro empfaenger unbegrenzt (100 KB x beliebig viele, 72 h)
  - plan: einfacher token-bucket im speicher pro IP + peer (register, grid, cache, chat-controls, WS-nachrichten); queue-quote pro empfaenger (z. B. 500 nachrichten / 20 MB) und pro sender->empfaenger; 429 mit `Retry-After`
- [x] Logs ohne personenbezogene Daten
  - done H1 (`server/security.js`)
  - befund: fastify-logger schreibt komplette URLs inkl. `geohash`, `peerId`, `eventHash` ins log
  - plan: request-serializer ohne query-string und ohne IP (oder gekuerzt), tests dafuer
- [x] Sicherheits-Header
  - done H1 (`server/security.js`)
  - plan: `Content-Security-Policy` (default-src 'self'; img-src 'self' data: blob:; connect-src 'self' wss: + nominatim; frame-ancestors 'none'), `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, `Permissions-Policy` (camera/geolocation self); schritt 1 mit 'unsafe-inline' wegen `onclick`-attributen, schritt 2 (H4) inline-handler entfernen
- [x] Token-Vergleich konstant-zeitig
  - done H1 (`server/security.js`)
  - befund: `authenticatePeer` vergleicht hashes mit `===`
  - plan: `crypto.timingSafeEqual`
- [x] `trustProxy` nicht blind auf true
  - done H1 (`server/security.js`)
  - plan: `TRUST_PROXY` env (standard: nur private netze / loopback), README

## H2 Eingaben und Daten im Client
- [x] P2P-Payloads validieren
  - done H2
  - plan: zentrale pruefung in `handleSecurePayload` (typ, max. groessen: profilfelder, avatar, bildantworten, snap-anfragen, listen-laengen); unbekannte typen verwerfen; tests
- [x] Geheimnisse im IndexedDB verschluesseln
  - done H2
  - befund: album-`secret`, rollende keys und chat-gate liegen im klartext in IndexedDB (medien sind schon mit `storageKey` verschluesselt)
  - plan: album-datensaetze mit `storageKey` verschluesseln (wie profile), migration beim laden
- [x] Speicherplatz
  - done H2
  - plan: `navigator.storage.persist()` anfragen, `estimate()` in den einstellungen anzeigen, warnung ab 80 %; alte medien/snaps aufraeumen
- [x] Server-Aufraeumen
  - done H2
  - plan: verwaiste `peer_credentials`/push-subscriptions nach X tagen ohne login loeschen (retention in README)

## H3 Robustheit
- [x] Fehler nicht stumm schlucken
  - done H3
  - befund: viele `.catch(() => {})`
  - plan: einheitlich `logDebug` + optionaler debug-toast; kritische pfade (senden, sync, schluessel) mit sichtbarem hinweis
- [x] SW und Seite gleich halten
  - done H3
  - plan: test, der `storeMessagePut` (SW) und `applyChatOperation` (seite) mit denselben faellen prueft (held/gated, geloescht, duplikat)
- [x] Startup-Pfad absichern
  - done H3
  - plan: jeder `load*`-schritt in `main.js` einzeln mit fallback, damit ein fehler nicht die ganze app stoppt (wie beim matchState-crash)

## H4 Wartbarkeit und Tests
- [x] Grosse Dateien teilen: `chat.js` (1200 zeilen: snaps, nachrichten-aktionen, kontaktleiste), `p2p.client.js` (1000 zeilen: signaling, sync, path C)
  - done H4: `chat-tools.js`, `snaps.js`, `delivery.client.js`
- [x] Inline-`onclick` durch event-listener ersetzen (fuer strikte CSP ohne 'unsafe-inline')
  - done H4: `actions.js` (`data-click`), CSP `script-src 'self'`
- [x] Playwright-E2E vom nutzer ins repo + `npm run test:e2e`
  - done H4: `e2e/chat-controls.e2e.cjs`, `scripts/e2e.sh`
- [x] `npm audit` / dependency-check im docker-build oder CI
  - done H4: `npm run audit:prod` = 0 findings; dev: 3 moderate in tailwind 3 (postcss-selector-parser, nur build-zeit, eigenes CSS) -> fix erst mit tailwind-4-migration

# Runde R (FRQs vom 2026-10-24, geplant)

## R0 Aufraeumen
- [x] FRQ-dateien nach UTF-8, LAN-mesh nach `tasks/backlog.md`
- [x] gesten: unit-test fuer den gesten-helper (richtungssperre, schwellen, long-press-abbruch)
  - done R0: `test/gestures.test.js`

## R1 UI-Bugs
- [x] offline-banner -> dezentes status-icon (FBR 1)
  - done R1
  - plan: `#offline-banner` raus, wolke-durchgestrichen-icon in top-bar + chat-kopf mit `title`/`aria-label`; gleiche logik (`navigator.onLine` + WS)
- [x] nachrichtenfeld mehrzeilig, max 5 zeilen, dann scrollen, umbruch (FBR 3)
  - done R1
  - plan: `<textarea rows=1>` waechst mit, enter sendet, shift+enter = neue zeile; bubbles behalten zeilenumbrueche
  - entschieden: auf touch-tastaturen ist enter eine neue zeile, gesendet wird per knopf
- [x] desktop-chat begrenzen, nur nachrichten scrollen, kontaktleiste sticky (FBR 5)
  - done R1
  - plan: chat als begrenzte box (hoehe = viewport - nav), `#chat-messages` `overflow-y:auto`, kopf `position: sticky`

## R2 Album-Schluessel-TTL (FBR 2)
- [x] besitzer stellt pro album epochenlaenge (15 min/1 h/3 h/24 h) + vorab-epochen (1-3) ein; default in den einstellungen
  - done R2: aenderung schickt sofort neue buendel, inhaltsschluessel bleiben (keine neue `keyVersion`, kein neuer download); betrachter waehlt das buendel nach zeitfenster
  - plan: album-felder `keyEpochMinutes`, `keyEpochsAhead`; epoche pro album aus `/api/time` (`now`); push-timer = fruehestes epochenende
  - plan: einstellungen "Alben": default fuer neue alben (`keys`/`album-defaults`, fallback server-wert)

## R3 Schwarm-Abruf fuer Galerie + Alben (FBR 4)
- [x] profilbilder und alben auch von anderen grid-teilnehmern holen, nicht nur vom besitzer
  - done R3: `client/app/swarm.js`; inhaltsschluessel pro bild fuer alle betrachter gleich (schema 2), weitergebender betrachter setzt das wasserzeichen des empfaengers (entschieden 2026-10-24); e2e `e2e/album-relay.e2e.cjs`
  - plan: signiertes profil bekommt `sha256` pro galeriebild; `SWARM_IMAGE_REQUEST`, empfaenger prueft hash
  - plan: besitzer signiert album-manifest (items mit ciphertext-hash); `SWARM_ALBUM_REQUEST` an betrachter, die es schon haben; keys weiter nur ueber `ALBUM_KEYS` -> ACL bleibt ueber die schluessel-verteilung
  - entschieden: kein zusaetzliches speichern, nur wer das album schon geoeffnet hat, kann es weitergeben

## R4 Secure Image Rendering (canvas)
- [x] alben, secure snaps und chat-bilder per canvas statt `<img>`, keine data-URL im DOM
  - done R4: `client/app/secure-canvas.js`, bildbetrachter + snap-viewer als canvas, speichern-knopf nur im chat-/freunde-modus
  - entschieden 2026-10-24: nur canvas, kein pixel-verwuerfeln
  - plan: `createImageBitmap` aus den entschluesselten bytes, kontextmenue aus, bitmap beim schliessen freigeben
  - plan: chat-bilder speichern nur im sozialen bereich (chat/freunde), in grid/event nicht
- [x] einstellung "Spur-Wasserzeichen" an/aus (standard an)
  - done R4: `keys`/`privacy-settings`, manifest traegt `watermark` fuer schwarm-weitergabe
- [x] schwarm-weitergabe absichern (aus der diskussion 2026-10-24)
  - done R4: zugangstickets pro betrachter in `ALBUM_KEYS` (gegen zweitaccounts), empfaenger prueft eigenes wasserzeichen in weitergegebenen kopien
  - grenze dokumentiert: kollusion zweier freigegebener accounts, manipulierte clients

## R5 Snap-Kamera (feature-req-snap)
- [x] front/back-wechsel, timer + views im E2EE-payload, komprimierung (gab es schon)
- [x] vollbild-kamera, blitz/torch wenn verfuegbar
  - done R5: bedienung liegt ueber dem bild, licht-knopf nur bei `capabilities.torch`
- [x] kamera-gesten: nach unten = schliessen, hochwischen am ausloeser = galerie (G10), doppeltippen = kamera wechseln (G11), pinch = zoom
  - done R5: `client/app/snap-camera.js`, e2e `e2e/snap-camera.e2e.cjs`
- [x] editor: zeichnen, text, emoji; alles in ein JPEG flatten (`encodeSnap`)
  - done R5: `client/app/snap-editor.js`; wasserzeichen erst nach dem flatten

## R6 Adden (Chat- und Freunde-Modus)
- [x] folgen/adden im chat-/freunde-modus statt flammen (FBR 6, feature-req-chats-and-friends)
  - entschieden 2026-10-24: flamme = anfrage, match = freund (eigene beziehung `FRIEND_PING`/`FRIEND_RESET`, unabhaengig vom grid-match); ablehnen moeglich
  - entschieden: getrennte chatlisten "Grid & Event" und "Chat & Freunde", zuordnung nach startmodus, freunde -> "Chat & Freunde"
  - done R6: `client/app/friends.js`, freunde-grid nur freunde, e2e `e2e/friends.e2e.cjs`
  - entschieden 2026-10-24: in grid/event erst nach match adden; abschaltbar per profil-flag `allowMatchFriends` (unsichtbar, versteckt den knopf beim match)
  - fix nebenbei: `chatPolicy` war nicht im signierten profil und kam nie beim anderen an

## R7 Status-Feed (geplant)
- [x] status: foto/snap (24 h), text (24 h), rich presence (kurzer dauer-text neben dem online-punkt), nur fuer freunde
  - done R7: `client/app/status.js`, store `statusUpdates` (IndexedDB v9), e2e `e2e/status.e2e.cjs`
  - entschieden 2026-10-24: weg = P2P, sonst einzeln ueber den router-cache; einstellung "status nur direkt" (dann nur P2P)
  - plan: neuer store `statusUpdates` (`id, peerId, kind, payload, expiresAt`), GC alle 15 min + beim start (record + media)
  - plan: `STATUS_POST`/`STATUS_DELETE` als chat-operation an alle freunde (P2P, sonst Path C ohne push); foto max 70 KB wie snaps, mit wasserzeichen pro empfaenger
  - plan: status-leiste ueber der chatliste nur im chat-/freunde-modus; vollbild-viewer mit fortschrittsbalken; eigener status loeschbar
  - plan: rich presence als feld im freundes-profil (`presenceText`), neben dem online-punkt in chatliste und kopfzeile
  - option spaeter: schwarm-weitergabe unter freunden (status-key + ticket wie bei alben); nachteil: weitergebender sieht, dass der anfragende auch freund ist

# Runde S (2026-10-24)

## S1 Bugs
- [x] chatliste geht auf dem smartphone ueber den bildschirmrand, max hoehe + scrollen
  - done S1: `fitChatListPanel` (settings.js) begrenzt die liste bis ueber die untere navigation
- [x] kurzstatus auf dem smartphone nicht sichtbar
  - done S1: eigene zeile unter dem namen (wurde bei langen namen abgeschnitten)
- [x] im sozialen modus keine alben-karte im profil, wenn man keine eigenen alben hat
  - done S1: `syncAlbumCardVisibility`; mit eigenem album sichtbar (damit geteilte nicht vergessen werden)
- [x] offline-symbol: netzwerk- statt stecker-icon
  - done S1: `fa-wifi` mit schraegstrich (`.wifi-off`)
- [x] e2e-tests wackelig: viele browser hinter einer IP liefen ins rate-limit
  - done S1: `RATE_LIMIT_SCALE` (nur tests, `scripts/e2e.sh` nutzt 20)

## S2 Schnell zwischen Chats wechseln (feature request 2026-10-24)
- [x] im offenen chat schnell zum naechsten chat derselben liste (Grid & Event bzw. Chat & Freunde)
  - done S2: `client/app/chat-switch.js`, einstellung unter "Darstellung", e2e `e2e/chat-switch.e2e.cjs`
  - entschieden: wischen nur auf der kontaktleiste (nachrichten = antworten, tab-wischen ist im offenen chat aus)
  - plan: einstellung an/aus + stil: "Leiste" (avatar-reihe unter der kontaktleiste, antippen), "Wischen" (im chat seitlich wischen), "Pfeile" (vor/zurueck in der kontaktleiste); standard: an, Leiste (kein versehentliches wechseln)
  - plan: reihenfolge wie die chatliste (neueste oben), nur chats des aktuellen bereichs

## S2c Bug: Chatliste auf dem Smartphone in einer Box
- [x] auf dem smartphone die chats ohne umgebende box anzeigen (am desktop bleibt sie)
  - done: `#chat-list-panel` ohne rahmen/hintergrund/innenabstand unter 768 px (`client/styles.css`)

## S2b Bug: P2P geht verloren, beide nutzen Path C bis zum Neuladen (handy + pc, gleiches WLAN)
- [x] ursache: kein heartbeat; der websocket des handys wird im hintergrund "halb offen" (readyState OPEN, nichts kommt an), angebote laufen ins leere, jede nachricht faellt nach 10 s auf Path C
  - done: server-ping alle 30 s (trennt halb offene sockets), client-PING/PONG alle 25 s + beim zurueckkehren in die app + bei `online`, ohne antwort neu verbinden
  - done: nach `SOCKET_REGISTERED` haengende P2P-verbindungen neu aufbauen, auch fuer chat-partner ausserhalb des grids (chat-/freunde-modus hat kein grid)
  - nachgestellt im browser (halb offener socket + abgebrochene verbindung): vorher nur Path C, jetzt nach dem zurueckkehren sofort wieder P2P

## S2d Neue Wuensche (2026-10-24, je feature ein changy)
- [x] wifi-symbol aus der obersten leiste entfernen (steht fuer "keine verbindung", dort reicht der punkt)
- [x] hochziehen im chat konfigurierbar: a seite neu laden (statt nur abgleichen), b schnell zum naechsten chat, c snap, d album
  - done: `runPullUpAction` (gestures.js), einstellung unter "Darstellung", "naechster chat" beginnt am listenende von vorn; e2e mit echten touch-events `e2e/pull-up.e2e.cjs`
  - entschieden: standard a = tab neu laden (location.reload), ohne toast/banner (die stapelten sich bei schnellem wiederholen)
- [x] changelog im menue (nur debug, zwischen einstellungen und cloud cache)
  - done: `CHANGELOG.md` im repo (deutsch, nutzersicht), route `/changelog.md`, darstellung ohne innerHTML; ab jetzt bei jedem changy pflegen
- [x] gui: kopf der chatliste (titel, status-leiste, einladen) als zweiter header auf dem smartphone (als naechstes)
  - bug 2026-10-25: kopf liess sich wegscrollen -> liste steht jetzt fest zwischen app-kopfzeile und unterer navigation (`position: fixed`, hoehen als CSS-variablen aus `fitChatListPanel`), e2e prueft es mit erzwungenem seiten-scroll
  - done: `#chat-list-head` (index.html), auf dem smartphone ohne aussenabstand direkt unter der app-kopfzeile, eigene flaeche, trennlinie volle breite
  - wunsch: trennlinie zur liste ueber die volle breite, eigene hintergrundfarbe, steht fest ueber den chats, die chats scrollen darunter
- [x] hochziehen: neue option "Quick-Switcher" = menue mit allen chats der liste zum auswaehlen (nicht nur der naechste)
  - done: `openChatSwitcherSheet` (chat-switch.js), option "Chat auswaehlen"
- [x] album-knopf in sozialen chats ausblenden (dort hat man normalerweise keine alben); lange auf snap druecken zeigt ihn (easteregg)
  - done: `updateChatAlbumButton`/`initSnapLongPress` (chat-tools.js), gilt pro chat, e2e `e2e/album-button.e2e.cjs`
- [x] bug: beim betreten oder senden springt der chat in die mitte; soll unten bleiben, ausser man hat weit nach oben gescrollt -> dann position halten + knopf "nach unten"
  - done: ursache = bilder (canvas) bekommen ihre hoehe erst nach dem zeichnen, der verlauf wurde vorher nach unten gescrollt; jetzt `state.chatPinned` + nachziehen per MutationObserver, knopf ab einer bildschirmhoehe, e2e `e2e/chat-scroll.e2e.cjs`
- [x] bilder nicht immer komprimieren: beim senden umschaltbar
  - frage nutzer: warum komprimiert? -> snaps muessen in den router-cache passen (Path C, max. 100 KB ciphertext pro nachricht, daher ~70 KB data-url); dazu speicher und datenvolumen
  - plan: in der snap-kamera seitlich wischen (plus label mit pfeil rechts neben der kamera) = "Als Bild senden": normales bild statt einmal-snap
  - done: "Als Bild senden" (`state.snapSendMode`, snap-camera.js), bild = `snapData` ohne `snapMode`; e2e in `e2e/snap-camera.e2e.cjs`; "Original" folgt als eigenes changy
  - plan: zusaetzlich toggle "Original": unkomprimiert, nur ueber P2P/TURN, nie ueber den cache (keine riesenmengen auf dem server); ohne direkte verbindung wartet es auf die naechste
  - done: `client/app/originals.js`; 7,7 MB in 119 stuecken im browser getestet
  - plan: grosse bilder in stuecken ueber den DataChannel (nachrichtengroesse je browser begrenzt, chrome ca. 256 KB), mit fortschritt
- [x] mehrere bilder/snaps auf einmal: in der galerie mehrfachauswahl, jedes wird ein eigener snap bzw. ein eigenes bild
  - done: `sendPickedImages` (snaps.js), max. 20
- [x] mehrere empfangene snaps hintereinander ansehen: zum naechsten per doppeltippen oder wischen; einstellbar: doppeltippen, nach rechts/links wischen oder nach oben wischen
  - done: `advanceReplaySnap`, einstellung bei Secure Snaps, hinweis "Noch n Snaps"
- [x] bug: nach dem senden verliert das nachrichtenfeld den fokus (tastatur geht zu)
  - done: `initChatInputFocus` (chat.js), e2e in `e2e/chat-scroll.e2e.cjs`
- [x] bug: bildbetrachter flackert/springt beim seitlich wischen
  - done: `rotateViewerSlides` (viewer.js), e2e `e2e/image-viewer.e2e.cjs` tastet die mitte pro frame ab (ohne fix: erst altes, dann neues bild)
  - plan: seit canvas werden nach dem wischen alle 3 slides neu gezeichnet (asynchron), die mitte zeigt kurz das alte bild; slides rotieren statt neu zeichnen
- [x] bug: neu laden im chat zeigt auf dem smartphone 3-5 s die chatliste
  - done: platzhalter sofort, chat direkt nach datenbank + chatliste statt am ende des starts; e2e `e2e/pull-up.e2e.cjs` prueft das chat-layout direkt nach dem laden
  - plan: chat-ansicht aus der adresse sofort oeffnen, inhalt nachladen, sobald datenbank/schluessel bereit sind
- [x] bug: im snap nach unten wischen laedt die seite neu (pull-to-refresh des browsers), der snap ist dann weg; soll den snap schliessen
  - done: viewer mit `touch-action: none`, wischen nach unten (> 110 px) schliesst (secure-snaps.js), e2e `e2e/snap-viewer.e2e.cjs`
- [x] bug: speichert der empfaenger einen snap, erfaehrt der absender (pc) nichts davon
  - done: chat-operation `SNAP_SAVED`, hinweis + "vom Empfaenger gespeichert"
  - plan: chat-operation `SNAP_SAVED` an den absender, der zeigt "gespeichert" an
- [x] bug: nach dem neuladen im chat verschwand auf dem smartphone die nachrichtenleiste ("chat wird geladen" blieb stehen)
  - im emulator nicht nachstellbar (auch mit bild, snap, reaktion, antwort, album, freundschaft); sicherheitsnetz: chat am ende des starts erneut oeffnen, platzhalter bleibt nie stehen; bei wiederauftreten debug-log/startfehler pruefen
- [x] einmal-snap: ansicht zaehlt schon beim oeffnen (wunsch 2026-10-25)
  - done: `snapViews` beim oeffnen, aufraeumen nach absturz/neu laden mit `expireUsedReplaySnaps`
- [x] bug: nachrichtenfeld verschwindet nach dem neuladen auf dem smartphone
  - vermutete ursache (hinweis nutzer): chrome "seite uebersetzen"-leiste unten (seite war `lang="en"`); jetzt `lang="de"`, `translate="no"`, `notranslate`
- [x] chat: bilder springen beim laden (canvas bekommt seine groesse erst nach dem zeichnen); platz vorher reservieren (idee nutzer)
  - done: `imageSize` in der nachricht, `createSecureImage(..., size)`, e2e misst die hoehe vor/nach dem zeichnen
- [x] listen-wechsel: in der chatliste zwischen "Grid & Event" und "Chat & Freunde" umschalten
  - done: `switchChatList` (chat-switch.js), e2e `e2e/list-switch.e2e.cjs`
  - wunsch: knopf neben dem titel; ein- und ausschaltbar, einstellbar wie gewechselt wird
  - vorschlag: standard = direkt den app-modus wechseln (discovery <-> chat, event <-> freunde; zuletzt genutzter modus der anderen seite); option "nur liste ansehen": dann steht neben dem titel "Modus wechseln", neu laden/tab-wechsel fuehrt zur liste des modus zurueck
- [x] standardwerte vom router: der betreiber legt in der app-config (`/api/config`) die standards fuer client-einstellungen fest (chat-wechsel, hochziehen, listen-wechsel, status nur direkt, spur-wasserzeichen, album-ttl ...); gespeicherte nutzerwerte gehen vor
  - done: `CLIENT_DEFAULTS` + `clientDefault()`, README-tabelle
  - plan: env `CLIENT_DEFAULTS` (JSON, geprueft gegen erlaubte werte), lieferung ueber `/api/config`; jeder `load*Settings` nimmt den router-standard, wenn kein eigener datensatz da ist; README-tabelle

# test
- [x] test
  - [x] test3
