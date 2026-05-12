# Remote Surface — Step 1: NekoSurfaceAdapter

## What was implemented

Replaced the throwing scaffold in `packages/remote-surface/src/adapters/neko-surface-adapter.ts` with a working `NekoSurfaceAdapter` that satisfies the `RemoteSurface` contract. Lifecycle is tracked explicitly (`idle → mounting → mounted → unmounting → idle`, plus terminal `error`), with state-guard errors on misuse.

## DI over cross-package import

The adapter does **not** import `neko-client.ts`. Several helpers it would have needed (`startNeko`, `focusNekoKeyboard`, the `control.paste` text path, and a teardown) are file-private. Rather than mutate `neko-client.ts` to widen its API during step 1, the adapter accepts a structural `NekoClientApi` via constructor DI:

```ts
interface NekoClientApi {
  start(container, config): Promise<void>;
  stop?(): Promise<void> | void;
  focusKeyboard?(): void;
  sendText?(text: string): Promise<void> | void;
}
```

The dashboard will bind this against `neko-client.ts` in step 3. This matches the expert's "wrap first, extract second" intent and keeps `packages/remote-surface` free of cross-package coupling.

## Delegation vs TODO

- `mount` → `client.start(el, config)`. Delegated.
- `unmount` → `client.stop?.()`. Delegated; warns if absent. (Step 3 must supply a stop wrapper around `nekoInstance.$destroy?.()`.)
- `focusTextInput` → `client.focusKeyboard?.()`. Delegated; `opts.inputMode` ignored with TODO for MobileInputController (step 4).
- `sendPointer` → **TODO(step-2)** NekoPointerController. No-op today (no imperative pointer API exists in `neko-client.ts`; current dashboard wires pointer DOM handlers inside `startNeko`).
- `sendKeysym` → **TODO(step-4)** MobileInputController. No-op today.
- `sendText` → `client.sendText?.(text)`. Delegated; warns if absent. Step 3 wires this to `nekoInstance.control.paste(text)` (neko-client.ts ~line 1088).

## Files modified

- `packages/remote-surface/src/adapters/neko-surface-adapter.ts` — real implementation.
- `packages/remote-surface/src/adapters/neko-surface-adapter.test.ts` — new, 9 smoke tests.
- `packages/remote-surface/src/adapters/index.ts` — re-export `NekoClientApi` and `NekoSurfaceAdapterDeps`.
- `packages/remote-surface/package.json` — added `test` script (`node --test --import tsx`); `verify` now runs it.

## Files NOT modified (per expert's freeze)

- `apps/web/src/app/dashboard/runs/[runId]/stream/neko-client.ts` — untouched, no new exports added.
- `apps/web/src/app/dashboard/runs/[runId]/stream/stream-viewer.tsx` — untouched.

The DI pattern made it possible to avoid the only mutation the brief had pre-authorized (adding exports). Diff is zero across both files.

## Typecheck

```
$ cd packages/remote-surface && pnpm tsc --noEmit
TypeScript: No errors found
```

## Tests

```
$ pnpm test
✔ NekoSurfaceAdapter (9/9 passing)
  ✔ transitions idle → mounted on mount()
  ✔ transitions mounted → idle on unmount()
  ✔ throws on double mount()
  ✔ throws on methods called before mount()
  ✔ transitions to error and rethrows if start() fails
  ✔ unmount() is a no-op when already idle
  ✔ focusTextInput() delegates to client.focusKeyboard
  ✔ sendText() delegates to client.sendText
  ✔ tolerates missing optional client methods
```

## Next step

**Step 2 — NekoPointerController.** Extract the pointer dispatch + tap-to-click logic that today lives inline inside `startNeko`'s DOM handlers into a controller object, then have `NekoSurfaceAdapter.sendPointer` delegate to it. This is the first step where `neko-client.ts` actually needs surgery.
