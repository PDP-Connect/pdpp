# Mobile Clipboard Plan For Streamed Browser Control

Status: decided-promote
Owner: Codex
Created: 2026-05-07
Updated: 2026-05-07
Related: OpenSpec change `add-run-interaction-streaming-companion`

## Question

How should PDPP make clipboard transfer feel polished on phone-based streamed
browser control without pretending the mobile web platform allows reliable
silent bidirectional clipboard sync?

## Context

The n.eko-backed stream now gives the owner an interactive browser surface, but
the clipboard paths are still mixed together:

- Desktop paste can ride native `paste` events and n.eko `control.paste`.
- Mobile paste may not expose `navigator.clipboard.readText()` reliably.
- Remote copy events can arrive over SSE after the user gesture has expired, so
  immediate `navigator.clipboard.writeText()` is not reliable on mobile.
- n.eko's overlay textarea is needed for typing and keyboard focus, but a hidden
  full-surface textarea is not enough to make native mobile paste menus reliable.
- `remote-browser-sandbox` proved the useful `paste_text` / `Input.insertText`
  pattern, but its own mobile test notes still show that long-press edit actions
  appeared visually while copy/cut/paste often did not function.

The 2026 platform picture does not remove this constraint. The W3C Clipboard API
spec explicitly lists remote clipboard synchronization as a use case, but
clipboard reads and writes remain permission, focus, secure-context, and
user-activation gated. MDN browser-compat data currently shows
`ClipboardChangeEvent` as standard-track but experimental, with Chrome support
starting at 144 and no Safari or Firefox support. That makes it useful future
prior art, not a shippable SLVP dependency.

Primary sources reviewed:

- W3C Clipboard API, including remote clipboard synchronization and security:
  https://www.w3.org/TR/clipboard-apis/
- MDN Clipboard API security considerations:
  https://developer.mozilla.org/en-US/docs/Web/API/Clipboard_API
- MDN ClipboardChangeEvent compatibility:
  https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/clipboardchange_event
- WebKit Async Clipboard API and user-gesture model:
  https://webkit.org/blog/10855/async-clipboard-api/
- web.dev Async Clipboard API:
  https://web.dev/articles/async-clipboard
- Apache Guacamole user guide:
  https://guacamole.apache.org/doc/gug/using-guacamole.html
- n.eko FAQ and release notes:
  https://neko.m1k1o.net/docs/v3/faq
  https://neko.m1k1o.net/docs/v3/release-notes
- noVNC API:
  https://novnc.com/noVNC/docs/API.html

## Stakes

Clipboard is part of the owner-in-control promise. For real connectors, the
owner may need to paste credentials, one-time codes, recovery text, or copy
visible confirmation data back out. A broken button is worse than no button
because it trains the owner not to trust the streamed session.

The SLVP bar is:

- The owner understands which direction data is moving.
- The owner can paste text from a phone into the remote browser without needing
  keyboard shortcuts.
- The owner can copy remote text back to the phone when the platform permits it,
  and can still recover the text manually when it does not.
- Clipboard content is never logged, never durably stored, and never copied
  between environments without an owner gesture.
- The strict/Patchright-sensitive mode does not require page-level scripts or
  mid-page fingerprint mutations.

## Current Leaning

Build clipboard as an explicit owner-controlled bridge, not as ambient sync.

### Product Model

Use three tiers:

1. Seamless path: desktop and capable mobile browsers use native paste events,
   `clipboardData`, `navigator.clipboard.writeText()`, and n.eko `control.paste`
   where those operations happen directly inside an owner gesture.
2. Assisted path: a mobile Clipboard Sheet provides a visible, native editable
   field for host-to-remote paste and a user-tapped Copy to Device action for
   remote-to-host copy.
3. Manual fallback: if the Clipboard API fails, the sheet keeps a selectable
   text area so the owner can use the OS paste/copy menu directly.

Do not show separate raw Copy and Paste toolbar buttons on mobile. Show Keyboard
as the primary control and a single Clipboard control only when the sheet exists.
Until the sheet exists, hide mobile copy/paste buttons because they currently
advertise more reliability than the platform provides.

### Host To Remote Paste

Desktop:

- Preserve native `paste` event handling and `clipboardData.getData("text")`.
- Forward bulk text through n.eko `control.paste(text)` first.
- Use CDP `Input.insertText` only as an assistive fallback outside strict mode.

Mobile:

- The Clipboard Sheet contains a visible "Paste here" field that the OS can
  target with its native paste menu.
- A "Paste from device" action may call `navigator.clipboard.readText()` only
  immediately inside the tap handler.
- If the read fails or returns no text, focus the visible field and explain the
  native fallback: paste into the field, then tap "Send to browser".
- "Send to browser" forwards the text through n.eko `control.paste(text)`.
- The field clears after send, session end, or stream detach.
- If the focused remote element is known to be password-like, mask the local
  preview by default and require an explicit reveal action.

### Remote To Host Copy

Desktop:

- Preserve native n.eko copy behavior when it works.
- When the reference emits a `clipboard` SSE event, attempt
  `navigator.clipboard.writeText(text)` as best-effort.

Mobile:

- Do not rely on writing inside the SSE event handler; it is not tied to a
  current owner activation.
- Buffer only an ephemeral remote clipboard value in viewer memory.
- Show a toast/sheet state: "Copied in browser. Tap to copy to this device."
- On that tap, call `navigator.clipboard.writeText(text)` immediately.
- If write fails, show a selectable text area with the copied text and native OS
  instructions. Clear it on close/session end.

### Capability And Policy Model

Probe and record non-sensitive capabilities at session attach:

- `isSecureContext`
- top-level vs embedded context, plus iframe `allow` if applicable
- `navigator.clipboard.readText` / `writeText` availability
- Permissions API results for `clipboard-read` and `clipboard-write` when
  supported
- `ClipboardItem.supports` availability for future rich clipboard work
- `ClipboardChangeEvent` availability, but do not use it for SLVP behavior
- pointer/hover/coarse-pointer and platform family

The stream session should carry explicit clipboard policy:

- `disabled`
- `local-to-remote`
- `remote-to-local`
- `bidirectional-text`

Default SLVP policy: `bidirectional-text`, owner gesture required, text only,
no ambient sync, no durable storage, no content logging.

Strict stealth mode:

- Baseline viewing/input and host-to-remote paste must not require page-level
  scripts, Runtime bindings, or CDP paste helpers.
- CDP/page-level helpers may be used only in `balanced` or `assistive` modes
  with telemetry naming the helper path.

### Telemetry

Record only metadata:

- direction, action, method, phase, browser family, coarse pointer, focus state
- permission/probe state
- success/failure/error name
- text length bucket, not text content
- whether a fallback sheet was opened

Never log clipboard text or local preview contents.

## Promotion Trigger

Promote this into the active OpenSpec delta before implementation if any of the
following become durable contracts:

- New stream-token policy fields.
- New SSE event names or payload schemas for clipboard buffering.
- New input endpoint command types.
- New stealth-mode guarantees around clipboard helpers.

## Implementation Plan

1. Add a small clipboard capability/policy module for deterministic decisions:
   platform probes in, supported actions out.
2. Replace mobile raw Copy/Paste buttons with a Keyboard button and, once ready,
   one Clipboard Sheet entry point.
3. Build the Clipboard Sheet:
   local-to-remote field, Paste from Device action, Send to Browser action,
   remote-to-local buffer, Copy to Device action, manual selectable fallback.
4. Rework remote clipboard SSE handling:
   desktop may best-effort write immediately; mobile stores an ephemeral buffer
   and asks for a tap before writing to the device clipboard.
5. Keep n.eko `control.paste` as the primary remote input path.
6. Keep CDP `Input.insertText` and page-level selection helpers behind
   non-strict assistive mode.
7. Add redacted telemetry and replay fixtures for Android Chrome, iOS Safari,
   mobile Firefox, desktop Chrome, desktop Safari, and desktop Firefox.
8. Add acceptance checks for one-line text, multiline text, Unicode, empty
   clipboard, denied permission, password-like target masking, copy after remote
   Ctrl+C, copy after remote context-menu Copy, rotation while sheet is open,
   reconnect/session end clearing, and disabled policy.

## Decision Log

- 2026-05-07: Decided that mobile clipboard should not be raw Copy/Paste
  buttons. The correct SLVP path is explicit owner-controlled clipboard bridge
  with seamless enhancement plus manual panel fallback.
- 2026-05-07: Decided not to depend on `ClipboardChangeEvent` for the SLVP
  because it is experimental and lacks Safari/Firefox support.
