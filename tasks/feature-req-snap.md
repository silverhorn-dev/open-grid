# Feature Request: Immersive Kamera-Ansicht & SC-Erweiterungen

> hier ist vermutlich schon vorarbeit getan. die kamera gui funkt schon soweit 
> prüfe hier vorher ob sachen bereits umgesetzt oder ähnlich umgesetzt wurden oder hinfällig sindf

## ? Beschreibung
Die aktuelle Snap-Funktion soll zu einer vollwertigen, immersiven Full-Screen-Kamera-Experience ausgebaut werden, die stark an SC angelehnt ist. Nutzer sollen Medien nicht nur aufnehmen, sondern vor dem verschlüsselten Versand bearbeiten, personalisieren und mit View-Once-Timern versehen können.

## ? Kernfunktionen (SC-Features)
- **Vollbild-Kamera UI:** Die Kamera öffnet sich nahtlos im Vollbildmodus (ohne klobige Modal-Ränder), mit Gestensteuerung (Swipe down to close).
- **Kamera-Controls:** Toggle zwischen Front- und Back-Kamera, Blitz-Steuerung (sofern von der MediaDevices API unterstützt).
- **Editing & Overlays:**
  - **Text-Werkzeug:** Text über das Bild legen (verschiedene Farben/Größen).
  - **Zeichen-Werkzeug:** Mit dem Finger frei auf dem Bild zeichnen (Canvas-basiert).
  - **Emojis/Sticker:** Platzierung von nativen Emojis als Layer.
- **View-Once Timer (Ephemerality):** Vor dem Absenden kann ein Timer eingestellt werden (z. B. 1 bis 10 Sekunden oder unendlich). Dieser Timer ist zwingend an die bereits geplante kryptografische "Zeroing"-Funktion gebunden.

## ? Technische Umsetzung
- **MediaStream API:** Nutzung von `navigator.mediaDevices.getUserMedia` mit optimierten Constraints für mobile Endgeräte (aspectRatio, facingMode).
- **Canvas Rendering:** Sämtliche Overlays (Text, Zeichnungen) werden vor dem Versand per `canvas.getContext('2d')` direkt in das finale JPEG gerendert ("Flattening"), sodass beim Empfänger keine zusätzlichen Metadaten geparst werden müssen.
- **Payload-Struktur:** Der `CHAT_OPERATION`-Payload für Snaps wird um die Eigenschaft `viewOnceTimer: number` erweitert. (vermutlich schon umgesetzt)
- **Performance:** Die Bildkompression (bereits in `compressImage` implementiert) greift unmittelbar nach dem Flattening des Canvas. ? 

## ? Akzeptanzkriterien
- [ ] Kamera-UI nimmt den gesamten Viewport des mobilen Geräts ein.
- [ ] Nutzer kann zwischen Front- und Back-Kamera wechseln.
- [ ] Nutzer kann freihändig auf dem Bild zeichnen und Text tippen.
- [ ] Das modifizierte Bild wird als *ein* einzelner komprimierter Base64-String generiert.
- [ ] Timer-Einstellung wird im verschlüsselten E2EE-Payload an den Empfänger übermittelt.