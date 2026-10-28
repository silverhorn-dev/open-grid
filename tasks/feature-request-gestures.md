# Feature Request: Touch Gestures (Mobile)

Status: first round implemented 2026-10-23 (`client/app/gestures.js`).

Decided 2026-10-23:

- In: G1 swipe to reply, G2 long press, G3 double tap ❤️, G7 swipe between
  tabs, G8/G9 swipe down to close the profile and media windows, "Kopieren"
  as an action button.
- Out: G4 edge swipe (the OS back gesture already does this, and chats have
  real routes), G6 pull to refresh on the grid (clashes with the browser's
  own pull to refresh), G5 swipe on chat rows.
- 2026-10-24: G10/G11 camera gestures are in after all (plus swipe down to
  close and pinch zoom), built with the full-screen camera (board R5).
- 2026-10-24: unit tests for direction lock, thresholds, long press and
  double tap in `test/gestures.test.js`.
- New: in an open chat, pull **up** at the end of the messages to refresh
  (fetch Path C queue, reconnect P2P, chat sync).

OpenGrid is used mostly on smartphones as an installed PWA. Smartphones have no
hover, so every action currently needs a visible button (e.g. the chevron next
to a chat message). Native chat apps rely on gestures instead. This document
specifies which gestures to add, how they behave, and how they must coexist
with scrolling, the browser's own gestures and accessibility.

---

## 1. Goals

- Common actions reachable with one gesture, without hunting for small buttons.
- Gestures never break vertical scrolling or the system back gesture.
- Every gesture has a visible, tappable alternative (buttons stay).
- Same feel as WhatsApp / Signal / Snapchat where users already know the pattern.

## 2. Gestures

Priority: **P1** = first iteration, **P2** = later, **P3** = nice to have.

| # | Where | Gesture | Action | Priority |
|---|---|---|---|---|
| G1 | Chat message | Swipe right (partner) / left (own) | Reply to this message (opens reply bar) | P1 |
| G2 | Chat message | Long press (~450 ms) | Open the action bar (reply, react, star, delete) + haptic tick | P1 |
| G3 | Chat message | Double tap | React with ❤️ (toggle) | P2 |
| G4 | Open chat (mobile) | Swipe right from the left edge | Back to the chat list (same as the back button) | P1 |
| G5 | Chat list | Swipe left on a chat | Reveal "Löschen" / "Blockieren" buttons | P2 |
| G6 | Grid | Pull down at the top | Refresh the grid (same as "Aktualisieren") | P2 |
| G7 | Main tabs (mobile) | Horizontal swipe on empty area | Switch Grid ↔ Chat ↔ Profil | P3 |
| G8 | Profile modal | Swipe down | Close the modal | P2 |
| G9 | Media modal (bottom sheet) | Swipe down on the header | Close the sheet | P2 |
| G10 | Snap camera | Swipe up anywhere on the camera image or on the shutter area | Open the gallery picker (done R5, whole image 2026-10-27) | P3 |
| G11 | Snap camera | Double tap the preview | Switch front/rear camera (done R5) | P3 |
| G12 | Chat header (contact bar) | Pull down | Open the contact's profile (done 2026-10-26) | P2 |

2026-10-26: G1 now starts anywhere in the message row (also the empty space next
to the bubble and on the small actions arrow, which no longer swallowed the
swipe); pointer capture keeps the gesture when the layout shifts.

Already implemented (image viewer, 2026-10-23): swipe left/right to page,
pinch / double tap / wheel zoom, drag to pan, swipe down to close.

## 3. Behaviour details

### G1 Swipe to reply

- The bubble follows the finger horizontally, max ~72 px, with a reply icon
  fading in behind it.
- Release past ~56 px → start reply + light haptic (`navigator.vibrate(10)`
  where available), bubble springs back (200 ms ease-out).
- Only the direction pointing away from the screen edge counts: partner
  messages swipe right, own messages swipe left.
- Not on deleted messages.

### G2 Long press

- 450 ms without moving more than 8 px; cancelled by scroll or any move.
- Opens the same action bar as the chevron; the chevron stays as fallback.
- Must not trigger the browser's text selection / context menu on the bubble
  (`user-select: none`, `-webkit-touch-callout: none` on bubbles only;
  text inside stays copyable via a "Kopieren" action).

### G4 Edge swipe back

- Starts within 24 px of the left edge, horizontal intent.
- iOS Safari / installed PWA already has a system edge-back gesture that
  triggers `history.back()`; since chats have real routes (`/chat/<id>`),
  that already works there. Our own edge swipe is mainly for Android /
  in-app where the system gesture is not mapped to history. Detect and skip
  where the platform already handles it to avoid a double back.

### G5 Swipe on chat list

- Row slides left up to the width of the revealed buttons (~140 px), snaps
  open past half, closes on tap elsewhere or when another row opens.
- Destructive actions still ask for confirmation (existing dialogs).

### G6 Pull to refresh

- Only when the grid is scrolled to the top. Shows a spinner that rotates with
  the pull distance; release past ~70 px triggers `refreshGrid()`.
- Must not conflict with the browser's own pull-to-refresh: set
  `overscroll-behavior-y: contain` on the scroll container.

## 4. Technical approach

- One small gesture helper (`client/app/gestures.js`) on Pointer Events
  (`pointerdown/move/up/cancel`), shared by all gestures:
  - direction lock after the first ~8 px (horizontal vs vertical), so
    vertical scrolling stays native,
  - `touch-action: pan-y` on horizontally swipeable elements (messages,
    chat rows) and `touch-action: none` only where needed (viewer, camera),
  - velocity tracking for flick detection,
  - all style updates batched in `requestAnimationFrame` (lesson from the
    viewer: per-event style writes and layout reads stutter).
- Event delegation on the message list container instead of listeners per
  bubble (the list is re-rendered often).
- Animations only via `transform`/`opacity`.
- Respect `prefers-reduced-motion`: snap without animation.
- Haptics via `navigator.vibrate` where supported (not on iOS), silently
  ignored elsewhere.

## 5. Accessibility

- No action is gesture-only: buttons (chevron, back, refresh, delete) remain.
- Screen readers: gestures are not announced; the action bar is reachable via
  the chevron button with `aria-label`.

## 6. Acceptance criteria

- G1, G2 and G4 work on Android Chrome and iOS Safari (installed PWA and
  browser tab) without breaking vertical scrolling in the chat.
- No double navigation when the system back gesture exists.
- Animations run at 60 fps on a mid-range phone (no layout reads during move).
- Every gesture has a button alternative.
- Spec (`documentation/SPECE.md`) and use cases updated; gesture helper
  covered by unit tests for direction lock and thresholds.

## 7. Open questions

1. G7 (swipe between tabs): wanted at all? It can conflict with horizontal
   scrolling areas (gallery strip in the profile).
2. G3 double tap ❤️: OK that it collides with nothing else on bubbles
   (images open the viewer on single tap)?
3. Should long press also offer "Kopieren" (copy text)?

## Nachtrag 2026-10-28 (Nutzer)

- Im Profil-Tab nach links wischen = Menue oeffnen (statt zu den Einstellungen).
- In den Einstellungen seitlich wischen = Bereiche blaettern, Ausnahmen fuer Regler
  (und Eingabefelder/Schalter).
- Einstellungen verlassen: nur nach unten wischen (oben im Fenster), zurueck ins Profil.
- Umgesetzt 2026-10-28, E2E `mobile-layout`.

