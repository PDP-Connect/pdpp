# RemoteSurface Step 2 — NekoPointerController

## Canonical-pattern verification

Verified the tap-to-click pattern against three independent upstream
sources before implementing:

1. **PDPP's existing fallback path** (`apps/web/src/app/dashboard/runs/[runId]/stream/neko-client.ts`,
   `clickNekoAtPoint` at L1573-1610): emits `control.buttonDown(1, pos)`
   + `control.buttonUp(1, pos)` at the same coordinates. This is the
   empirically-verified working path; n.eko's Chromium synthesizes
   `click` from the X11 button-press+release pair.

2. **remote-browser-sandbox** (`~/code/remote-browser-sandbox/client/src/input.ts`
   L80-130): touchstart → `mousedown {button:0}`, touchend →
   `mouseup {button:0}`. Same convention, second codebase.

3. **@demodesk/neko `bindTouchHandler`** (per
   `docs/demodesk-neko-input-research.md` L26391-26447): emits native
   `touchBegin/touchUpdate/touchEnd`, but only when
   `control.supportedTouchEvents === true`. Validation
   (`docs/neko-mode-mobile-validation-2026-05-12.md`) confirms native
   touch events reach the wire but Chromium does NOT synthesize click
   from them on a stationary button.

**Decision contrary to the brief's "belt-and-suspenders" guidance**: do
NOT emit both `buttonDown/Up` AND `touchBegin/End` by default.
`neko-client.ts:1771-1778` explicitly warns this causes double-delivery
on Android Brave ("click registers twice / modal closes immediately /
button toggles back"). The controller defaults to mouse-button-only and
exposes `nativeTouch?: boolean` as an opt-in for future
feature-flag-guarded experimentation.

`PointerEvent.button` is translated to X11 button codes by `+1`
(spec button 0 = primary = X11 button 1, button 2 = right = X11
button 3), matching `clickNekoAtPoint`'s hardcoded `1`.

## Files

Created:
- `/home/user/code/pdpp/packages/remote-surface/src/controllers/neko-pointer-controller.ts`
- `/home/user/code/pdpp/packages/remote-surface/src/controllers/neko-pointer-controller.test.ts`
- `/home/user/code/pdpp/packages/remote-surface/src/controllers/index.ts`

Modified:
- `/home/user/code/pdpp/packages/remote-surface/src/adapters/neko-surface-adapter.ts`
  (extended `NekoClientApi` with `getPointerControl` + `mapPointerToRemote`;
  wired `sendPointer` to lazily build a `NekoPointerController` per
  control identity; disposed on `unmount`)
- `/home/user/code/pdpp/packages/remote-surface/src/adapters/neko-surface-adapter.test.ts`
  (added two tests for the new `sendPointer` wiring)
- `/home/user/code/pdpp/packages/remote-surface/src/index.ts`
  (re-exports `NekoPointerController` and friends)

## Test & typecheck

- `pnpm typecheck`: clean.
- `pnpm test`: **20/20 pass** (11 NekoSurfaceAdapter, 9 NekoPointerController).

## Untouched (per anti-requirements)

`git status` confirms no modification to
`apps/web/src/app/dashboard/runs/[runId]/stream/neko-client.ts` or
`stream-viewer.tsx`.

## Expert follow-up before step 3

- **Coordinate mapper signature**: dashboard's `getNekoControlPos`
  (neko-client.ts:1423) takes `clientX/clientY` (viewport-absolute) and
  returns remote pixels. The controller's `mapToRemote(xLocal, yLocal)`
  matches that, but the dashboard wiring in step 3 must pass
  `event.clientX/clientY` not element-relative offsets. Worth a
  one-line confirmation.
- **`control.move` during hover** (no button held): the controller emits
  `move` on every `pointermove`. Existing neko-client.ts emits `move`
  only during active touch scrolling. If hover-move floods the wire on
  trackpad/mouse desktop usage, dashboard wiring may need to gate
  hover-move events before they reach the adapter.
- **Reconnect identity check**: the adapter rebuilds the controller when
  `client.getPointerControl()` returns a different object. Need to
  confirm with the dashboard wiring that `nekoInstance.control` does
  indeed swap on reconnect rather than mutating in place.
