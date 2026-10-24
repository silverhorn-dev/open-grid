# Feature Request: Erweitertes Status-System & Adding-Mechanik (Chat- & Freunde-Modus)

> gleiches spiel der modus ist bereits impementiert aber der status noch niccht und die matching bzw flame function sollte etwas umgedichtet bzw umbenannt werden wenn man sich im chat modus befinden. Wie ist die Trennung der chatpartnern und den grid partnern? evtl kann man hier noch ein event profil zum chat einladen? oder macht es sinn chats übergreifend zu teilen bzw grid getrennt von chats, friends, event zu halten, da würde ich verstehen, dass event mit zu den chats gehört? wobei ein event auch LGBTQ+ bzw dating mäßig sein kann? die frage ist hier noch offen.

## ? Beschreibung
OpenGrid nutzt nun vier dedizierte Nutzungs-Modi: **Grid** (Dating), **Chat**, **Freunde** (Grid zeigt nur Chatpartner/Freunde) und **Event** (lokaler/Hash-basierter Grid). 
Um die Bindung zwischen Nutzern zu stärken, ohne den offenen Discovery-Aspekt (Grid/Event) zu stören, wird ein ephemeres Status-System (ähnlich SC/WhatsApp Stories) eingeführt. Dieses ist strikt an die Modi **Chat** und **Freunde** sowie an eine neue **Adding-Mechanik** gebunden.

## ? Kernfunktionen
- **Die "Adding"-Mechanik:** Der bisherige "Match"-Gedanke wird durch "Adden" ersetzt. Fügt man einen Peer hinzu (Add), schaltet man für diesen erweiterte Profilinfos frei und berechtigt ihn, die eigenen Status-Updates zu empfangen.
- **Modus-spezifische Sichtbarkeit:**
  - *Grid / Event:* Reine Discovery. Kein Status-Feed sichtbar, Standard-Profilinfos.
  - *Chat / Freunde:* Der Status-Feed (horizontal scrollbare Leiste) wird eingeblendet. Im Modus "Freunde" fungiert das Grid zusätzlich als reines Adressbuch (zeigt nur geaddete Chatpartner).
- **Status-Inhalte & Ephemerality:** Ein Status kann ein Foto (via neuer Kamera-UI) oder Text sein und hat eine harte Lebensdauer von 24 Stunden (24h TTL). Danach wird er lokal unwiderruflich gelöscht.
- **Rich Presence:** Ein kurzer Text-Status (z. B. "Im Club", "Auf der Suche...") wird neben dem Online-Badge nur für geaddete Peers angezeigt.

## ? Technische Umsetzung
- **State Management (Modi):** Erweiterung des globalen States um `currentAppMode` (Grid, Chat, Freunde, Event). Das UI-Rendering (Status-Leiste, Grid-Filterung) reagiert dynamisch auf diesen State.
- **Verteilungslogik (P2P Broadcast):** Wenn ein User einen Status postet, filtert der Client die lokale `state.chatControls` nach Peers mit dem Flag `added: true`. Der Status wird per verschlüsseltem `sendSecurePayload` (DataChannel oder Path C) *ausschließlich* an diese spezifischen Public Keys gepusht.
- **Erweiterte Profil-Sichtbarkeit:** Die `PROFILE_RESPONSE` wertet aus, ob der anfragende `peerId` in der eigenen Add-Liste steht. Wenn ja, wird der volle Payload signiert; wenn nein, nur die öffentliche Basis-Version (Stufe 1).
- **Datenbankschema & Garbage Collection:** Neue IndexedDB-Tabelle `statusUpdates` (`id, peerId, payload, expiresAt`). Ein Background-Intervall (z.B. alle 15 Min) löscht abgelaufene Einträge (Zeroing).

## ? Akzeptanzkriterien
- [ ] UI besitzt einen Toggle/Navigation für die 4 Modi (Grid, Chat, Freunde, Event).
- [ ] Status-Feed wird ausschließlich in den Modi "Chat" und "Freunde" gerendert.
- [ ] Das Grid im Modus "Freunde" filtert alle Peers heraus, die nicht in der lokalen Add-Liste/Chat-Historie stehen.
- [ ] "Add"-Button im Profil schaltet erweiterte Felder für den jeweiligen Peer frei (via E2EE Payload/Sync).
- [ ] Neue Status-Updates werden kryptografisch sicher nur an geaddete Peers verteilt.
- [ ] Status-Medien verschwinden nach exakt 24 Stunden restlos aus der IndexedDB.