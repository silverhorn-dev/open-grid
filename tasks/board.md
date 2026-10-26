# bugs

- [ ] discovering of new social chats happens just on klick on profile?



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
- [ ] einmal-snaps laufen nach dem ersten ansehen nach einer bestimmten zeit ab (z. B. 15, 30 oder 60 min) (wunsch 2026-10-25)
  - offen: wer stellt es ein (absender pro snap, oder empfaenger-einstellung), standard?
- [ ] e2e-stabilitaet: einzelne tests haengen gelegentlich beim P2P-aufbau unter last (auch vor dem heartbeat-commit, 1 von 3 laeufen); verbindungsaufbau im test robuster machen bzw. ursache finden
  - gefunden: schluesselaustausch blieb gelegentlich haengen (kanal offen, kein sitzungsschluessel, laut log weder empfang noch fehler) -> KEY_HELLO wiederholen + logs; ursache noch offen, weiter beobachten
  - gefunden: echter bug, online empfaenger ohne push holte den router-cache erst beim naechsten verbinden ab -> `CACHE_WAITING` vom server (e2e `p2p-recovery`: ohne fix kam die nachricht nie an)
  - done teilweise: wachhund fuer haengende verbindungsversuche (verlorenes angebot -> nach 8 s neu, e2e `e2e/p2p-recovery.e2e.cjs`); danach 2 von 3 laeufen komplett gruen, ein lauf mit einem ausfall -> weiter beobachten


## S3 Aufraeumen
- [ ] tailwind 4 migration (behebt die 3 moderate `npm audit`-funde in dev-abhaengigkeiten)

# test
