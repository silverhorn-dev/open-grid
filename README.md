# OpenGrid (Arbeitstitel)

Eine kostenlose, datenschutzkonforme und dezentrale LGBTQ+ Discovery Platform.

## Core Philosophy

- **Zero Infrastructure Cost:** Keine zentralen Server für Medienspeicher oder Nachrichtendatenbanken.
- **Client-Driven Architecture:** Das Endgerät des Nutzers ist Datenhalter und Mini-Server zugleich.
- **Absolute Privacy:** Ende-zu-Ende-Verschlüsselung (E2EE) für Texte und Medien. Ephemerale Medien (Snap-Prinzip) verfallen clientseitig.

## High-Level Architecture
+-------------------------------------------------------+
|                   Signaling Server                    |
|       (Geohash / Routing / STUN Peer Exchange)        |
+--------------------------+----------------------------+
| WebSockets / WebRTC Handshake
+---------------+---------------+
|                               |
+------v------+                 +------v------+
|  Client A   |<=== WebRTC ====>|  Client B   |
| (Peer/Node) |   P2P Data      | (Peer/Node) |
+-------------+   Channels      +-------------+

## Quickstart

1. Client laden (PWA via Browser).
2. Ephemeres Schlüsselpaar lokal generieren (Web Crypto API).
3. Standort freigeben (oder virtuellen Geohash setzen).
4. Peers in der Nähe direkt via WebRTC abfragen.

## Key Architecture Highlights

- **Zero Infrastructure Cost:** Keine zentralen Server für Medienspeicher oder Datenbanken.
- **Client-Driven Architecture:** Das Endgerät ist Datenhalter und Mini-Server zugleich.
- **Absolute Privacy:** Ende-zu-Ende-Verschlüsselung (E2EE) für Texte und Medien.
- **Offline-First & Resilient PWA:**
  - Volle Lauffähigkeit ohne Internetverbindung (Lesezugriff auf Kontakte, Verläufe, eigenes Profil).
  - Atomares Update-System: Downloads erfolgen im Hintergrund bei stabiler Verbindung. Aktivierung erst nach 100% erfolgreichem Caching.