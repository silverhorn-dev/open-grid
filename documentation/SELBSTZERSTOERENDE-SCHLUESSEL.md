# Selbstzerstoerende Schluessel

Hintergrund-Dokument (Stand 2026-10-29). Beschreibt, was "selbstzerstoerend" bei Schluesseln
mathematisch bedeuten kann, welche bekannten Verfahren es gibt und wie sie zu OpenGrid passen.
Es ist keine Umsetzungsplanung; die Entscheidungen stehen in `tasks/board.md` (Abschnitt "Eigene
rotierende Verschluesselung") und `tasks/feature-request-rotating-encryption.md`.

## 1. Das Grundproblem

Information laesst sich nicht "entlernen". Hat jemand einen Schluessel einmal kopiert, kann kein
Verfahren ihn aus dessen Speicher entfernen. Jedes Verfahren, das sich "selbst zerstoert", beruht
deshalb auf demselben Prinzip:

- Es gibt nur wenige Kopien eines Schluessels (oder seiner Bestandteile).
- Diese Kopien verschwinden von selbst oder werden gezielt geloescht.

Die Mathematik entscheidet nur, wie die Bestandteile verteilt werden und wie viele davon
verschwinden muessen, damit der Schluessel nicht mehr rekonstruierbar ist.

Daraus folgt eine harte Grenze: Wer waehrend einer gueltigen Nutzung Schluessel und Daten hat, kann
beides behalten (oder vom angezeigten Bild einen Screenshot machen). Selbstzerstoerung schuetzt nur
Kopien, die ohne den Schluessel gespeichert wurden, z. B. kopierte App-Daten nach Ablauf einer Frist.

Ein eigener Algorithmus aendert daran nichts: Der Code laeuft im Browser und ist fuer jeden lesbar.
Sicherheit kann nur in Geheimnissen liegen, die der Angreifer nicht hat, nie im Verfahren selbst
(Kerckhoffs-Prinzip). Pruefungen im Code ("passt die Zeit nicht, Fehler") entfernt ein veraenderter
Client einfach.

## 2. Verfahren

### 2.1 Geheimnisteilung nach Shamir mit verschwindenden Haltern

**Idee:** Der Schluessel `S` wird in `n` Teile zerlegt. Beliebige `k` Teile ergeben `S` wieder,
`k - 1` Teile verraten nichts.

**Mathematik:** Waehle ein zufaelliges Polynom vom Grad `k - 1` ueber einem endlichen Koerper,

```
f(x) = S + a1*x + a2*x^2 + ... + a(k-1)*x^(k-1)
```

mit `f(0) = S`. Die Teile sind die Punkte `(i, f(i))` fuer `i = 1 ... n`. Aus `k` Punkten ist das
Polynom eindeutig bestimmt (Lagrange-Interpolation), also auch `f(0) = S`. Aus `k - 1` Punkten passt
zu jedem moeglichen Wert von `S` genau ein Polynom: jeder Wert ist gleich wahrscheinlich, die Teile
enthalten keinerlei Information ueber `S` (informationstheoretisch sicher).

**Selbstzerstoerung:** Die Teile liegen bei Haltern, die sie nach einer Frist vergessen (oder nur im
Arbeitsspeicher halten). Sobald weniger als `k` Teile existieren, ist `S` verloren, ohne dass jemand
aktiv loeschen muss.

**Bekanntes Beispiel:** "Vanish" (University of Washington, 2009) legte die Teile in einem grossen
P2P-Netz (DHT) ab. Knoten kommen und gehen, Eintraege laufen ab, nach einigen Stunden war der
Schluessel weg.

**Schwachstelle:** Kurz danach wurde Vanish gebrochen ("Unvanish"): Angreifer setzten viele eigene
Knoten ins Netz, die jeden Teil mitschnitten. Selbstzerstoerung funktioniert nur, wenn die Halter
wirklich vergessen, und das laesst sich in einem offenen Netz nicht erzwingen (Sybil-Angriff).

**Bezug zu OpenGrid:** Der Schwarm (P2P-Kanaele zwischen Nutzern) koennte Teile im Arbeitsspeicher
halten. Es bliebe dasselbe Risiko: Ein veraenderter Client speichert alle Teile, die er sieht.

### 2.2 Hash-Kette (Ratsche)

**Idee:** Schluessel entstehen nacheinander durch eine Einwegfunktion `H` (z. B. HKDF oder SHA-256):

```
k1 = H(k0),  k2 = H(k1),  k3 = H(k2), ...
```

Nach dem Wechsel wird der alte Schluessel geloescht.

**Eigenschaft:** Aus `k2` laesst sich `k1` nicht berechnen (Einwegfunktion). Wird `k2` heute gestohlen,
bleiben gestern verschluesselte Daten sicher: Vorwaertssicherheit (Forward Secrecy), wie bei Signal.

**Grenze:** Zerstoert wird die **Vergangenheit**, nicht die Zukunft. Wer `k1` hat, berechnet alle
spaeteren Schluessel. Fuer "dieser Schluessel soll morgen nicht mehr funktionieren" ist es die falsche
Richtung.

**Umgekehrt (Zeitfreigabe):** Erzeugt man die Kette rueckwaerts (`k(n)` zufaellig,
`k(t-1) = H(k(t))`) und gibt die Schluessel von `k1` an aufsteigend frei, kann der Empfaenger aus dem
aktuellen Schluessel nur aeltere ableiten, nie spaetere. Das steuert, ab wann etwas lesbar wird, nicht
bis wann.

### 2.3 Zeitschloss-Raetsel (Rivest, Shamir, Wagner 1996)

**Idee:** Ein Schluessel, der sich erst **nach** einer bestimmten Zeit oeffnen laesst.

**Mathematik:** Mit `N = p * q` (RSA-Modul) muss der Empfaenger `x^(2^t) mod N` berechnen, also `t`
Quadrierungen nacheinander. Das laesst sich nicht parallelisieren; die Rechenzeit ist die Zeitsperre.
Wer `p` und `q` kennt, kuerzt mit dem Satz von Euler ab (`2^t mod phi(N)`) und erstellt das Raetsel
schnell.

**Grenze:** Liefert "nicht vor", nicht "nicht nach". Fuer Selbstzerstoerung ungeeignet.

### 2.4 Durchstanzbare Verschluesselung (Puncturable Encryption, Green und Miers 2015)

**Idee:** Ein Schluessel bekommt "Loecher": Nach dem Entschluesseln eines bestimmten Chiffrats wird der
Schluessel so veraendert, dass genau dieses Chiffrat nie wieder entschluesselt werden kann, alle
anderen schon.

**Eignung:** Elegant fuer "einmal ansehen". Beruht auf paarungsbasierter Kryptografie (Pairings), ist
rechenaufwendig und in `crypto.subtle` nicht verfuegbar. Ausserdem gilt auch hier: Ein veraenderter
Client kann den Schluessel vor dem Durchstanzen kopieren.

### 2.5 Hardware (Secure Enclave, TPM)

**Idee:** Der Schluessel verlaesst nie einen Chip; der Chip zaehlt die Nutzungen (monotoner Zaehler)
und verweigert nach `n` Nutzungen oder nach einer Frist.

**Eigenschaft:** Der einzige Ort, an dem "nach 3 Ansichten weg" wirklich gilt, auch gegen einen
veraenderten Client, weil der Schluessel fuer Software nicht lesbar ist.

**Grenze:** Nur in nativen Apps erreichbar (in OpenGrid siehe Wrapper-App, Board T4), nicht im
Browser. Ein Screenshot des angezeigten Bilds bleibt moeglich.

## 3. Einordnung fuer OpenGrid

| Verfahren | Zerstoert | Braucht | Gegen veraenderten Client | Im Browser |
|---|---|---|---|---|
| Shamir + vergessende Halter | nach Frist | Netz aus Haltern | nein (Mitschnitt der Teile) | ja |
| Key-Splitting (k = 2, Router vergisst) | nach Frist | Router | nein (Mitschnitt waehrend der Ansicht) | ja |
| Hash-Kette | Vergangenheit | nichts | nein | ja |
| Zeitschloss | nichts (nur "nicht vor") | Rechenzeit | - | ja |
| Durchstanzbare Verschluesselung | einzelne Chiffrate | Pairings | nein | nein (nicht in `crypto.subtle`) |
| Hardware | nach Zaehler/Frist | Chip | ja (Schluessel bleibt im Chip) | nein |

Fazit:

- Echte Selbstzerstoerung heisst: Jemand Vertrauenswuerdiges vergisst (Router, Schwarm oder Chip). Die
  Mathematik legt fest, wie viele vergessen muessen und dass `k - 1` Teile nichts verraten.
- Das in OpenGrid besprochene Key-Splitting (`tasks/feature-request-rotating-encryption.md`,
  Abschnitt 8) ist der einfachste Fall: `k = 2`, Besitzer und Router, der Router vergisst nach der Frist.
  Es schuetzt kopierte App-Daten nach der Frist, nicht gegen Mitschnitt waehrend der Ansicht.
- Shamir ueber den Schwarm waere die dezentrale Variante (kein einzelner Router noetig), mit dem
  Mitschnitt-Risiko wie bei Vanish.
- Gegen absichtliches Behalten waehrend der Ansicht hilft in einer Web-App kein Verfahren; dort setzt
  OpenGrid auf das Spur-Wasserzeichen (Weitergabe nachverfolgbar).

## 4. Quellen

- A. Shamir: How to Share a Secret. Communications of the ACM 22(11), 1979.
- R. Geambasu, T. Kohno, A. Levy, H. Levy: Vanish: Increasing Data Privacy with Self-Destructing Data.
  USENIX Security 2009.
- S. Wolchok et al.: Defeating Vanish with Low-Cost Sybil Attacks Against Large DHTs. NDSS 2010.
- R. Rivest, A. Shamir, D. Wagner: Time-lock Puzzles and Timed-release Crypto. MIT/LCS/TR-684, 1996.
- M. Green, I. Miers: Forward Secure Asynchronous Messaging from Puncturable Encryption. IEEE S&P 2015.
- T. Perrin, M. Marlinspike: The Double Ratchet Algorithm (Signal), 2016.
