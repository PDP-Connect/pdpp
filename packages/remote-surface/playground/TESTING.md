# Testing the remote-surface acceptance playground

The playground streams a real headed Chromium (running a local login-form "probe"
page) to your browser and sends your input back through the package's CDP backend.
It's the instrument for judging whether the browser-surface UX is actually good —
every claim on screen is measured, not asserted.

## It's already running

Started with `REMOTE_SURFACE_PLAYGROUND_HOST=0.0.0.0` so both desktop and phone
can reach it on the LAN.

- **Desktop:** http://127.0.0.1:3977
- **Phone (same Wi-Fi):** http://<lan-host>:3977

Driver: package `CdpSurfaceAdapter` (the real one). If it's not running, restart with:

```sh
REMOTE_SURFACE_PLAYGROUND_HOST=0.0.0.0 pnpm --filter @opendatalabs/remote-surface playground:dev
```

(Loopback-only default is restored by omitting the HOST env. `--driver=legacy`
switches to the old hand-rolled CDP path for A/B.)

## What's on screen

Top toolbar:
- **Quality** — screencast JPEG quality slider.
- **Viewport** — Android 390×844 vs Desktop 1280×720.
- **Form overlay** — the crown-jewel toggle. OFF = keystrokes go straight to the
  remote browser (the old feel). ON = invisible native local inputs sit over the
  remote fields, your device's own keyboard/IME owns typing, and the value commits
  semantically. **The whole point is to feel the difference here, especially on
  the phone.**
- **Reset** — clears the probe form.

Action strip (quick ways to exercise the probe without typing): Tap email, Email,
Password, 2FA, Backspace + enter, Keyboard inset.

Telemetry panels (right side):
- **Android checklist** — the 9-point acceptance gate, live pass/fail.
- **Per-character input** — for every keystroke: which local handler caught it,
  which CDP path (package vs legacy / insertText vs key) delivered it, and what the
  remote form actually received. This is the panel that makes "typing is broken"
  a diagnosable statement.
- **Pointer accuracy** — intended point vs dispatched vs observed click, pixel error.
- **Geometry** — capture size, display scale, black bars, 1:1 status.

## What to try (and where it hurt before)

These map to the specific complaints from past testing — see
`docs/research/remote-surface-ux-onboarding-2026-07-06.md` §3.

Desktop first (baseline), then phone (where it always fell apart):
1. Tap the email field, type your email. Watch the per-character panel — does every
   character land, in order, once? (Old bug: chars landing in the Android clipboard.)
2. Toggle **Form overlay** on and retype. Does typing feel more native — instant
   local caret/autocomplete, keyboard behaves like a normal field? (This is the RBS
   technique we're betting on.)
3. Password field: same, with overlay on vs off.
4. 2FA/numeric: does the numeric keyboard behave?
5. On the phone: single-tap a field — exactly one click? (Old bug: double-fire.)
   Drag on the stage — does it scroll rather than click? Long-press — no Android
   "save image" menu hijack, no duplicate action?
6. Rotate the phone — does geometry settle cleanly, or churn? (Old bug: dimensions
   changed twice before settling.)
7. Does the stream fit your screen, or are there black bars / wrong size?

## Leave notes

Drop feedback straight into `playground/NOTES.md` (next to this file) — freeform,
per-observation, desktop vs phone. Rough is fine; that file is the raw signal.
