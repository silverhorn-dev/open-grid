# Privatsphäre & Sicherheit

## Was auf deinem Gerät bleibt

Dein vollständiges Profil, deine Chats, Fotos, Alben und deine Schlüssel liegen ${term.inBrowserStorage}. Sie verlassen dein Gerät nur ${term.p2p} und nur ${term.encrypted}.

## Was der Server sieht

Der ${term.server} hilft Geräten nur, sich zu finden (${term.signaling}). Er kennt:

- deine zufällige ID, deinen Anzeigenamen und ein kleines Vorschaubild für das Grid,
- deinen Ort nur als ${term.aCell} – nie genaue Koordinaten,
- wann du zuletzt online warst (für die Sichtbarkeit im Grid).

Er sieht **keine** Nachrichteninhalte, keine Fotos und kein volles Profil. Seine Protokolle enthalten weder IP-Adressen noch Orte.

## Wenn die andere Person offline ist

Dann landet deine Nachricht im ${term.cache} – als Geheimtext, den nur die andere Person entschlüsseln kann. Sie wird nach der Zustellung gelöscht, spätestens nach drei Tagen. Videos und große Originalbilder gehen nie diesen Weg. Unter **${ui:common.settings} → ${ui:settings.privacy} → ${ui:settings.cloudCache}** kannst du das für deine Nachrichten abschalten.

## Wenn Geräte sich nicht direkt erreichen

Manche Netze (Firma, Hotel, Mobilfunk) verhindern direkte Verbindungen. Dann leitet ein ${term.turn} die bereits verschlüsselten Daten weiter – lesen kann er sie nicht.

## Bilder und Screenshots

Screenshots lassen sich im Browser nicht verhindern. Deshalb tragen deine Snaps und Albumbilder ${term.aWatermark} (**${ui:settings.traceWatermark}**): Taucht ein Bild irgendwo auf, lässt sich zuordnen, an wen es ging.

## Was du selbst tun kannst

- Nutze **${ui:settings.silentMode}** oder **${ui:settings.safeZones}**, wenn du nicht gesehen werden willst.
- Lass die Benachrichtigungen kompakt (**${ui:settings.compactNotification}**), dann stehen keine Namen auf dem Sperrbildschirm.
- Lösche einen Chat oder blockiere eine Person – das gilt auch für Nachrichten, die noch auf dem Server warten.
