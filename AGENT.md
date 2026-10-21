# AI Agent & Contributor Guidelines

## System Constraints & Rules

1. **Zero External Data Services:**
   - Erzeuge NIEMALS Code, der Profilbilder, Chats oder Standorte auf externe S3-Buckets, Firebase oder Datenbanken hochlädt.
   - Alle persistenten Daten verbleiben auf dem Client (IndexedDB/OPFS).

2. **WebRTC First:**
   - Implementierungen müssen immer primär auf P2P-Übertragung setzen.
   - Server-Sockets dienen AUSSCHLIESSLICH als Signaling Relay.

3. **Security Standards:**
   - Nutze für alle kryptografischen Operationen die native `window.crypto.subtle` API.
   - Keine unverschlüsselten Text- oder Medienpakete über das Netzwerk senden.

4. **Web Standard Target:**
   - Die Zielanwendung wird als Progressive Web App (PWA) entwickelt, um App-Store-Restriktionen und Gebühren zu umgehen.

5. **Offline & Service Worker Integrity:**
   - Ändere niemals den Service Worker so, dass `skipWaiting()` automatisch beim ersten Ankommen eines neuen Workers aufgerufen wird (Gefahr von Session-Abbrüchen).
   - Alle Netzwerkanfragen müssen Graceful Failovers auf die lokale `IndexedDB` besitzen.
   - Assets müssen vor der Aktivierung eines neuen Service Workers zwingend vollständig validiert im Staging-Cache liegen.