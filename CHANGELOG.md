# Changelog

Pro Build (= Commit) die Aenderungen, neueste oben. Im Debug-Modus im Menue unter "Changelog" sichtbar.

## Build 200 · 2026-10-29
- Behoben: Chrome bot fuer die deutsche bzw. englische Oberflaeche faelschlich eine Uebersetzung an; andere Sprachen koennen die Oberflaeche jetzt uebersetzen lassen, Chats und Profile bleiben davon ausgenommen
- Behoben: Runterziehen zum Neuladen in der Chatliste klappte schlecht (die Browser-Geste kam dazwischen); im eigenen Profil geht es jetzt auch
- "Nur zeigen fuer" laesst sich per Schalter aus- und einschalten, ohne die Auswahl zu verlieren

## Build 198 · 2026-10-28 · `50be4d7`
- Neu: Profil loeschen (Einstellungen > Allgemein). Loescht dein Profil auf dem Server und alles auf dem Geraet; bei deinen Kontakten verschwinden Verlauf und Bilder, dort steht dann "Profil wurde geloescht" (auch wenn sie gerade offline sind)

## Build 197 · 2026-10-28 · `c61fb9b`
- Interaktionen: eine Zeile pro Person, neueste Aktivitaet oben ("hat dir eine Flamme geschickt · 3× dein Profil angesehen")
- Behoben: "Nur zeigen fuer" hatte keine waehlbaren Felder, wenn die App im Chat-Modus gestartet war

## Build 195 · 2026-10-28 · `06dabdd`
- Neu laden einstellbar (Einstellungen > Allgemein > Erweitert): ganze Seite (Standard) oder nur die Daten. Gilt fuer Runterziehen im Grid und in der Chatliste (neu) und Hochziehen im Chat; bei "Nur Daten" laedt "Seite neu laden" im Menue die ganze Seite
- Behoben: beim Aktualisieren des Grids stapelten sich Hinweise

## Build 194 · 2026-10-28 · `2d8bf30`
- Profil in "Entdecken": neue Felder Groesse, Gewicht, Koerperbau, Tribes, Sucht nach und Beziehungsstatus; Mehrfachauswahlen waehlst du jetzt bequem als Chips
- Behoben: Einrichtungs- und Profilfenster, die hoeher als der Bildschirm sind, liessen sich oben nicht erreichen (der Anfang lag ausserhalb)
- "Nur zeigen fuer" steht jetzt unter Einstellungen > Privatsphaere > Sichtbarkeit im Grid, uebersichtlicher, und gilt fuer Alter und alle Auswahlfelder

## Build 193 · 2026-10-28 · `6bf216a`
- "Wer mich im Grid sieht": auch relativ zu dir moeglich (Alter wie ich, aelter oder juenger als ich; Auswahlfelder wie ich), passt sich an, wenn du dein Profil aenderst
- Betrieb: Startregel fuer neue Nutzer (`CLIENT_DEFAULTS.audience`) und Mindestwerte, die der Router in jede Karte setzt (`AUDIENCE_MINIMUM`, z. B. ab 18)

## Build 192 · 2026-10-28 · `166277f`
- Grid aufgeraeumt: die Bereiche stehen oben, mit Anzahl (Grid, Matches); die Kachel "In deiner Naehe" ist jetzt eine schmale Zeile. Aktualisieren durch Herunterziehen, auch in der installierten App auf dem iPhone

## Build 191 · 2026-10-28 · `b3bcfb0`
- Neu: "Wer mich im Grid sieht" (Einstellungen > Privatsphaere): zeig dich nur Leuten, deren Profil passt, z. B. nur bestimmte Positionen oder ein Altersbereich. Der Router bekommt nur einen kurzen Code der Regel; geprueft wird in der App der anderen

## Build 190 · 2026-10-28 · `38acaad`
- Seitlich durch Profile wischen ist jetzt animiert: die Karte folgt dem Finger und das naechste Profil gleitet herein
- Grid: geaenderte Profile werden beim Vorladen erkannt (der Router kennt nur die Versionsnummer) und neu geholt; unveraenderte, schon bekannte Profile kosten keine Anfrage mehr

## Build 189 · 2026-10-28 · `6a2c55d`
- Grid-Filter (Pfeil-Knopf neben den Grid-Bereichen): Entfernung, nur mit Foto, Alter und Auswahlfelder aus dem Profil. Gefiltert wird nur auf deinem Geraet; wessen Profil noch nicht geladen ist, steht als "unbekannt" hinten
- Im geoeffneten Profil wischst du seitlich zum naechsten Profil (am PC Pfeiltasten)

## Build 188 · 2026-10-28 · `b3bfbed`
- Grid in drei Bereichen (in "Entdecken"): Grid, Interaktionen (wer dir eine Flamme geschickt oder dein Profil angesehen hat, mit "Flamme zurueck") und Matches (noch nicht angeschriebene oben). Die Interaktionen liegen nur auf deinem Geraet

## Build 181 · 2026-10-28 · `5fb8dcd`
- Mehrere Bilder senden: in der Durchsicht pro Bild Snap, Bild oder Secure Snap waehlen und einzelne Bilder im Editor bearbeiten
- Betrieb: Standardwerte fuer die Benachrichtigungs-Schalter per `CLIENT_DEFAULTS` (`notifyMatch` ... `notifyChatEvents`, `shareProfileViews`)

## Build 180 · 2026-10-28 · `a25c3b1`
- Lange Chats oeffnen schneller: zuerst die letzten 150 Nachrichten, beim Hochscrollen kommen aeltere dazu
- Neu: "Chat nach Tagen" (Einstellungen > Chat): unter der Kontaktleiste blaetterst du mit Pfeilen oder Wischen Tag fuer Tag

## Build 179 · 2026-10-28 · `e830517`
- Benachrichtigungen einzeln einstellbar (Einstellungen > Chat > Benachrichtigungen): Match, Flamme, Adden, Nachrichten aus "Entdecken" und aus "Chat & Freunde", Profilbesuche und Chat-Ereignisse. Jeder Schalter gilt fuer Push und Hinweise in der App
- Flammen, Matches und Freundschaftsanfragen melden sich jetzt auch, wenn die App geschlossen ist
- Neu: Profilbesuche in "Entdecken" (beidseitig freiwillig): nur wenn der Besucher "Meine Profilbesuche zeigen" einschaltet und du "Profilbesuch" an hast, hoechstens alle 6 Stunden pro Person

## Build 178 · 2026-10-28 · `a407c50`
- Flirt-Knopf: scrollst du im Chat weit nach oben, faehrt er zu einem schmalen Streifen ein und stoert beim Lesen nicht; tippen darauf oder ins Eingabefeld holt ihn zurueck, unten ist er von selbst wieder da. Er liegt jetzt auch nicht mehr hinter den Pfeilen der Nachrichten
- Wischen im eigenen Profil klappt jetzt auch, wenn der Finger auf einem Eingabefeld startet
- Behoben: im Chat am Ende hochziehen flackerte die Anzeige darunter
- Mehrere Bilder aus der Galerie: vor dem Senden alle durchsehen (wischen oder Pfeile), einzelne entfernen, dann "Alle senden"
- Behoben: Chatliste, Chat-Wechsler und Profil zeigten "Abwesend" noch nicht (nur gruen oder offline); jetzt mit gelbem Punkt

## Build 177 · 2026-10-28 · `2317cb8`
- Eingabeleiste aufgeraeumt: die Flamme sitzt genau ueber dem Senden-Knopf und gehoert sichtbar zur Leiste; das Medien-Menue im Flirt-Modus sieht aus wie das Chat-Menue (Album teilen, Video senden). Den Eintrag "Foto aus der Galerie" gibt es nicht mehr (er fuehrte ins Snap-Menue)

## Build 176 · 2026-10-28 · `1f3a9b4`
- Wischen: Seitenmenue nach rechts schliesst es; Einstellungen am ersten Bereich nach rechts schliessen; im Chat die Eingabeleiste nach rechts wischen fuehrt zur Chatliste (abschaltbar unter Einstellungen > Chat); Wischen klappt jetzt auch, wenn der Finger auf einem Schalter oder einer Auswahl startet
- Behoben: Profil im Chat liess sich im Browser oft nicht nach unten wegwischen (der Browser wollte stattdessen die Seite neu laden)
- Neuer Status "Abwesend": ist deine App im Hintergrund (Handy weggewischt, Tab am PC nicht sichtbar), sehen deine Kontakte "Abwesend" statt "online"
- Behoben: lief die App im Hintergrund noch, kamen Nachrichten zwar an, aber ohne Benachrichtigung. Jetzt stoesst der Absender dann eine Benachrichtigung an (ohne Inhalt, nur wer geschrieben hat)

## Build 175 · 2026-10-28 · `f15cfc1`
- Flirt-Knopf: hoeher und auf der Oberkante der Eingabeleiste, die Antwort-Leiste liegt jetzt darunter statt verdeckt; der Punkt zeigt jede neue Flirt-Nachricht, nicht nur die letzte; das Eingabefeld behaelt beim Umschalten den Fokus
- Flirt-Modus: Album und Video stecken hinter einem Medien-Knopf, der nach oben aufklappt (dazu Foto aus der Galerie)
- Behoben: am PC flackerte die Leiste an Nachrichten beim Darueberfahren

## Build 174 · 2026-10-28 · `aae8e7c`
- Flirt-Knopf neu: kleine Flamme ueber dem Senden-Knopf statt oben im Chat. Tippen schaltet den Flirt-Modus (Flamme und Senden werden zu einem Block, das Eingabefeld zeigt "Flirt-Nachricht…"), Senden lange druecken schickt nur diese Nachricht als Flirt, die Flamme lange druecken blendet sie fuer diesen Chat aus (zurueck ueber ⋮). Abschaltbar unter Einstellungen > Chat > Nach dem Adden

## Build 173 · 2026-10-28 · `e56bb82`
- Wischen: im Profil nach links oeffnet das Menue; in den Einstellungen blaetterst du seitlich durch die Bereiche (nicht auf Schaltern und Reglern) und verlaesst sie, indem du oben nach unten ziehst
- Behoben: nach Neu laden kam das Ende einer 1x/2x/3x-Album-Ansicht manchmal nicht beim Besitzer an (beim Start war die App noch nicht beim Router angemeldet)

## Build 172 · 2026-10-28 · `f7d9dd8`
- Album-Ansicht: nach unten wischen schliesst erst nach einem deutlich laengeren Zug (vorher waren 1x-Alben schnell aus Versehen vorbei); ab der Schwelle wird das Fenster leicht durchsichtig, loslassen schliesst
- Profile im Chat lassen sich weiterhin per Wischen nach unten schliessen (oben im Fenster)

## Build 171 · 2026-10-28 · `716c5cd`
- Behoben: bei Alben mit 1x/2x/3x ansehen merkte der Besitzer oft nicht, dass alle Ansichten verbraucht waren, und die Person blieb in den Album-Einstellungen stehen. Jetzt kommt das Ende auch ohne direkte Verbindung an, und du bekommst den Hinweis "X hat ... fertig angesehen"

## Build 170 · 2026-10-28 · `50c40dd`
- Behoben: einen Chat loeschen oder blockieren kam beim Partner nicht an, wenn er gerade offline war; sein Chat blieb stehen. Jetzt erreicht ihn die Loeschung beim naechsten Oeffnen der App
- Behoben: die Flamme (Flirt-Modus) erschien auch in Chats, in denen nie geflirtet wurde; jetzt nur noch bei Match und Nachrichten aus "Entdecken"

## Build 169 · 2026-10-28 · `b16cd7d`
- Behoben: Alben mit 1x/2x/3x ansehen liessen sich nach dem Oeffnen per Neu laden erneut ansehen, ohne dass es zaehlte; jetzt zaehlt jedes Oeffnen, und eine durch Neu laden unterbrochene Ansicht endet beim naechsten Start

## Build 168 · 2026-10-28 · `02cc811`
- Flirt-Modus: in Freundes-Chats, die aus einem Match kommen, schaltet die Flamme oben im Chat zwischen normal und Flirt. Im Flirt-Modus siehst du alles und schreibst Flirt-Nachrichten; im normalen Chat bleibt der Flirt verborgen, ein Punkt an der Flamme zeigt neue Flirt-Nachrichten. Ersetzt die Zeile "Entdecken-Verlauf ausgeblendet"

## Build 166 · 2026-10-28 · `f6c1576`
- Nach dem Adden bleibt es ein Chat, aber der Flirt aus "Entdecken" ist im Freundes-Chat erst einmal ausgeblendet; oben im Chat kannst du ihn jederzeit einblenden. Abschaltbar unter Einstellungen > Chat > Nach dem Adden

## Build 165 · 2026-10-28 · `3f86068`
- Behoben: wer einer Einladung aus "Entdecken" folgte, konnte schreiben, obwohl der andere nur Matches zulaesst; die Nachrichten kamen still nicht an. Jetzt wartet die Eingabe kurz auf das Profil und zeigt dann ehrlich, ob erst eine Flamme noetig ist

## Build 164 · 2026-10-28 · `f8e851a`
- Betrieb: Jenkins baut auf Neben-Branches jetzt auch das echte Image zur Probe, deployt dort aber nie (wie bisher nur main)

## Build 162–163 · 2026-10-28 · `366ef79`, `90cb2fd`
- Technik: Umstieg auf Tailwind CSS 4 (behebt die gemeldeten Sicherheitshinweise in den Build-Werkzeugen); einige Abstaende sind minimal enger

## Build 161 · 2026-10-28 · `8d53162`
- Begrenzt geteilte Alben raeumen sich beim Empfaenger selbst auf: nach einer Ansicht sind auch die gespeicherten Bilder weg, und zeitlich begrenzte Alben loescht seine App zur Frist selbst, auch wenn du dann offline bist

## Build 160 · 2026-10-28 · `b93e303`
- Behoben: Alben mit 1x/2x/3x ansehen liessen sich nach dem Oeffnen noch 15 Minuten lang beliebig oft wieder oeffnen. Jetzt endet eine Ansicht mit dem Schliessen, und nach der letzten ist der Zugriff sofort weg

## Build 159 · 2026-10-28 · `fb52534`
- Behoben: entzogener Album-Zugriff kam bei Personen, die gerade offline waren, nicht an; sie behielten die Schluessel bis zum Ablauf. Der Entzug geht jetzt auch ueber den Server-Zwischenspeicher, und die Schluessel werden geloescht

## Build 158 · 2026-10-27 · `f552228`
- Sprachnachrichten: auf der Leiste springen (tippen oder ziehen) und schneller abspielen (1x, 1,5x, 2x)
- Behoben: beim Abspielen flackerten Play-Knopf und Leiste, sobald der Chat neu gezeichnet wurde
- Alben begrenzt teilen: beim Teilen im Chat waehlbar, ob normal oder nur 1x/2x/3x ansehen bzw. 15 min/1 h/24 h; danach endet der Zugriff von selbst. Begrenzt freigegebene Personen stehen mit ihrem Stand in der Alben-Verwaltung, ab 3 Personen eingeklappt

## Build 157 · 2026-10-27 · `72f3ef2`
- Neues Nachrichten-Menue: lange druecken (am PC Rechtsklick) zeigt oben die Reaktionen und darunter Antworten, Kopieren, Markieren und Loeschen
- Behoben: das Menue bzw. die Reaktionsauswahl ging manchmal gleich wieder zu, vor allem nachdem man vorher schon etwas gemacht hatte

## Build 156 · 2026-10-27 · `fedb140`
- Behoben: Album-Karten im Chat und die Vorschaubilder in der Alben-Verwaltung flackerten beim Neuzeichnen

## Build 155 · 2026-10-27 · `7c939f8`
- Alben im Profil aufgeraeumt: jedes Album als eigene Karte mit Vorschaubild, Einstellungen zum Aufklappen und einer Zeile pro Person (Gueltigkeit, Zugriff entziehen)

## Build 154 · 2026-10-27 · `c1e2b67`
- Behoben: Kontakte aus "Chat & Freunde" bekamen dein Entdecken-Profil (z. B. Alter), wenn du gerade in "Entdecken" warst, und umgekehrt. Jetzt zaehlt die Liste des Chats

## Build 153 · 2026-10-27 · `fbc3c72`
- Alben: Schluessel koennen jetzt auch eine Woche gelten, und die Gueltigkeit laesst sich pro Person festlegen (neben jeder Person im Album)

## Build 152 · 2026-10-27 · `fb962bd`
- Alben: pro Album waehlbar, wie die Vorschau im Chat aussieht: normal, unscharf oder ohne Bild

## Build 151 · 2026-10-27 · `877ac5b`
- Einladungslinks merken sich den Modus: wer sie oeffnet, landet in diesem Modus und der Chat bei beiden in derselben Liste. Ist der Bereich ausgeschaltet, erscheint nur ein Hinweis

## Build 149 · 2026-10-27 · `e300685`
- Behoben: die Profilfelder je Modus vom Server wurden verworfen; "Nur Chat" nutzt jetzt wie vorgesehen das schlanke Profil (Name und Status), eigene Profilfelder des Betreibers greifen wieder
- Betrieb: Profilfelder je Modus (inkl. Event mit "Aktueller Workshop") direkt in `compose.yaml`

## Build 147 · 2026-10-27 · `bade31f`
- Snap-Editor: einmal auf einen Text tippen, um ihn nachzubearbeiten (Text, Art, Hintergrund, Farbe)
- Snap-Editor: "Rueckgaengig" macht jetzt auch Zoomen/Drehen des Hintergrunds, Filter, Verschieben/Groesse/Drehung von Text und Emojis und das Loeschen per Doppeltippen rueckgaengig

## Build 146 · 2026-10-27 · `6c43427`
- Snap-Editor: verschiedene Textarten (klassisch, kursiv, Schreibmaschine, Handschrift, Neon) und ein Texthintergrund (abgedunkelt oder farbig)
- Snap-Editor: Filter fuer das Foto (Schwarz-Weiss, Farbenfroh, Rot) und die Uhrzeit als Sticker, frei platzierbar

## Build 145 · 2026-10-27 · `1afb32c`
- Snap-Editor: Text und Emojis mit zwei Fingern groesser/kleiner machen und drehen (erst ein Finger auf das Element, dann ein zweiter); bei 90 Grad rastet es ein. Mit zwei Fingern auf dem Hintergrund das Foto zoomen und drehen. Am PC: Mausrad beim Ziehen, mit Shift drehen
- Snap-Kamera: nach oben wischen oeffnet die Galerie jetzt ueberall im Bild; Snap/Bild wechseln per Wischen klappt auch am rechten Rand und in der Vorschau
- Behoben: beim Herunterziehen der Kontaktleiste im Chat lagen Nachrichten und Videos davor

## Build 144 · 2026-10-27 · `18936da`
- Neue Einstellung "Eigene Snaps behalten" (Medien > Snaps): nachdem der Empfaenger alles gesehen hat, kannst du deine Snaps und Secure Snaps noch eine Weile ansehen und speichern (Standard 1 Stunde)
- Behoben: Secure Snaps erscheinen jetzt bildschirmfuellend statt manchmal sehr klein und lassen sich mit zwei Fingern (am PC mit dem Mausrad) zoomen

## Build 143 · 2026-10-27 · `cd39256`
- Eigene Secure Snaps lassen sich nur ansehen, bis der Empfaenger alle Ansichten verbraucht hat; danach sind sie auch bei dir geloescht
- Behoben: baute ein Geraet die Verbindung neu auf, lehnte das andere sie nach einem Secure Snap manchmal ab und der Aufbau hing lange

## Build 142 · 2026-10-27 · `4351fba`
- Behoben: Videos und Bilder im Chat flackern nicht mehr, wenn der Chat neu gezeichnet wird (z. B. waehrend ein Video ankommt)
- Behoben: die erste Ansicht eines Secure Snaps war manchmal nur einen Augenblick lang zu sehen
- Behoben: eigene Secure Snaps lassen sich wieder ansehen
- Behoben: beim Oeffnen eines Secure Snaps wartete die App manchmal endlos auf die Freigabe; jetzt verbindet sie neu und fragt erneut

## Build 141 · 2026-10-27 · `871c50f`
- Snap-Editor: neuer Schalter neben den Werkzeugen, um ein Bild oder einen Snap als "nicht speicherbar" zu markieren

## Build 140 · 2026-10-27 · `ab295a5`
- Videos lassen sich jetzt auch speichern und teilen
- Neue Einstellung (Medien > Schutz): wer deine Bilder und Videos speichern darf, "Nur Freunde" (Standard) oder "Alle Chat-Partner". Eigene Medien kannst du immer speichern

## Build 139 · 2026-10-27 · `d4f81d1`
- Teilen nach OpenGrid: in der installierten App erscheint OpenGrid im Teilen-Menue anderer Apps; Fotos gehen nach "Senden an" direkt in den Chat, Text und Links landen im Eingabefeld

## Build 138 · 2026-10-27 · `fa71f61`
- Chat-Bilder im Chat- und Freunde-Bereich lassen sich jetzt auch ueber das Teilen-Menue des Geraets weitergeben, Speichern bleibt daneben

## Build 135 · 2026-10-26 · `46bdceb`
- Beim ersten Start waehlst du, was du willst: "Nur Entdecken", "Social" oder "Entdecken & Freunde". Einstellungen und Knoepfe anderer Bereiche verschwinden; bei "Nur Entdecken" gibt es kein Adden, auch nicht nach einem Match
- Bereich aendern oder alle Modi wieder einschalten: Einstellungen > Allgemein > App-Modus > Erweitert

## Build 133 · 2026-10-26 · `7cc0f6e`
- Deutsche Texte in der App mit echten Umlauten (ä, ö, ü, ß)
- Push-Benachrichtigungen erscheinen in der Sprache des Browsers (Deutsch oder Englisch)

## Build 132 · 2026-10-26 · `54406ec`
- Betrieb: Jenkins braucht keine `.env`-Datei mehr; Einstellungen pro Pipeline als Folder Properties, das TURN-Geheimnis als einzelnes Credential (die alte `.env` wird uebergangsweise weiter genutzt)

## Build 131 · 2026-10-26 · `5992b3f`
- Info-Seite fuer alle: was OpenGrid ist, erste Schritte, Funktionen, Privatsphaere, haeufige Fragen und Selbst betreiben, auf Deutsch und Englisch, wahlweise einfach erklaert oder mit Fachbegriffen; im Menue unter "Hilfe & Info" und beim Einrichten des Profils
- Betreiber koennen die Info-Seite auf eine eigene Subdomain legen (`INFO_HOST`, `APP_URL`)
- Changelog in der App mit derselben Darstellung wie die Info-Seite

## Build 130 · 2026-10-26 · `1fd59b0`
- Uebersetzungen jetzt mit festen Schluesseln in `i18n/de.properties` und `i18n/en.properties`; die App laedt nur noch die eingestellte Sprache
- Behoben: Platzhalter im Nachrichtenfeld und einige Texte (Profil einrichten, Bildbetrachter, Snap-Kamera) blieben im Englischen deutsch

## Build 129 · 2026-10-26 · `91a2aa8`
- Behoben: bauten beide Seiten gleichzeitig eine direkte Verbindung auf und hing der erste Versuch, kollidierten die Wiederholungen immer wieder; jetzt wartet eine Seite kurz
- Behoben: Nachrichten, die direkt nach dem Verbindungsaufbau ankamen, bevor der eigene Schluessel fertig war, gingen verloren (z. B. Profil-Anfragen, dann fehlten Name und Bild)

## Build 128 · 2026-10-26 · `f35f269`
- Einstellungen ohne Umwege: Zahnrad im Profil, oder vom Profil nach links wischen (wie ein vierter Tab); im Menue den Modus direkt umschalten statt Profil-Kopf und Einladen-Eintrag (doppelt zur Navigation und Chatliste)
- Behoben: nach dem Oeffnen eines Chats liess sich nicht mehr zwischen den Tabs wischen

## Build 127 · 2026-10-26 · `270baee`
- Menue neu: eigenes Profil und aktueller Modus oben, dazu Modus wechseln, Kontakt einladen, Einstellungen und Changelog (jetzt immer sichtbar); Abmelden und Version unten

## Build 126 · 2026-10-26 · `6c77237`
- Leere Listen und Ladeanzeigen ueberall im gleichen Stil; leere Chatliste mit Hinweis und "Kontakt einladen"
- Profil: Aenderungen zeigen unten "Nicht gespeichert" mit Verwerfen und Speichern (statt Knopf oben); Profilbild auf dem Smartphone direkt antippbar
- Englisch: auch alle Hinweis-Meldungen uebersetzt (fehlten bisher)

## Build 125 · 2026-10-26 · `e5d9463`
- Eingabeleiste aufgeraeumt: alle Knoepfe gleich gross und gut zu treffen, Eingabefeld gleich hoch, Platzhalter bleibt einzeilig
- Desktop: keine doppelte Avatar-Leiste mehr im Chat (die Chatliste steht daneben)

## Build 124 · 2026-10-26 · `7a5bea7`
- Englisch als zweite Sprache: Einstellungen > Allgemein > Sprache (Automatisch folgt dem Geraet); Betreiber koennen einen Standard vorgeben (`CLIENT_DEFAULTS.language`)
- Deutsche Oberflaeche jetzt durchgehend deutsch (Profilfelder, Grid, Benachrichtigungs-Knopf u. a. waren englisch)
- Uhrzeiten ueberall im 24-Stunden-Format; in der Chatliste "Gestern" statt Datum
- Behoben: beim Start konnte selten ein Skriptfehler auftreten, wenn die TURN-Konfiguration sehr schnell geladen war

## Build 123 · 2026-10-26 · `6d92cad`
- Einstellungen neu: Bereiche als Tabs (Allgemein, Privatsphaere, Chat, Medien, Darstellung), Schalter statt Kaestchen, jede Option mit kurzer Erklaerung; auf dem Smartphone deutlich kuerzer und besser zu bedienen
- Auswahlfelder ohne interne Kuerzel ("Alles fuer alle" statt "1 - Alles fuer alle")
- Behoben: nach einem Verbindungsabbruch kamen Videos, Originalbilder und der Rest langer Sprachnachrichten erst nach einer Minute; auf der neuen Verbindung werden sie jetzt sofort angefragt

## Build 122 · 2026-10-26 · `458a67f`
- Videos spielen jetzt im Vollbild wie der Bildbetrachter (Absender, Zeit und Laenge oben; nach unten wischen schliesst) statt im kleinen Fenster

## Build 120 · 2026-10-26 · `90af994`
- Sprachnachrichten bis 15 Minuten: die erste Minute kommt wie bisher auch offline an, der Rest nur ueber eine direkte Verbindung; beim Abhoeren wird er geholt und es geht nahtlos weiter
- Am Maximum stoppt die Aufnahme nur, es wird nichts mehr automatisch gesendet

## Build 119 · 2026-10-26 · `c4062d7`
- Sprachnachrichten: bei leerem Eingabefeld Mikrofon statt "Senden", bis 60 Sekunden, kommen auch offline ueber den Router-Cache an; Text darunter nur, wenn das Geraet lokal verschriftlichen kann
- Videos senden (bis 25 MB): der andere sieht sofort ein Vorschaubild, das Video selbst kommt nur ueber eine direkte Verbindung, nie ueber den Server
- Kontaktleiste im Chat nach unten ziehen oeffnet das Profil
- Wischen zum Antworten klappt auch im Leerraum neben der Nachricht
- Behoben: Wischen zum Antworten klappte oft nicht (Start auf dem kleinen Pfeil der Nachricht wurde ignoriert)
- Aufgaben-Skript: `scripts/archive-tasks.sh --open` holt offene Aufgaben aus dem Backlog aufs Board

## Build 117 · 2026-10-26 · `374c090`
- Behoben: ging die direkte Verbindung kurz vor dem Senden verloren (Kanal noch scheinbar offen), hing die Nachricht bis zum naechsten Abgleich; der Empfaenger bestaetigt jetzt jede direkte Nachricht, ohne Bestaetigung geht sie nach 5 Sekunden ueber den Router-Cache (meldet der Server den Partner offline, sofort)

## Build 116 · 2026-10-26 · `ba35ae7`
- Ungelesen-Badges: Zahl neuer Nachrichten an jedem Chat (Liste, Kontaktleiste, Schnellwechsel), Summe am Chat-Tab, im Seitentitel und am App-Symbol; Punkt am Listen-Wechsel, wenn die andere Liste Neues hat. Der Lesestand bleibt auf dem Geraet (keine Lesebestaetigung)

## Build 114 · 2026-10-26 · `509011e`
- Behoben: neue Chats (z. B. erste Nachricht ueber den Router-Cache) zeigten Name und Bild erst nach einem Klick aufs Profil; das Profil wird jetzt automatisch geholt, sobald der Absender online ist (sonst ueber andere verbundene Teilnehmer)

## Build 113 · 2026-10-26 · `bc1bc97`
- Behoben: auf dem Smartphone rutschte das Nachrichtenfeld nach dem Neuladen manchmal aus dem Bild (Kontaktleiste scrollte die ganze Seite mit, Scrollposition wurde wiederhergestellt); die Tastatur verkleinert jetzt den Chat statt ihn zu verdecken
- Behoben: der mitgelieferte coturn startete nicht (`--no-dtls` gibt es in coturn 4.18 nicht mehr), daher keine TURN-Relays; Image jetzt fest auf 4.18.0
- Betrieb: TURN-Pruefung direkt im Container (`docker compose exec open-grid node scripts/turn-check.mjs`)

## Build 108 · 2026-10-26 · `855be2c`
- Behoben: Deployment brach auf Jenkins-Agents ohne Docker-CLI ab; die Pipeline laedt sie jetzt bei Bedarf selbst und nutzt den eingehaengten Docker-Socket des Hosts statt TCP

## Build 107 · 2026-10-26 · `96ee539`
- Betrieb: automatisches Deployment per Jenkins (`Jenkinsfile`): bei jedem Push auf `main` Unit- und E2E-Tests, danach `docker compose up`; die App zeigt Build-Nummer und Commit an

## Build 106 · 2026-10-26 · `3be65f7`
- Betrieb: der TURN-Server (coturn) steckt jetzt mit in der `compose.yaml` (Profil `turn`), eine gemeinsame `.env` fuer beide; das separate `turn/compose.yml` entfaellt

## Build 105 · 2026-10-26 · `53229ee`
- Einmal-Snaps laufen nach dem ersten Ansehen ab: der Absender waehlt 15, 30 oder 60 Minuten oder "nie" (Standard 30 Minuten, vom Betreiber per `CLIENT_DEFAULTS` einstellbar); der Empfaenger sieht keine Restzeit

## Build 103 · 2026-10-25 · `fbf8733`
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
