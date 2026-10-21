# Technische Spezifikation

## 0. Komponentenstruktur

- `worker.js` ist der HTTP-Entry-Point und enthaelt keine Grid- oder
  Signaling-Persistenzlogik.
- `server/grid-store.js` kapselt Cloudflare KV und den lokalen
  In-Memory-Fallback fuer die Grid-Registrierung.
- `server/signaling.js` kapselt das lokale WebSocket-Relay und das globale
  Durable Object `SignalingHub`.
- `client/grid.client.js` kapselt Discovery, Heartbeats, Grid-Darstellung und
  die Verbindung zum Signaling-Relay.
- `client/p2p.client.js` kapselt WebRTC, DataChannels, ECDH/AES-GCM und das
  verschluesselte Nachrichtenprotokoll.
- `index.html` enthaelt App-Shell, UI-Interaktionen und lokale
  IndexedDB-Funktionen.

## 1. Identitaet

- Beim ersten Start erzeugt der Client eine UUID-basierte `nodeId`.
- Die `nodeId` liegt in `localStorage` und bleibt bis zum Loeschen der
  Websitedaten stabil.
- Alle Tabs derselben Browser-Installation verwenden dieselbe `nodeId`.
- Jede Laufzeit erzeugt zusaetzlich eine ephemere `registrationId`.
- Private kryptografische Schluessel verlassen den Client nicht.

## 2. Routing und Grid

### 2.1 KV-Daten

Ein Grid-Eintrag enthaelt nur:

```json
{
  "name": "Alex",
  "thumbnail": "data:image/webp;base64,..."
}
```

Peer-ID und Geohash ergeben sich aus dem KV-Key. Registrierungsmetadaten liegen
in separaten kurzlebigen Keys. Der Client erneuert seinen Eintrag regelmaessig;
ohne Heartbeat laeuft er automatisch ab.

### 2.2 Grid-Regeln

- Das Grid ist immer die aktuelle Router-Antwort fuer genau einen Geohash.
- Lokale Cache-Eintraege werden niemals ohne Router-Eintrag ins Grid gemischt.
- Eine explizite Abmeldung entfernt den Router-Eintrag unmittelbar.
- Vollstaendige Profildaten werden nicht vom Router ausgeliefert.

## 3. WebRTC und Presence

Das Durable Object `SignalingHub` vermittelt:

- SDP Offer und Answer
- ICE Candidates
- Offline-Fallback-Meldungen

Nach Aufbau des DataChannels tauschen beide Clients oeffentliche ECDH-P-256-
Schluessel aus und leiten einen AES-256-GCM-Session-Key ab.

Beim Oeffnen eines Profils sendet der Client einen verschluesselten
`PRESENCE_PING`. Der Zielclient antwortet mit `PRESENCE_PONG`.

| Status | Berechnung auf dem aufrufenden Client |
|---|---|
| Online | Passender Pong innerhalb von 8 Sekunden |
| Abwesend | Router-Eintrag vorhanden, aber kein Pong |
| Offline | Eigene Netzwerk- oder Signaling-Verbindung fehlt |

## 4. Profilprotokoll

Der verschluesselte `PROFILE_RESPONSE` enthaelt:

```json
{
  "id": "node_uuid",
  "avatar": "data:image/webp;base64,...",
  "fields": {
    "displayName": "Alex",
    "age": 28
  },
  "version": 4,
  "updatedAt": 1792584000000
}
```

- `version` wird bei jeder lokalen Profilspeicherung erhoeht.
- `updatedAt` dokumentiert den Aktualisierungszeitpunkt.
- Eine empfangene Version ersetzt den Cache nur, wenn sie neuer ist.

## 5. Lokale Verschluesselung

IndexedDB Version 3 enthaelt:

| Store | Inhalt |
|---|---|
| `keys` | nicht exportierbarer AES-GCM-Schluessel fuer Profil-Caches |
| `profiles` | Metadaten sowie AES-GCM-IV und Ciphertext |
| `messages` | lokaler Chatverlauf pro Peer |
| `gridPeers` | minimale lokale Routing-Metadaten, nicht fuer Grid-Sichtbarkeit |

Profilfelder und Avatar werden als gemeinsamer JSON-Payload mit AES-256-GCM
verschluesselt. In IndexedDB bleiben nur Peer-ID, Version, Zeitstempel, IV und
Ciphertext im Klartext. Das Loeschen der Websitedaten entfernt Identitaet,
Schluessel und Cache gemeinsam.

## 6. Sicherheitsgrenzen

- Der Router kennt keine vollstaendigen Profile und keine Chats.
- Signaling-Nachrichten enthalten nur Verbindungsaufbau-Daten.
- P2P-Nutzdaten sind AES-GCM-verschluesselt.
- Der lokale Profil-Cache ist at-rest verschluesselt.
- Der aktuelle Chat-Store ist lokal persistent; seine separate
  At-rest-Verschluesselung ist nicht Bestandteil dieser Profil-Cache-Aenderung.
