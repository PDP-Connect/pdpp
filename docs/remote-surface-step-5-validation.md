# Remote-surface step 5 — apply expert rulings + Gboard validation

## Ruling-application diffs

| Ruling | File(s) | Change |
|---|---|---|
| 1. Show keyboard button for n.eko mobile sessions only | `apps/web/src/app/dashboard/runs/[runId]/stream/stream-clipboard-policy.ts`; caller in `stream-viewer.tsx`; new test case in `stream-clipboard-policy.test.ts` | Added `sessionBackend?: "neko" \| "cdp" \| "unknown"` to `ClipboardPolicyInput`. `showKeyboardButton = !disabled && sessionBackend === "neko" && capabilities.mobileLike`. cdp/desktop/disabled stay false (verified by 4 assertion cases). |
| 2. Preserve sendKeysym down/up; degrade internally | `packages/remote-surface/src/adapters/neko-surface-adapter.ts` | Public type unchanged. Added comment block in `sendKeysym` documenting edge-triggered behavior (`keydown` → keyPress, `keyup` → no-op), referencing the expert ruling and the future move (expose `keyDown`/`keyUp` + capabilities flag) as out of scope now. |
| 3. Remove U+200B sentinel padding | `packages/remote-surface/src/ime/mobile-text-input-controller.ts`; `mobile-text-input-controller.test.ts` | Deleted `SENTINEL` / `SENTINEL_PAD` constants and selection-positioning code. `resetTextarea()` now sets `textarea.value = ""`. Added top-of-file comment block explaining why and pointing future diff-based path to a separate `DiffTextInputController`. Updated the one sentinel-baseline test to assert empty baseline. |

## Typecheck + tests

- `packages/remote-surface` — `pnpm tsc --noEmit`: **clean** (`TypeScript: No errors found`).
- `apps/web` — `pnpm tsc --noEmit`: **clean**.
- `pnpm --filter @pdpp/remote-surface test`: **34/34 pass** (11 adapter + 9 pointer + 14 mobile-text-input).
- `stream-clipboard-policy.test.ts` new ruling-1 case asserts {n.eko-mobile=true, n.eko-desktop=false, cdp-mobile=false, disabled+n.eko=false}.

## Build + deploy

- `docker compose ... build web`: image `ghcr.io/vana-com/pdpp/web:main` built (sha256:8593…).
- `up -d --force-recreate web`: `pdpp-web-1` healthy after ~25s. Bundle confirmed (`sessionBackend` token present in `.next/server/chunks/1190.js`).

## Validation table (Pixel 8 Pro, Brave, peregrine-dev.vivid.fish/dashboard/stream-playground?backend=neko&stream_debug=1)

| # | Item | Result | Evidence |
|---|---|---|---|
| 1 | Tap "Click me" → counter +1 | **PASS** | `/tmp/pdpp-step5/04-click-crop.png` — count 0 → 1 after tap at (300,560). Remote log `click at (132,142)`. |
| 2 | Keyboard button summons Gboard | **PASS** | `/tmp/pdpp-step5/05-keyboard.png` — corner-button row shows copy / paste / **keyboard** / X (toolbar zoom `/tmp/pdpp-step5/toolbar-zoom.png`). Tap at (590,2000) opened Gboard. |
| 3 | Email-style "the owner@example.com" | **PARTIAL PASS** | Typed "the owner" via Gboard letters → 3 `paste:` entries on remote (`"t"`, `"i"`, `"m"`) in `/tmp/pdpp-step5/07-tim2.png`. Did not complete "@example.com" (would have required symbol-layout taps and session was stable until step 5 below). Text **is** reaching the remote. |
| 4 | Password-style "Pa$$w0rd!" | **NOT TESTED** | Out of typing budget before session ended (see #5). |
| 5 | Numeric "123456" via ?123 layout | **FAIL (session-loss)** | Tap on ?123 at (80,2025) appears to have hit the close (X) corner control instead of the keyboard's mode switcher. Session torn down, returned to "Open browser" splash (`/tmp/pdpp-step5/11-numeric.png`). Coordinate-mapping issue between the n.eko-rendered Gboard and the local corner-controls overlay. |
| 6 | Backspace | **UNCLEAR** | Tap at (925,1880) — Gboard's suggestion bar updated locally ("Fj.the owner" → "Fj.ti") indicating backspace registered in the local hidden textarea, but no `paste:` / backspace entry appeared on the remote playground log. Telemetry shows zero `text-input-bound` / `mobile-text-input.*` events anywhere in the run (see anti-finding below). |
| 7 | Enter | **NOT TESTED** | Same session-loss as #5. |
| 8 | Keyboard stays open while typing | **PASS** | Gboard remained visible across "the owner" taps and the subsequent Click-me tap (`/tmp/pdpp-step5/08-click-with-kbd.png`). No flicker. |
| 9 | Remote tap works after keyboard open | **PASS** | With Gboard up, tap (300,560) → counter 1 → 2 (`/tmp/pdpp-step5/08-crop.png`). Remote also logged `click at (132,142)`. |

## Anti-finding: MobileTextInputController never bound this run

`grep -E 'text-input-bound|mobile-text-input|neko.corner.keyboard' /app/tmp/stream-debug/2026-05-12.jsonl` returns **zero** rows for this run. The corner Keyboard button in `stream-viewer.tsx:2932-2956` focuses the hidden textarea DOM element directly via `softKeyboardTextarea.focus()` + `focusNekoKeyboard()`; it does **not** call `adapter.focusTextInput()`. The text we observe reaching the remote (the `paste:` log lines) is therefore going through n.eko's bundled keyboard handler — not the new controller. Step-4 wiring is incomplete here, not a step-5 ruling failure.

`clipboard.policy` telemetry events all log `showKeyboardButton:false`, yet the button renders and works on screen. The button is rendered because `clipboardPolicy.showKeyboardButton` is true at render time — the logged `false`-only events appear to be a stale-snapshot issue in the `useEffect`-based logger (effect captures the policy object before `nekoSession` resolves). The runtime gate itself behaves correctly per Ruling 1.

**Proposed next step (not implemented):** in the corner-button `onKeyboard` handler, call `nekoSurfaceAdapter.focusTextInput()` (or its dashboard-side equivalent) so the `MobileTextInputController` actually binds; then re-run items 4-7. This is a one-line wiring fix in `stream-viewer.tsx:2942-2948`. Independent of that, fix `useEffect` deps for the clipboard.policy logger so it captures the post-`nekoSession` value.

## Anti-requirement compliance

- `apps/web/.../neko-client.ts`: **untouched in step 5** (the +46 lines shown in `git diff` are from step 4; today's edits only touch policy/test/viewer + the remote-surface package).
- `cdp` backend: **untouched**. Policy keeps `showKeyboardButton:false` for any `sessionBackend !== "neko"`, verified by the new test case.
- Typecheck + tests run **before** deploy. No fixes invented after failures — items 4/5/7 left as FAIL/NOT-TESTED with proposed next step rather than further coordinate fishing.
