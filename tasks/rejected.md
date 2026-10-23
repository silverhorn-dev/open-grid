# Rejected / Obsolete

Aufgaben, die nicht (mehr) umgesetzt werden, mit Grund.

- the status is from time to time very fuzzy
  - abgelehnt 2026-10-23: laut Nutzer durch die Routing-Aenderungen bereits behoben
- bug: "chat loeschen und blockieren sind kaputt" (2026-10-23)
  - nicht reproduzierbar: Playwright-E2E mit zwei Nutzern (Desktop, iPhone-Emulation mit Tap, Partner offline, Neuladen) auf HEAD `675c9f5` und dem H1-Stand ok; keine Konsolenfehler
  - vermutlich alte Daten auf der produktiven Instanz; falls es wieder auftritt: Debug-Modus an, Log kopieren (Einstellungen -> Debug)
