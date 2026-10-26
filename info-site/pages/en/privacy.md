# Privacy & security

## What stays on your device

Your full profile, chats, photos, albums and keys are stored ${term.inBrowserStorage}. They only leave your device ${term.p2p} and only ${term.encrypted}.

## What the server sees

The ${term.server} only helps devices find each other (${term.signaling}). It knows:

- your random ID, display name and a small preview picture for the grid,
- your location only as ${term.aCell} – never exact coordinates,
- when you were last online (for grid visibility).

It does **not** see message contents, photos or your full profile. Its logs contain neither IP addresses nor locations.

## When the other person is offline

Your message then waits in the ${term.cache} – as ciphertext only the other person can decrypt. It is deleted after delivery, at the latest after three days. Videos and large original images never take this route. Under **${ui:common.settings} → ${ui:settings.privacy} → ${ui:settings.cloudCache}** you can turn this off for your messages.

## When devices can't reach each other directly

Some networks (office, hotel, mobile) block direct connections. Then a ${term.turn} forwards the already encrypted data – it cannot read it.

## Images and screenshots

Screenshots can't be prevented in a browser. That's why your snaps and album images carry ${term.aWatermark} (**${ui:settings.traceWatermark}**): if an image shows up somewhere, it can be traced to whom it was sent.

## What you can do yourself

- Use **${ui:settings.silentMode}** or **${ui:settings.safeZones}** when you don't want to be seen.
- Keep notifications compact (**${ui:settings.compactNotification}**) so no names show on the lock screen.
- Delete a chat or block a person – this also applies to messages still waiting on the server.
