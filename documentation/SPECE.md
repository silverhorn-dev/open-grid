# Technical Specification

## 1. Network & Routing Protocol

### 1.1 Routing / Signaling Server
- **Tech Stack:** Node.js / Go / Rust (Websockets) oder Cloudflare Workers (Serverless).
- **Aufgabe:** Handshake-Morphismus für WebRTC (Offer/Answer/ICE Candidate Exchange).
- **Zustand:** Stateless bzgl. Nachrichten. Hält nur volatile Sessions im Memory (PeerID -> Geohash Cell).

### 1.2 P2P Transport Layer
- **Protokoll:** WebRTC `RTCDataChannel` (SCTP-basiert).
- **Topology:** Full Mesh / Star Sub-Networks innerhalb eines Geohashes.

## 2. Cryptography & Security

- **Identity Keypair:** ECDSA (P-256) oder Ed25519 für Identität und Signaturen.
- **Key Exchange:** ECDH (X25519) für Session Key Derivation.
- **Payload Encryption:** AES-GCM (256-Bit) für Nachrichten und Medien-Container.
- **Client Storage:**
  - Web Crypto API zur Schlüsselverwaltung.
  - Speicherung lokaler Fragmente im OPFS (Origin Private File System).

## 3. Data Formats

### 3.1 Profil-Exchange Payload (P2P JSON)
```json
{
  "peerId": "pub_ed25519_abc123...",
  "displayName": "Alex",
  "age": 28,
  "avatarChunk": "data:image/webp;base64,...",
  "ephemeralCaps": ["SNAP_SUPPORT", "OPFS_ENABLED"]
}
```

## 3.2 Ephemeral Image Frame
```JSON
{
  "mediaId": "uuid-v4",
  "ttlViews": 1,
  "payloadEncrypted": "base64_blob...",
  "iv": "base64_iv..."
}
```

## 4. Service Worker & Offline-Update Strategy

### 4.1 Caching- und Offline-Strategie
- **App Shell:** Der HTML/JS/WASM/CSS-Core wird über Cache-First bedient.
- **Dynamic Assets / User Data:** Verbleiben strikt im clientseitigen Speicher (IndexedDB / OPFS), nicht im Service-Worker-Cache.
- **Signaling Reconnection:** Exponential Backoff für WebSocket-Reconnects, um Akku bei Netzverlust zu schonen.

### 4.2 Atomarer Update-Workflow (Staged Swap)

[Network Connected] ??> SW checks manifest.json
?
?
Download Assets into Temp Cache (v_next)
?
?????????????????????????????
?                           ?
[Network Fail / Drop]       [100% Downloaded]
?                           ?
Purge Temp Cache            Validate Hashes
?                           ?
Remain on v_current                ?
Send Message to UI:
"UPDATE_READY"
?
?????????????????????????????????????????????
?                                           ?
User clicks "Reload"                       App Launch / SW Idle
?                                           ?
?????????????????????????????????????????????
?
Post SKIP_WAITING
?
?
Swap v_next -> v_current

1. **Detection:** Der Service Worker prüft bei bestehender Verbindung periodisch das Manifest auf neue Content-Hashes.
2. **Atomic Background Fetch:** 
   - Downloads werden ausschließlich durchgeführt, wenn `navigator.onLine` wahr ist.
   - Alle Versionen-Assets werden isoliert unter einem eindeutigen Cache-Namen geladen (`app-shell-v2.1.0-temp`).
3. **Rollback-Safety:** bricht die Verbindung während des Downloads ab, wird der temporäre Cache verworfen. Die aktiven Nutzer-Sessions bleiben unberührt auf der alten Version.
4. **Controlled Swap:**
   - Sobald das Asset-Manifest zu 100 % geladen ist, sendet der Service Worker ein `POST_MESSAGE` event (`{ type: 'SW_UPDATE_READY' }`) an den Client.
   - Die Aktivierung erfolgt **nicht automatisch mitten in einer laufenden WebRTC-Session**, sondern erst nach Bestätigung oder beim nächsten Kaltstart via `self.skipWaiting()` und `clients.claim()`.