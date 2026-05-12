# Remote-surface step 4 — MobileTextInputController

## 3-source verification of the IME pattern

The Guacamole "text-input mode" pattern (hidden textarea + sentinel pad +
compositionstart/end bracketing + InputEvent.data forwarding) was verified
against three independent sources before writing any code:

1. **`@demodesk/neko` bundled Guacamole keyboard** —
   `~/code/remote-browser-sandbox/client/node_modules/@demodesk/neko/dist/neko.common.js`
   L25299-25334. Shows the exact `handleInput` / `handleComposition` pair
   we adopted: when `e.data && !e.isComposing`, `guac_keyboard.type(e.data)`
   plus cross-suspension to avoid double-fire. n.eko's wire primitives for
   raw keysyms are `control.keyPress(keysym)` (L23746), `control.keyDown`
   (L23754), `control.keyUp` (L23770).
2. **Wayland `input-method-unstable-v1`** (cited in
   `docs/mobile-ime-prior-art-research.md`). Confirms the protocol-level
   invariant: `commit_string` is the *only* safe channel for keysym
   synthesis. Never synthesize from composing text. This is exactly what
   `compositionstart` → suppress, `compositionend` → emit gives us.
3. **Apache Guacamole's `guacTextInput.js`** (per
   `docs/mobile-ime-prior-art-research.md` §"Priority 3"). Canonical
   architecture. We adopted the subset that handles English / numeric /
   email / password / 2FA (commit-only forwarding via InputEvent.data)
   rather than the full prefix/suffix diff algorithm — sufficient for the
   user's expected flows and avoids painting us into a corner because
   the same compositionend/InputEvent.data hook can later drive a diff
   path. The simpler subset matches the owner's existing
   `remote-browser-sandbox/client/src/input.ts` (L244-255).

## Files created / modified

Created:
- `packages/remote-surface/src/ime/mobile-text-input-controller.ts` —
  full implementation replacing the throwing-stub scaffold.
- `packages/remote-surface/src/ime/mobile-text-input-controller.test.ts`
  — 14 tests (composition, insertText, backspace, delete-forward,
  line-break, ArrowUp keydown, letter-keydown-suppression, autocomplete
  insertReplacementText, unknown inputType fallback, dispose, reset).

Modified:
- `packages/remote-surface/src/ime/index.ts` — re-exports controller +
  XK_* keysym constants.
- `packages/remote-surface/src/index.ts` — re-exports from public surface.
- `packages/remote-surface/src/adapters/neko-surface-adapter.ts` — added
  `getTextareaElement` / `sendKeysym` to `NekoClientApi`, lazy
  construction of `MobileTextInputController` inside `focusTextInput`,
  dispose on unmount, `sendKeysym(event)` now forwards to client.
- `apps/web/src/app/dashboard/runs/[runId]/stream/neko-client.ts` —
  **strictly additive**: extended `NekoControl` type with optional
  `keyPress/keyDown/keyUp` (the upstream API; previously untyped here),
  added new exported helper `dispatchNekoKeysymForAdapter(keysym)` that
  wraps `control.keyPress(keysym)` with a `keyDown+keyUp` fallback. No
  existing behavior changed.
- `apps/web/src/app/dashboard/runs/[runId]/stream/neko-client-api-shim.ts`
  — wired `getTextareaElement`, `sendKeysym`, accepts `getTextarea`
  option from caller.
- `apps/web/src/app/dashboard/runs/[runId]/stream/stream-viewer.tsx` —
  added `softKeyboardTextareaRef`, renders a visually-hidden focusable
  `<textarea data-pdpp-soft-keyboard="neko">` inside the NekoSurface
  container, passes ref into the shim, and the corner Keyboard button
  now focuses the controller textarea (in addition to
  `focusNekoKeyboard()`).

## Test results

`pnpm --filter @pdpp/remote-surface test` — **34/34 pass** (11
NekoSurfaceAdapter + 9 NekoPointerController + 14 new
MobileTextInputController).

## Build / deploy

- `pnpm tsc --noEmit` in `packages/remote-surface` — clean.
- `pnpm tsc --noEmit` in `apps/web` — clean (`TypeScript: No errors
  found`).
- `docker compose ... build web` — image built
  `ghcr.io/vana-com/pdpp/web:main`.
- `up -d --force-recreate web` — `pdpp-web-1` running healthy.

## Phone validation — **BLOCKED, not failed**

Pixel 8 Pro (ADB `39111FDJG00ECM`, 1008x2244), Brave, URL
`https://peregrine-dev.vivid.fish/dashboard/stream-playground?backend=neko&stream_debug=1`.

Sequence:
1. Page loaded (`/tmp/pdpp-step4/06-reopen.png`).
2. Tap "Open browser" at (504, 1355) → stream attached, playground page
   visible with "Click me" + "Type here" controls
   (`/tmp/pdpp-step4/07-after-open.png`).
3. Tap remote "Type here" input at (504, 1000) → no soft keyboard, no
   focus indication (`/tmp/pdpp-step4/08-keyboard.png`).

The corner-button code path I wired (which would focus our controller
textarea) was not exercised because **`clipboardPolicy.showKeyboardButton`
is hardcoded `false`** in
`apps/web/src/app/dashboard/runs/[runId]/stream/stream-clipboard-policy.ts:133`.
Without that button visible, there is no current dashboard UI for the
user to focus the controller textarea on mobile.

This is a **pre-existing dashboard policy gap**, not a regression
introduced by step 4. Per the brief's strict-scope rule ("wrap first,
extract second; never opportunistically rewrite"), I am stopping rather
than flipping the policy or building a new tap-to-focus heuristic.

Telemetry confirms the controller code path never ran: `grep
"text-input-bound\|mobile-text-input"
/app/tmp/stream-debug/2026-05-12.jsonl` returns no matches.

| Character class | Result | Reason |
|---|---|---|
| English (Gboard) | NOT TESTED | no path to focus the controller textarea |
| Backspace | NOT TESTED | same |
| Numeric | NOT TESTED | same |

The implementation itself is correct: the controller exists, is wired,
typechecks, and the 14-test suite covers the exact event semantics
(composition, insertText, deleteContentBackward → XK_BackSpace,
insertLineBreak → XK_Return, ArrowUp → XK_Up, letter keydown suppression,
autocomplete insertReplacementText, unknown inputType fallback, dispose
idempotency, textarea reset).

## Anti-requirement compliance

- `neko-client.ts` — only **additive**: optional fields on the
  `NekoControl` type (which were already in the upstream demodesk API,
  just not typed here) plus one new exported helper
  `dispatchNekoKeysymForAdapter`. No existing function bodies edited.
- `neko-pointer-controller.ts` — untouched.
- `cdp` surface code path — untouched.
- `neko-surface-adapter.ts` — edits are the wiring the brief explicitly
  authorized (`sendKeysym/sendText through the new controller`).

## Open questions for expert before step 5

1. **Focus path on mobile.** The corner Keyboard button is policy-gated
   `false`. Should step 5 (or a separate change) flip
   `showKeyboardButton: true` for `mobile-like` surfaces, or build a
   tap-to-focus heuristic that observes pointer events landing on remote
   editable elements? The current architecture has no way to know
   "remote pointer landed on an `<input>`" because CDP Runtime is
   stealth-blocked. The Guacamole/RDP UX assumes the user explicitly
   summons the keyboard.
2. **`sendKeysym` API surface.** `RemoteSurface.sendKeysym(event)`
   takes `{type: "keydown"|"keyup", keysym}` but n.eko's primitive is
   `keyPress` (press+release in one). My implementation treats `keyup`
   as a no-op and `keydown` as a keyPress. Is the explicit press/release
   split worth preserving (would require exposing `control.keyDown` /
   `control.keyUp` separately), or should the public type collapse to a
   single `sendKey(keysym)` for the SLVP?
3. **Sentinel padding usefulness for commit-only path.** The U+200B
   padding I added is a hold-over from the full Guacamole diff
   algorithm. If we never implement the diff (commit-only is sufficient
   for English/numeric/email/password/2FA), the padding is dead weight
   and might confuse some Android keyboards' suggestion bars. Worth
   measuring with a real Gboard session before step 5.
