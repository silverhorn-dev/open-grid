# Altersnachweis in Deutschland: Optionen und Empfehlung

Stand: 2026-10-30. Recherche fuer Board T2 ("deutschland: KJM oder die Ausweis-App").
Keine Rechtsberatung: was ein Betreiber rechtlich braucht, muss er selbst klaeren.

## Ausgangslage

- OpenGrid kann heute: Selbstauskunft (`AGE_CHECK=confirm`), EU-Wallet
  (`AGE_PROVIDER=eudi`, nur `age_over_18`), E-Mail-Code.
- Fuer Deutschland fehlt ein echter Nachweis: die EU-Vertrauensliste fuer
  Altersnachweise enthaelt 10/2026 nur Daenemark (AltID); die deutsche
  EUDI-Wallet kommt laut Tracker ab 01/2027.
- Regeln, die jede Loesung einhalten muss:
  - Regel 1: keine Nutzerdaten der App an Dritte; ein Pruefdienst darf nur die
    Pruefung selbst sehen, nie Profil, Chats oder Standort.
  - Datensparsamkeit: der Router speichert nur "ab 18" / "unter 18"
    (`safety_verifications.age_group`), kein Geburtsdatum, keinen Namen.
  - Selbst gehostet: jede Option muss fuer einen einzelnen Betreiber machbar
    sein, nicht nur fuer uns.

## Option A: Deutsche EUDI-Wallet (ueber den vorhandenen `eudi`-Anbieter)

- Was: sobald die deutsche Wallet `age_over_18` (PID oder eigener
  Altersnachweis) ausgibt, funktioniert `AGE_PROVIDER=eudi` ohne neuen Code.
- Fehlt nur: die Aussteller-Zertifikate (PID-Anbieter) als Vertrauensanker.
  - Automatisch, sobald die EU die "List of Trusted Entities" (ETSI TS 119 602)
    veroeffentlicht (Board-Punkt existiert).
  - Bis dahin von Hand per `AGE_TRUST_CERTS`.
- Kosten: keine. Papierkram: keiner (unsignierte Anfragen; signierte Anfragen
  mit Zugangszertifikat erst, wenn Wallets das verlangen, Board-Punkt existiert).
- Datenschutz: am besten, die Wallet gibt nur "ueber 18: ja/nein" heraus.
- Nachteil: Zeitpunkt haengt am Bund (geplant 01/2027); Nutzer brauchen die
  Wallet-App.

## Option B: Online-Ausweis direkt (AusweisApp + eID-Server)

- Was: der Personalausweis hat eine eigene Funktion "Altersverifikation"
  (Antwort nur "aelter als X: ja/nein", kein Geburtsdatum). Ablauf: Browser ->
  AusweisApp (Handy oder PC) -> eID-Server -> Ergebnis an den Router.
- Voraussetzungen fuer jeden Betreiber:
  1. Berechtigung bei der Vergabestelle fuer Berechtigungszertifikate (VfB) im
     Bundesverwaltungsamt beantragen (online moeglich). Gebuehr laut
     Gebuehrenordnung 102 EUR, gueltig hoechstens 3 Jahre; Ablehnung 80 EUR.
  2. Mit dem positiven Bescheid einen Anbieter von Berechtigungszertifikaten
     (BerCA, z. B. D-Trust, Governikus) beauftragen; der darf Gebuehren nehmen.
  3. eID-Server: selbst betreiben oder einen eID-Service-Anbieter nehmen.
     - Selbst betreiben gilt als sehr aufwendig; laut netzpolitik.org (02/2026)
       ist keine eID-Server-Implementierung unter einer Open-Source-Lizenz
       verfuegbar.
     - Die Governikus "German eIDAS Middleware" ist zwar EUPL-1.2 auf GitHub,
       ist aber die Schnittstelle fuer grenzueberschreitende eIDAS-Anmeldungen
       (Betrieb ueber das BSI abgestimmt), kein frei nutzbarer eID-Server fuer
       private Dienste.
     - eID-Service-Anbieter (Governikus, D-Trust, adesso u. a.): Preise nicht
       oeffentlich, Vertrag pro Betreiber.
- Datenschutz: gut (nur ja/nein), der eID-Dienst sieht nur die Ausweispruefung.
- Nachteile:
  - Jeder selbst hostende Betreiber braucht eigenen Bescheid + Zertifikat +
    Vertrag; das Zertifikat ist an den Diensteanbieter gebunden, wir koennen es
    nicht mitliefern.
  - Laufende Kosten (BerCA, eID-Dienst) und Verlaengerung alle 3 Jahre.
  - Viele Nutzer haben die Online-Funktion nicht aktiv oder die PIN vergessen
    (kostenloser PIN-Ruecksetzbrief seit 2024 eingestellt).

## Option C: KJM-anerkannter Pruefdienst (kommerziell)

- Was: die KJM bewertet Konzepte und Module fuer Altersverifikation; laut
  KJM-Pressemitteilungen inzwischen ueber 100 positiv bewertete, z. B. IDnow,
  Yoti, Persona, Ondato, Sumsub, VerifyMyAge, cidaas ID validator, IN ID.
  Eine fortlaufende Gesamtliste haben wir nicht gefunden (nur Pressemitteilungen).
- Methoden: Ausweis-Scan + Selfie, Video-Ident, Kreditkarte, biometrische
  Alterschaetzung, teils auch Online-Ausweis.
- Anbindung: meist OIDC/OAuth oder Webhook mit signiertem Ergebnis; passt in
  eine generische Schnittstelle (`AGE_PROVIDER=oidc`, siehe Empfehlung).
- Nachteile:
  - Kosten pro Pruefung, Vertrag pro Betreiber.
  - Der Dienst bekommt Ausweisbild/Gesicht: technisch erlaubt (er sieht keine
    App-Daten), aber mehr Daten als A oder B. Nur Dienste waehlen, die an uns
    nur "ab 18" zurueckgeben.
  - KJM bewertet das Gesamtkonzept des Betreibers, nicht nur das Modul.

## Vergleich

| | A: DE-Wallet | B: Online-Ausweis | C: KJM-Dienst |
|---|---|---|---|
| Neuer Code | keiner (nur Anker) | eID-Anbindung | generische OIDC-Schnittstelle |
| Papierkram je Betreiber | keiner | BVA-Bescheid, BerCA, eID-Vertrag | Vertrag mit Dienst |
| Kosten | 0 | 102 EUR / 3 Jahre + BerCA + eID-Dienst | pro Pruefung |
| Daten beim Pruefer | nur ja/nein | nur ja/nein | Ausweis/Gesicht (je Dienst) |
| Verfuegbar | ab ca. 01/2027 | sofort | sofort |
| Passt zu self-hosted | sehr gut | schlecht | mittel |

## Empfehlung

1. **Jetzt: generische Schnittstelle `AGE_PROVIDER=oidc`** (Board-Punkt "KJM-
   anerkannter anbieter, generische token-schnittstelle").
   - Der Betreiber traegt Issuer, Client-ID/Secret und den Claim ein, der "ab 18"
     bedeutet (z. B. `age_over_18: true`).
   - Damit gehen C und B, sofern der eID-Service-Anbieter OIDC anbietet, ohne
     dass wir uns an einen Anbieter binden; der Router speichert weiter nur die
     Altersgruppe.
   - Fluss: Router startet Authorization Code + PKCE, Rueckruf an den Router,
     ID-Token pruefen (Signatur ueber JWKS, `iss`, `aud`, `nonce`), Claim lesen,
     Ergebnis wie bei `eudi` speichern.
2. **Ab 01/2027: deutsche EUDI-Wallet** ueber den vorhandenen `eudi`-Anbieter;
   vorher die Aussteller-Zertifikate eintragen, sobald bekannt.
3. **Kein eigener eID-Server**: zu viel Papierkram je Betreiber, kein
   Open-Source-Server; wer den Online-Ausweis will, nimmt einen
   eID-Service-Anbieter ueber Punkt 1.

Entschieden 2026-10-30 (umgesetzt, `server/age-oidc.js`, UC-63): `oidc` gebaut; "unter 18"
nur, wenn der Dienst es ausdruecklich sagt, sonst Ablehnung; Client-Secret im Panel,
verschluesselt mit `SAFETY_KEY`.

Fruehere Fragen:

- `AGE_PROVIDER=oidc` bauen (ja/nein)?
- Welche Altersgruppe gilt, wenn der Dienst nur "ab 18: nein" liefert
  ("unter 18" wie bei der Wallet, oder ablehnen)?
- Darf der Router ein Client-Secret halten (im Admin-Panel, verschluesselt mit
  `SAFETY_KEY`)?

## Quellen

- Gebuehren und Ablauf Berechtigungszertifikat:
  https://www.bayernportal.de/dokumente/leistung/3284112666236,
  https://www1.karlsruhe.de/service/Buergerdienste/leistung.php?id=6009573,
  https://www.service.bremen.de/dienstleistungen/berechtigungszertifikat-fuer-online-ausweisfunktion-beantragen-179871
- Diensteanbieter werden:
  https://www.personalausweisportal.de/Webs/PA/DE/verwaltung/diensteanbieter-werden/diensteanbieter-werden-node.html
- eID-Server, Kosten, Open Source (27.02.2026):
  https://netzpolitik.org/2026/online-ausweis-der-eperso-ist-tot-lange-lebe-der-eperso/
- German eIDAS Middleware (EUPL): https://github.com/Governikus/eidas-middleware
- KJM-Bewertungen (Auswahl):
  https://www.kjm-online.de/pressemitteilungen/kjm-bewertet-weitere-altersverifikationssysteme-positiv-2-2/,
  https://www.kjm-online.de/presse/pressemitteilungen/kjm-bewertet-altersverifikationssysteme-mit-biometrischer-alterskontrolle-positiv/
