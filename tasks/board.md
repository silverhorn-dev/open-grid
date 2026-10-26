# bugs

- [x] discovering of new social chats happens just on klick on profile?
  - ursache: profil kommt nur ueber eine P2P-sitzung; erste nachricht ueber router-cache/push baut keine auf, erst der klick (PROFILE_REQUEST) tat es
  - fix 2026-10-26: `requestMissingProfile` (storage.js) bei neuem chat und wenn der peer online kommt (direkt, startet P2P) + schwarm-abfrage; je weg max. 1x/min; e2e `new-chat-profile`



## Eigene rotierende Verschluesselung (geparkt, erst besprechen)
- [ ] gestohlene album-schluessel sollen nach der epoche wertlos sein; idee: eigener, vom server getakteter algorithmus -> `tasks/feature-request-rotating-encryption.md`
  - offen: konflikt mit regel "crypto nur ueber `crypto.subtle`"; alternative: server-epochen-geheimnis + `CK_e` per HKDF (AES-GCM bleibt)

## R6 Adden (Chat- und Freunde-Modus)

## R7 Status-Feed (geplant)

# Runde S (2026-10-24)
## S1 Bugs

## S2 Schnell zwischen Chats wechseln (feature request 2026-10-24)

## S2c Bug: Chatliste auf dem Smartphone in einer Box

## S2b Bug: P2P geht verloren, beide nutzen Path C bis zum Neuladen (handy + pc, gleiches WLAN)

## S2d Neue Wuensche (2026-10-24, je feature ein changy)
- [x] einmal-snaps laufen nach dem ersten ansehen nach einer bestimmten zeit ab (z. B. 15, 30 oder 60 min) (wunsch 2026-10-25)
  - entschieden 2026-10-26: einstellung des absenders, als enum (`15m`/`30m`/`60m`/`off`) im snap, standard 30 min vom router (`CLIENT_DEFAULTS.snapExpiry`), keine restzeit beim empfaenger
  - done: `isReplaySnapUsedUp`/`scheduleReplaySnapExpiry` (snaps.js), tests `test/snap-expiry.test.js`, e2e in `snap-camera`
- [x] e2e-stabilitaet: einzelne tests haengen gelegentlich beim P2P-aufbau unter last (auch vor dem heartbeat-commit, 1 von 3 laeufen); verbindungsaufbau im test robuster machen bzw. ursache finden
  - 2026-10-26: nutzer: nachrichtenfeld-bug auf dem smartphone seit dem uebersetzungs-fix nicht mehr aufgetreten
  - 2026-10-26: 3 volle laeufe (je 17 tests) mit protokolliertem schluesselaustausch: kein einziges erneutes KEY_HELLO noetig, kein ausfall; ursache des frueheren haengers nicht mehr nachstellbar (vermutlich zusammen mit `CACHE_WAITING`/wachhund behoben). retry bleibt als sicherheitsnetz, im debug-log sichtbar ("sende KEY_HELLO erneut"); `E2E_DEBUG=1 sh scripts/e2e.sh` zeigt es
  - gefunden: schluesselaustausch blieb gelegentlich haengen (kanal offen, kein sitzungsschluessel, laut log weder empfang noch fehler) -> KEY_HELLO wiederholen + logs; ursache noch offen, weiter beobachten
  - gefunden: echter bug, online empfaenger ohne push holte den router-cache erst beim naechsten verbinden ab -> `CACHE_WAITING` vom server (e2e `p2p-recovery`: ohne fix kam die nachricht nie an)
  - done teilweise: wachhund fuer haengende verbindungsversuche (verlorenes angebot -> nach 8 s neu, e2e `e2e/p2p-recovery.e2e.cjs`); danach 2 von 3 laeufen komplett gruen, ein lauf mit einem ausfall -> weiter beobachten


## S3 Aufraeumen
- [ ] tailwind 4 migration (behebt die 3 moderate `npm audit`-funde in dev-abhaengigkeiten)

# test
