# Klipy als GIF-Anbieter (Board T34)

Stand: 2026-11-10. Quellen: `https://docs.klipy.com/llms-full.txt` (API-Docs inkl.
"Integration Requirements", "Attribution", "Advertisements", "Report API"),
`https://klipy.com/support/terms-services` (Nutzungsbedingungen, Stand 23.06.2026).

## Entscheidung

- Klipy ist die eingebaute Anbieter-Implementierung fuer die GIF-Suche
  (`GIF_PROVIDER=klipy`), standardmaessig **aus** (`GIF_PROVIDER=off`).
- Jeder Betreiber nutzt seinen **eigenen** App-Schluessel (`GIF_PROVIDER_KEY`).
  Kein gemeinsamer Projekt-Schluessel: der Schluessel ist zwangslaeufig
  oeffentlich (Anfragen kommen vom Browser), ein Missbrauch traefe sonst alle
  Router auf einmal.
- Giphy faellt weg (Production-Schluessel nur gegen individuell verhandelte
  Gebuehr), Tenor ebenso (oeffentliche API seit 30.06.2026 abgeschaltet).

## Was Klipy verlangt und wie OpenGrid es umsetzt

| Regel (Klipy) | Umsetzung in OpenGrid |
|---|---|
| Suchfeld-Platzhalter "Search KLIPY" (Pflicht) | `#gif-provider-search`, nicht uebersetzt |
| "Powered by KLIPY" (optional) | unter den Ergebnissen |
| Anfragen und Medien direkt vom Client | Browser fragt `api.klipy.com`, laedt `static*.klipy.com`; nie ueber Router oder Proxy (`server/gif-proxy.js` lehnt ab) |
| URLs unveraendert verwenden | Medien-URL aus der Antwort, unveraendert gesendet |
| Kein Speichern/Spiegeln/Kopieren der Medien | kein Service-Worker-Cache, kein Cache-Index, nicht in die Router-Bibliothek, nicht als Snap-Sticker; Favoriten merken nur die URL |
| Reihenfolge/Zusammensetzung nicht aendern, nicht filtern | Ergebnisse in Antwort-Reihenfolge, eigener Reiter "KLIPY" (nicht gemischt) |
| Filter nur ueber das Partner-Panel | `content_filter` als Abfrage-Parameter (offizieller Parameter, Standard bei Klipy `off`, bei uns `high`) |
| Werbung | im Partner-Panel aus lassen; falls doch Eintraege mit `type: 'ad'` kommen, zeigt OpenGrid sie nicht (siehe offene Fragen) |

Bewusst weggelassen (optional laut Docs): `customer_id` und der Share-Trigger
(`POST /gifs/share/{slug}`), damit Klipy Nutzer nicht wiedererkennt.

## Was zur Sperre eines Schluessels fuehren kann

- Nutzungsbedingungen Punkt 9: Klipy kann den Zugang jederzeit, nach eigenem
  Ermessen und ohne Vorwarnung sperren. Einen festen Katalog gibt es nicht; die
  erwaehnten "API Terms" sind nicht verlinkt.
- Realistische Gruende: Verstoss gegen die Integrations-Regeln (siehe oben),
  automatisiertes Abgreifen (Scraping), Spam, Schadcode.
- Testschluessel: hoechstens 100 Anfragen/Stunde (gedrosselt, keine Sperre
  beschrieben). "Production" im Partner-Panel beantragen fuer unbegrenzt.
- Risiko bei OpenGrid: nicht die Integration, sondern der oeffentliche
  Schluessel (jeder kann ihn aus `/api/config` lesen und anderswo nutzen). Ob
  sich ein Schluessel auf Domains/Origins beschraenken laesst, ist nicht
  dokumentiert (Frage an Klipy).

## Offene Fragen an Klipy

1. Ist ein Open-Source-Projekt zum Selbsthosten mit einem eigenen Schluessel
   je Instanz in Ordnung (jede Instanz = eigene "Plattform" im Partner-Panel)?
2. Laesst sich ein Schluessel auf Origins/Domains beschraenken?
3. Ist ein Cache **nur auf dem Endgeraet** erlaubt (Cache Storage im Browser,
   je Nutzer, kein Server, keine Weitergabe), ggf. mit Ablauf/Revalidierung nach
   Vorgabe? Bisher cacht OpenGrid Klipy-Medien gar nicht.
4. Duerfen Eintraege mit `type: 'ad'` ausgelassen werden, wenn ein Betreiber
   Werbung nicht im Panel abgeschaltet hat (OpenGrid kann keine Werbe-iframes
   zeigen; CSP und Datenschutz)?
5. Ist das Senden einer Klipy-Medien-URL in einer Ende-zu-Ende-verschluesselten
   Chat-Nachricht ("Teilen") so gedacht, auch ohne Share-Trigger?
6. Duerfen Nutzer-Meldungen ueber die Report-API mit einer zufaelligen,
   geraetebezogenen `customer_id` (nicht mit dem Konto verknuepft)
   weitergegeben werden?

## Antragsentwuerfe (zum Absenden durch Betreiber bzw. Projekt)

Platzhalter in eckigen Klammern ersetzen. Nichts davon wird automatisch
versendet.

### 1. Production-Zugang (Partner-Panel, je Betreiber)

```text
Platform name: OpenGrid ([your router domain])
Type: Web app (PWA), self-hosted instance of the open-source project OpenGrid
Use case: GIF search and sharing inside an end-to-end encrypted chat. Users
search KLIPY in a dedicated "KLIPY" tab (placeholder "Search KLIPY", "Powered
by KLIPY" shown). Requests and media loads go directly from the user's browser
to api.klipy.com / static*.klipy.com; no server-side requests, no proxy, no
media cache, results shown unaltered in KLIPY's order. Only the media URL is
shared inside the encrypted chat message.
Content filter: high (content_filter=high), ads disabled.
Expected volume: [number of active users] users, about [n] searches per day.
Contact: [name, e-mail]
```

### 2. Fragen und Freigaben (E-Mail an developers@klipy.com, vom Projekt)

```text
Subject: OpenGrid (open-source, self-hosted chat PWA) - KLIPY integration questions

Hello KLIPY team,

we maintain OpenGrid, an open-source, privacy-first chat and discovery web app
(PWA) that people host themselves. We integrated KLIPY GIF search following
your Integration Requirements: requests and media loads come directly from the
user's browser, no proxy, no server-side requests, no media cache, results in
your order in a dedicated KLIPY tab with "Search KLIPY" as placeholder and
"Powered by KLIPY". Shared GIFs are sent as the unmodified media URL inside an
end-to-end encrypted chat message. We do not send customer_id and do not call
the share trigger, so users are not re-identified.

We would like to confirm a few points before recommending KLIPY to operators:

1. Each self-hosted instance would register its own platform and API key in
   the Partner Panel. Is that the right setup for an open-source project?
2. Because requests come from the browser, the app key is visible to clients.
   Can a key be restricted to specific origins/domains?
3. Would you approve a device-local cache only (browser Cache Storage, per
   user, never on a server, never redistributed), with expiry and revalidation
   as you specify? This would avoid repeated downloads and IP exposure for
   recipients. Today we do not cache KLIPY media at all.
4. If an operator has not disabled ads, may we skip objects with type "ad"?
   We cannot render ad iframes for privacy and security (strict CSP).
5. May we forward user reports through your Report API using a random,
   device-local customer_id that is not linked to any account?

Thank you,
[name]
[project URL]
```

## Moegliche naechste Schritte (nach Antwort von Klipy)

- Report-API anbinden (Melden-Knopf auch an Klipy-GIFs, Grund nudity/violence/...).
- Bei Freigabe: lokaler Cache fuer Klipy-Medien mit den Vorgaben (Ablauf,
  Revalidierung, entfernte Inhalte nicht mehr zeigen).
- Vorschaubilder in der Auswahl ueber das `preview`-Format (ein Bild, spart Daten).
