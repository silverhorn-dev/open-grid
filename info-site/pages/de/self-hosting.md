# Selbst betreiben

${term.app} ist ${term.openSource}. Jede Gruppe, jeder Verein und jedes Event kann einen eigenen Server betreiben. Dieser Server speichert keine Chats – er vermittelt nur.

## Was du brauchst

- Einen kleinen Server oder ein Heimgerät mit **Docker**.
- Eine **Domain** mit HTTPS (z. B. über einen Reverse Proxy oder einen Cloudflare-Tunnel).
- Optional einen ${term.turn}, damit Verbindungen auch in schwierigen Netzen klappen. Er ist bereits dabei.

## In drei Schritten

1. Das Projekt herunterladen und die Vorlage `.env.example` als `.env` kopieren.
2. In der `.env` Domain, TURN-Geheimnis und Push-Kontakt eintragen.
3. `docker compose up -d --build` starten.

Danach läuft die App unter deiner Domain. Diese Info-Seite erscheint unter `/info` – oder auf einer eigenen Subdomain, wenn du `INFO_HOST` setzt.

## Was du einstellen kannst

- Welche **Modi** es gibt (z. B. nur Chat für einen privaten Kreis).
- **Standardwerte** für die Einstellungen deiner Nutzer, etwa die Sprache.
- Einen **Club-Modus** für Events ohne Internet: Verbindungen nur im lokalen WLAN.

## Was der Betreiber sieht – und was nicht

Auch als Betreiber siehst du keine Nachrichten, Fotos oder vollständigen Profile. Gespeichert werden nur kurzlebige Grid-Einträge (Name, Vorschaubild, ${term.aCell}) und verschlüsselte Nachrichten für Leute, die gerade offline sind.

Technische Details stehen in der README des Projekts.
