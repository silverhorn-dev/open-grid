# Rejected / Obsolete

Aufgaben, die nicht (mehr) umgesetzt werden, mit Grund.

- the status is from time to time very fuzzy
  - abgelehnt 2026-10-23: laut Nutzer durch die Routing-Aenderungen bereits behoben
- bug: "chat loeschen und blockieren sind kaputt" (2026-10-23)
  - nicht reproduzierbar: Playwright-E2E mit zwei Nutzern (Desktop, iPhone-Emulation mit Tap, Partner offline, Neuladen) auf HEAD `675c9f5` und dem H1-Stand ok; keine Konsolenfehler
  - vermutlich alte Daten auf der produktiven Instanz; falls es wieder auftritt: Debug-Modus an, Log kopieren (Einstellungen -> Debug)

## Eigener, rotierender Verschluesselungsalgorithmus fuer Medien (verworfen 2026-10-29)
- idee: eigener "pattern-modularisierter" algorithmus, dessen muster der server regelmaessig wechselt, damit gestohlene schluessel wertlos werden (`tasks/feature-request-rotating-encryption.md`)
- grund: verstoesst gegen harte regel 3 (krypto nur ueber `crypto.subtle`); der code laeuft im browser und ist lesbar, sicherheit kann nur im schluessel liegen (Kerckhoffs); eigene chiffren sind schwaecher und langsamer als AES-GCM; wer waehrend einer gueltigen ansicht schluessel und bild hat, kann es ohnehin speichern
- alternativen (key-splitting, server-epochengeheimnis, stream) besprochen und geparkt, siehe board "Eigene rotierende Verschluesselung"

