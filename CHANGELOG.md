# Changelog

Pro Build (= Commit) die Aenderungen, neueste oben. Im Debug-Modus im Menue unter "Changelog" sichtbar.

## Build 103 · 2026-10-25
- Behoben: gelegentlich blieb der Schluesselaustausch nach dem Verbindungsaufbau haengen (Kanal offen, aber nicht verschluesselt nutzbar); KEY_HELLO wird jetzt bis zu viermal wiederholt
- Behoben: Freundschaftsanfragen und Flammen kamen ohne direkte Verbindung erst beim naechsten Chat-Abgleich an; jetzt wie Nachrichten nach 10 Sekunden ueber den Router-Cache
- Behoben: Nachrichten ueber den Router-Cache kamen bei offener App ohne Push erst nach dem Neuladen an; der Server gibt einem online Empfaenger jetzt sofort Bescheid (`CACHE_WAITING`, ohne Inhalt), beim Zurueckkehren in die App wird ebenfalls abgeholt
- Behoben: Bilder im Chat liessen den Verlauf beim Laden springen; neue Bilder bringen ihre Groesse mit und der Platz ist vorher reserviert (aeltere bekommen einen Platzhalter)

## Build 102 · 2026-10-25 · `6729969`
- Knopf neben dem Titel der Chatliste wechselt zwischen "Grid & Event" und "Chat & Freunde" (wechselt den App-Modus oder zeigt nur die andere Liste; abschaltbar)
- Betreiber koennen Standardwerte fuer Einstellungen vorgeben (`CLIENT_DEFAULTS`)
- Behoben: geht ein Verbindungsangebot verloren, blieb P2P bis zum Neuladen weg; jetzt wird nach 8 bzw. 20 Sekunden neu angeboten
- Behoben: Chrome bot "Seite uebersetzen" an (die Leiste verdeckte auf Android das Nachrichtenfeld); die App ist jetzt als deutsch markiert und nicht uebersetzbar

## Build 101 · 2026-10-25 · `442486d`
- Mehrere Bilder aus der Galerie auf einmal auswaehlen: jedes wird ein eigener Snap, ein Bild oder ein Foto-Status
- Mehrere ungesehene Snaps hintereinander ansehen: weiter per Doppeltippen, seitlich wischen oder nach oben wischen (einstellbar); unten steht, wie viele noch kommen
- Behoben: Einmal-Snaps zaehlen die Ansicht jetzt schon beim Oeffnen; Neu laden oder Schliessen der App waehrend des Ansehens gibt keine zusaetzliche Ansicht

## Build 100 · 2026-10-25 · `3fc8877`
- "Original senden" beim Bild: volle Qualitaet (bis 4096 px, ohne Standort-Metadaten), nur direkt per P2P/TURN, nie ueber den Server; der Empfaenger sieht zuerst die Vorschau, dann das Original
- Speichert der Empfaenger einen Snap, sieht der Absender "vom Empfaenger gespeichert" und bekommt einen Hinweis
- Behoben: nach dem Neuladen in einem Chat konnte die Chat-Ansicht auf "Chat wird geladen" stehen bleiben; der Chat wird jetzt notfalls am Ende des Starts erneut geoeffnet

## Build 99 · 2026-10-25 · `42df43e`
- Behoben: im Snap nach unten wischen lud die Seite neu (Snap weg); jetzt schliesst es den Snap

## Build 98 · 2026-10-25 · `6f4f7fa`
- Behoben: Neu laden in einem Chat zeigte auf dem Smartphone erst einige Sekunden die Chatliste; jetzt sofort die Chat-Ansicht, der Chat oeffnet vor Service Worker und Verbindungsaufbau

## Build 97 · 2026-10-25 · `dd8c150`
- Behoben: Bildbetrachter flackerte beim seitlichen Wischen und zeigte kurz das vorige Bild

## Build 96 · 2026-10-25 · `dac6314`
- Behoben: nach dem Senden war das Nachrichtenfeld nicht mehr ausgewaehlt (auf dem Smartphone ging die Tastatur zu)

## Build 95 · 2026-10-25 · `50b826c`
- Changelog nach Builds (Commits) statt nach Tagen

## Build 94 · 2026-10-25 · `bd3daac`
- Smartphone: der Kopf der Chatliste bleibt oben stehen und laesst sich nicht mehr wegscrollen

## Build 93 · 2026-10-25 · `d3199c3`
- Snap-Kamera: "Als Bild senden" (seitlich wischen oder Knopf am rechten Rand) schickt ein normales, dauerhaftes Bild statt eines Einmal-Snaps

## Build 92 · 2026-10-24 · `f820bac`
- In "Chat & Freunde"-Chats kein Album-Knopf mehr; lange auf "Snap" druecken laesst ihn erscheinen

## Build 91 · 2026-10-24 · `1caafab`
- Hochziehen im Chat: neue Option "Chat auswaehlen" (Quick-Switcher mit allen Chats der Liste)

## Build 90 · 2026-10-24 · `9f81216`
- Smartphone: Kopf der Chatliste (Titel, Status, Einladen) als zweiter Header mit Trennlinie ueber die volle Breite

## Build 89 · 2026-10-24 · `28750ac`
- Changelog im Menue (nur im Debug-Modus)

## Build 88 · 2026-10-24 · `982fbd2`
- Im Chat am Ende hochziehen: einstellbare Aktion (Seite neu laden, naechster Chat, Snap, Album); Seite neu laden ohne Banner

## Build 87 · 2026-10-24 · `745017e`
- Chat bleibt beim Oeffnen und Senden unten; wer weit oben liest, behaelt die Position und bekommt "nach unten"

## Build 86 · 2026-10-24 · `55dcd9f`
- Smartphone: Chatliste ohne umgebende Box
- WLAN-Symbol aus der obersten Leiste entfernt
- Frisch aufgebaute P2P-Verbindungen werden beim Neuverbinden nicht mehr abgebrochen

## Build 85 · 2026-10-24 · `78ef103`
- Schnell zwischen Chats derselben Liste wechseln: Avatar-Leiste, Pfeile oder Wischen auf der Kontaktleiste, abschaltbar
- Behoben: P2P ging nach dem Hintergrund verloren, beide Seiten nutzten den Router-Cache bis zum Neuladen (Heartbeat fuer die Signaling-Verbindung)

## Build 84 · 2026-10-24 · `1a4f318`
- Behoben: Chatliste ging auf dem Smartphone ueber den Bildschirmrand
- Behoben: Kurzstatus auf dem Smartphone abgeschnitten
- Alben-Karte im Chat-Modus ohne eigene Alben ausgeblendet
- Offline-Symbol: WLAN statt Stecker

## Build 83 · 2026-10-24 · `780d34e`
- Status fuer Freunde: Text oder Foto fuer 24 Stunden, Kurzstatus neben dem Online-Punkt, "Status nur direkt"

## Build 82 · 2026-10-24 · `d17d683`
- Freunde im Chat- und Freunde-Modus: Adden, Annehmen, Ablehnen; nach einem Grid-Match ebenfalls (per Profil abschaltbar)
- Getrennte Chatlisten "Grid & Event" und "Chat & Freunde"
- Behoben: Chat-Regeln (Nachrichtenlimit, Bilder) kamen beim anderen nie an

## Build 81 · 2026-10-24 · `218cb7d`
- Snap-Kamera im Vollbild mit Licht, Gesten (runter schliessen, hoch Galerie, doppelt tippen Kamera wechseln, zwei Finger Zoom) und Editor (zeichnen, Text, Emojis)

## Build 80 · 2026-10-24 · `389f98b`
- Bilder werden per Canvas angezeigt; Chat-Bilder lassen sich nur im Chat- und Freunde-Modus speichern
- Spur-Wasserzeichen abschaltbar; Weitergabe von Alben nur mit Zugangsticket

## Build 79 · 2026-10-24 · `c906aaf`
- Profilbilder und Alben auch von anderen Teilnehmern laden, wenn der Besitzer offline ist

## Build 78 · 2026-10-24 · `d28de59`
- Album-Schluessel: Gueltigkeit und vorab gelieferte Epochen pro Album einstellbar, Standard in den Einstellungen

## Build 77 · 2026-10-24 · `829475e`
- Nachrichtenfeld mehrzeilig (bis 5 Zeilen); Offline-Symbol statt Banner; Desktop-Chat als feste Box

## Build 74 · 2026-10-23 · `22677ed`
- Strikte Content-Security-Policy ohne Inline-Skripte; End-to-End-Tests im Repo

## Build 73 · 2026-10-23 · `090fc02`
- App startet auch, wenn einzelne Teile nicht laden; Fehler im Hintergrund werden protokolliert

## Build 72 · 2026-10-23 · `a572262`
- P2P-Nachrichten werden vor der Verarbeitung geprueft; Alben verschluesselt gespeichert; Speicher aufraeumen; verwaiste Zugangsdaten werden nach 180 Tagen geloescht

## Build 71 · 2026-10-23 · `2f46a56`
- Push nur an bekannte Push-Dienste, Rate-Limits, Queue-Quoten, Logs ohne Standort und IP, Sicherheits-Header

## Build 70 · 2026-10-23 · `675c9f5`
- Club-/LAN-Modus und eigener STUN-Server statt Google

## Build 69 · 2026-10-23 · `10522da`
- Alben v2 mit rollenden Schluesseln (auch ueber den Router-Cache)

## Build 68 · 2026-10-23 · `b213ae8`
- Profil-Schema pro App-Modus und automatischer Profil-Austausch

## Build 67 · 2026-10-23 · `8543720`
- Akzentfarbe per Farbrad, Hell/Dunkel

## Build 66 · 2026-10-23 · `66697d3`
- Kontaktleiste mit Menue, Vorschau der letzten Nachricht, groessere Reaktionen, Snaps fuer Absender speicherbar, Grid laedt bei wenig Leuten automatisch weiter

## Build 65 · 2026-10-23 · `0b9bf86`
- Verbesserungen

## Build 64 · 2026-10-23 · `c770a0f`
- Verbesserungen

## Build 63 · 2026-10-23 · `0db6375`
- Verbesserungen

## Build 61 · 2026-10-23 · `0d27efc`
- App-Modi (Grid, Chat, Freunde, Event), Einladungslinks mit QR-Code

## Build 60 · 2026-10-23 · `6686413`
- Behoben: Absturz beim Start

## Build 59 · 2026-10-23 · `2e5da9c`
- App-Icons, Wischgesten (antworten, Aktionen, Herz, Tabs wechseln, Fenster schliessen), Kopieren

## Build 58 · 2026-10-23 · `840764d`
- Kleinerer Nachrichten-Pfeil, Filter in der Medienuebersicht, App funktioniert offline

## Build 57 · 2026-10-23 · `d810a32`
- Flammen, Matches, Chat-Berechtigungen und Profil-Sichtbarkeit

## Build 56 · 2026-10-23 · `17b2458`
- Nachrichten-Aktionen ueber den aeusseren Pfeil auf- und zuklappen

## Build 55 · 2026-10-23 · `ad7c9c9`
- Online-Status fuer Chat-Partner unabhaengig vom Grid

## Build 54 · 2026-10-23 · `2ed2df1`
- Fluessigerer Bildbetrachter, Schriftgroesse im Chat, Einmal-Snaps mit Wiederholung, Touch-Aktionen

## Build 53 · 2026-10-23 · `30fa09f`
- Rollende Album-Schluessel, Wasserzeichen und Secure Snaps

## Build 52 · 2026-10-23 · `83959d1`
- Untere Leiste repariert, groessere Nachrichten-Aktionen, Bildbetrachter

## Build 51 · 2026-10-23 · `8f1c4ab`
- Snap-Kamera, Medienuebersicht und private Alben

## Build 50 · 2026-10-23 · `f286fb8`
- Eigene Adressen pro Chat, Antworten, Reaktionen, Markieren und Suche im Chat

## Build 49 · 2026-10-23 · `3de5395`
- Grid-Ringe mit Entfernungsgruppen, unsichtbarer Modus, Adresssuche

## Build 48 · 2026-10-23 · `842c852`
- Online-Status, Zustellhinweise und Anzeige "hat den Chat offen"

## Build 45 · 2026-10-22 · `2e3ddec`
- Mobile Oberflaeche mit Menue und Debug-Modus

## Build 44 · 2026-10-22 · `3530481`
- Aufraeumen: App-Code in Module aufgeteilt

## Build 42 · 2026-10-22 · `f712467`
- Web Push fuer Nachrichten ueber den Router-Cache

## Build 41 · 2026-10-22 · `62d7c96`
- Profile ueber andere Teilnehmer abrufen (Schwarm)

## Build 40 · 2026-10-22 · `137f340`
- Behoben: Anmeldung im Grid und TURN

## Build 39 · 2026-10-22 · `a728bf8`
- Behoben: Anmeldung im Grid und TURN

## Build 38 · 2026-10-22 · `5169ed2`
- Konfiguration ueber Umgebungsvariablen

## Build 37 · 2026-10-22 · `7008c94`
- Behoben: Anmeldung im Grid

## Build 36 · 2026-10-22 · `a07b490`
- Behoben: Anmeldung im Grid

## Build 35 · 2026-10-22 · `70c0461`
- Behoben: Anmeldung im Grid

## Build 34 · 2026-10-22 · `21b5233`
- Behoben: Anmeldung im Grid

## Build 33 · 2026-10-22 · `46ec1a1`
- Anmeldung beim Server mit geschuetztem Token

## Build 32 · 2026-10-22 · `0bc2deb`
- Profile werden signiert und geprueft

## Build 31 · 2026-10-22 · `ffc5315`
- Profil-Korrekturen

## Build 30 · 2026-10-22 · `35bfdd7`
- Profil-Korrekturen

## Build 29 · 2026-10-22 · `f3fffa8`
- Profil-Cache beachtet Version und Zeitstempel

## Build 28 · 2026-10-22 · `bc0f5a0`
- Profile werden signiert und geprueft

## Build 27 · 2026-10-22 · `483bdee`
- Behoben: Galerie zeigte alte Bilder beim Profilwechsel

## Build 26 · 2026-10-22 · `d1a15b5`
- Docker Compose mit .env

## Build 25 · 2026-10-22 · `be1dcf3`
- TURN-Server nutzbar

## Build 24 · 2026-10-22 · `9e746f3`
- Netzwerk-Konfiguration

## Build 23 · 2026-10-22 · `d464858`
- Schnellere Offline-Erkennung, unsichtbarer Modus

## Build 22 · 2026-10-21 · `8d149d0`
- Bildergalerien im Profil

## Build 21 · 2026-10-21 · `cbd9e8d`
- Bilder

## Build 20 · 2026-10-21 · `59c7d1a`
- Bilder

## Build 19 · 2026-10-21 · `4543af6`
- Blockieren: unsichtbar werden funktioniert

## Build 18 · 2026-10-21 · `b255967`
- Blockieren: Chat leeren und unsichtbar werden

## Build 17 · 2026-10-21 · `c919475`
- Blockieren ueberarbeitet

## Build 16 · 2026-10-21 · `c99ae43`
- Chat loeschen und blockieren (gespeichert auf dem Server)

## Build 15 · 2026-10-21 · `96f4291`
- Docker-Betrieb und Server-Grundfunktionen

## Build 12 · 2026-10-21 · `a6492a3`
- Profile verschluesselt zwischengespeichert, Online-Status verbessert

## Build 11 · 2026-10-21 · `9d1551d`
- Profile werden gespeichert, Online-Status verbessert

## Build 10 · 2026-10-21 · `9d6ba05`
- Grid verbessert, Signaling verbessert

## Build 9 · 2026-10-21 · `1871f30`
- Eindeutige Geraete-ID, stabilere Signaling-Verbindung

## Build 8 · 2026-10-21 · `cfb5369`
- Frei definierbares Profil-Schema, Debug-Funktionen

## Build 7 · 2026-10-21 · `84be2bf`
- Dokumentation und Richtlinien

## Build 6 · 2026-10-21 · `0345cb2`
- Erster Prototyp: Build-Konfiguration

## Build 5 · 2026-10-21 · `d14d264`
- Erster Prototyp: Build-Konfiguration

## Build 4 · 2026-10-21 · `9a90934`
- Erster Prototyp: Build-Konfiguration

## Build 3 · 2026-10-21 · `faa3ab0`
- Erster Prototyp

## Build 2 · 2026-10-21 · `706e7a0`
- Erster Prototyp

## Build 1 · 2026-10-21 · `8212eed`
- Projekt angelegt
