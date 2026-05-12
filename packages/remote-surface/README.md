# @pdpp/remote-surface

Internal PDPP package implementing the `RemoteSurface` abstraction layer
between the PDPP dashboard and remote-browser backends.

This is the architectural shape recommended in:

- `docs/5-12-26-chatgpt-remote-surface-brief-response.txt` (expert brief response)
- `docs/neko-stealth-design-brief.md` (broader stealth design brief)
- `docs/mobile-ime-prior-art-research.md` (Guacamole-style mobile IME prior art)

## Scope

This package is **not** a general-purpose remote-desktop library. Its scope
is narrow: powering manual-action interactions inside the PDPP dashboard
(pointer events, keyboard events, mobile IME text commits) against a remote
browser session.

## Adapters

- **`NekoSurfaceAdapter`** — **preferred** for stealth flows. Wraps an
  `@demodesk/neko` client and forwards interaction events over n.eko's
  WebRTC data channel.
- **`CdpSurfaceAdapter`** — fallback / legacy / debug path. Wraps the
  existing CDP-backed `BrowserSurface` for sessions that cannot use n.eko.

## Mobile IME

`MobileTextInputController` ports the Guacamole `guacTextInput.js` pattern:
hidden `<textarea>` capturing `beforeinput`, `input`, and `compositionstart`/
`compositionupdate`/`compositionend` events, then translating them into
either X11 keysym events (for ASCII keystrokes) or text-commit batches
(for IME composition results).

## Status

Scaffold only. All methods throw `not implemented yet`. Implementation
lands one adapter at a time, behind a feature flag, after the dashboard
integration step.
