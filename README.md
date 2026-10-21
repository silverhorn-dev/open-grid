# OpenGrid

OpenGrid ist eine datenschutzorientierte, dezentrale Discovery- und Chat-PWA.
Der Cloudflare Worker dient nur als Geohash-Router und WebRTC-Signaling-Relay.
Vollstaendige Profile und Nachrichten werden direkt zwischen Clients ueber
verschluesselte WebRTC DataChannels uebertragen.

## Architektur

- **Routing:** In Cloudflare KV stehen pro sichtbarem Peer nur Anzeigename und
  Thumbnail. Ein Eintrag wird durch einen regelmaessigen Client-Heartbeat
  verlaengert und laeuft ohne Heartbeat automatisch ab.
- **Signaling:** Ein Cloudflare Durable Object vermittelt WebRTC Offer, Answer
  und ICE Candidates. Es speichert keine Chats oder Profile.
- **P2P:** Clients handeln per ECDH P-256 einen AES-256-GCM-Session-Key aus.
  Profilantworten, Presence-Pings und Chats laufen verschluesselt ueber den
  DataChannel.
- **Lokaler Speicher:** Profile und Chats liegen in IndexedDB. Profilinhalte
  werden vor dem Speichern mit einem nicht exportierbaren AES-GCM-Schluessel
  verschluesselt.

### Komponenten

| Datei | Verantwortung |
|---|---|
| `worker.js` | HTTP-Routen, App-Shell und Auslieferung der Client-Module |
| `server/grid-store.js` | Grid-Registrierung, KV-Zugriff, TTL und lokale Entwicklungsablage |
| `server/signaling.js` | WebSocket-Relay und Durable Object `SignalingHub` |
| `client/grid.client.js` | Grid-Abfrage, Darstellung, Registrierung und Signaling-Verbindung |
| `client/p2p.client.js` | WebRTC-Verbindung, ECDH/AES-GCM und sichere P2P-Nachrichten |
| `index.html` | UI, Profil-/Chat-Interaktionen und lokaler IndexedDB-Speicher |

Der Signaling-Server vermittelt nur Offer, Answer und ICE Candidates.
`client/p2p.client.js` baut daraus den direkten DataChannel zwischen zwei
Browsern auf. Grid-Discovery und P2P-Datentransport bleiben dadurch getrennte
Subsysteme.

## Identitaet

Jede Browser-Installation erzeugt einmalig eine zufaellige `nodeId`. Sie wird
in `localStorage` gespeichert, von allen Tabs derselben Website geteilt und
bleibt bis zum manuellen Loeschen der Websitedaten erhalten. Eine separate
`registrationId` schuetzt jede laufende Registrierung gegen verspätete
Abmeldeereignisse.

## Discovery und Presence

Das Grid zeigt ausschliesslich Profile, die der Router fuer den aktuellen
Geohash liefert. Ein lokal gecachtes Profil erscheint nicht automatisch im
Grid, wenn sein Router-Eintrag fehlt.

Der Presence-Status wird nicht aus KV uebernommen. Beim Oeffnen eines Profils
sendet der aufrufende Client einen verschluesselten P2P-Ping:

- **Online:** gueltiger P2P-Pong empfangen
- **Abwesend:** Router-Eintrag vorhanden, aber kein Pong innerhalb des Timeouts
- **Offline:** der aufrufende Client hat selbst keine nutzbare Netzwerk- oder
  Signaling-Verbindung

## Profil-Cache

Vollstaendige Profile werden nur per P2P geladen. Jede Profilversion besitzt
eine fortlaufende `version` und einen `updatedAt`-Zeitstempel. Ein Client
ueberschreibt seinen verschluesselten lokalen Cache nur mit einer neueren
Version. Der Cache kann nach einem Browser-Neustart wieder entschluesselt
werden, erscheint aber nur dann im Grid, wenn der Peer weiterhin vom Router
geliefert wird.

## Entwicklung

```powershell
npx.cmd wrangler dev
```

Deployment-Konfiguration pruefen:

```powershell
npx.cmd wrangler deploy --dry-run
```
