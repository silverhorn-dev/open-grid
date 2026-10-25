# Changelog

Neueste Aenderungen oben. Im Debug-Modus im Menue unter "Changelog" sichtbar.

## 2026-10-25

### Behoben
- Smartphone: der Kopf der Chatliste bleibt oben stehen und laesst sich nicht mehr wegscrollen

## 2026-10-24

### Neu
- Snap-Kamera: "Als Bild senden" (seitlich wischen oder Knopf am rechten Rand) schickt ein normales, dauerhaftes Bild statt eines Einmal-Snaps
- In "Chat & Freunde"-Chats kein Album-Knopf mehr; lange auf "Snap" druecken laesst ihn erscheinen
- Hochziehen im Chat: neue Option "Chat auswaehlen" (Quick-Switcher mit allen Chats der Liste)
- Changelog im Menue (nur im Debug-Modus)
- Im Chat am Ende hochziehen: einstellbare Aktion (Seite neu laden, naechster Chat, Snap aufnehmen, Album teilen); Seite neu laden ohne Banner
- Chat bleibt beim Oeffnen und Senden unten; wer weit oben liest, behaelt die Position und bekommt "nach unten"
- Schnell zwischen Chats derselben Liste wechseln: Avatar-Leiste, Pfeile oder Wischen auf der Kontaktleiste, abschaltbar
- Status fuer Freunde: Text oder Foto fuer 24 Stunden, Kurzstatus neben dem Online-Punkt, "Status nur direkt"
- Freunde im Chat- und Freunde-Modus: Adden, Annehmen, Ablehnen; nach einem Grid-Match ebenfalls (per Profil abschaltbar); getrennte Chatlisten "Grid & Event" und "Chat & Freunde"
- Snap-Kamera im Vollbild mit Licht, Gesten (runter schliessen, hoch Galerie, doppelt tippen Kamera wechseln, zwei Finger Zoom) und Editor (zeichnen, Text, Emojis)
- Bilder werden per Canvas angezeigt; Chat-Bilder lassen sich nur im Chat- und Freunde-Modus speichern; Spur-Wasserzeichen abschaltbar
- Profilbilder und Alben auch von anderen Teilnehmern laden, wenn der Besitzer offline ist (geprueft per Signatur, Hash und Zugangsticket)
- Album-Schluessel: Gueltigkeit und vorab gelieferte Epochen pro Album einstellbar, Standard in den Einstellungen
- Nachrichtenfeld mehrzeilig (bis 5 Zeilen); Offline-Symbol statt Banner; Desktop-Chat als feste Box

### Behoben
- Smartphone: Kopf der Chatliste (Titel, Status, Einladen) ist ein eigener zweiter Header mit Trennlinie ueber die volle Breite; nur die Chats scrollen darunter
- P2P ging nach dem Hintergrund (Smartphone) verloren und beide Seiten nutzten den Router-Cache bis zum Neuladen: Heartbeat fuer die Signaling-Verbindung, haengende Verbindungen werden neu aufgebaut
- Chatliste auf dem Smartphone ging ueber den Bildschirmrand und stand in einer Box
- Kurzstatus auf dem Smartphone abgeschnitten
- Chat-Regeln (Nachrichtenlimit, Bilder) kamen beim anderen nie an
- Alben-Karte im Chat-Modus ohne eigene Alben ausgeblendet

## 2026-10-23

### Sicherheit
- Push nur an bekannte Push-Dienste, Rate-Limits, Queue-Quoten, Logs ohne Standort und IP, Sicherheits-Header
- Strikte Content-Security-Policy ohne Inline-Skripte
- P2P-Nachrichten werden vor der Verarbeitung geprueft; Alben verschluesselt gespeichert; verwaiste Zugangsdaten werden nach 180 Tagen geloescht
- App startet auch, wenn einzelne Teile nicht laden

### Neu
- Club-/LAN-Modus und eigener STUN-Server statt Google
- Alben v2 mit rollenden Schluesseln (auch ueber den Router-Cache)
- Profil-Schema pro App-Modus und automatischer Profil-Austausch
- Akzentfarbe per Farbrad, Hell/Dunkel
- Kontaktleiste mit Menue, Vorschau der letzten Nachricht, groessere Reaktionen
- App-Modi (Grid, Chat, Freunde, Event), Einladungslinks mit QR-Code
- Flammen, Matches, Chat-Berechtigungen und Profil-Sichtbarkeit
- Wischgesten (antworten, Aktionen, Herz, Tabs wechseln, Fenster schliessen)
- Online-Status fuer Chat-Partner unabhaengig vom Grid
- Bildbetrachter, Schriftgroesse, Einmal-Snaps mit Wiederholung
- Secure Snaps, Wasserzeichen, private Alben, Medienuebersicht
- Antworten, Reaktionen, Markieren und Suche im Chat
- Grid-Ringe mit Entfernungsgruppen, unsichtbarer Modus, Adresssuche

## 2026-10-22

- Mobile Oberflaeche mit Menue und Debug-Modus
- Web Push fuer Nachrichten ueber den Router-Cache
- Profil-Signaturen und Schwarm-Abruf von Profilen
- Peer-Authentifizierung, TURN-Unterstuetzung, Docker Compose

## 2026-10-21

- Erste Version: Grid nach Geohash, verschluesselter P2P-Chat, Bilder und Galerien, Blockieren und Chat loeschen
