# RemoteSurface Step 3 — Dashboard wired to NekoSurfaceAdapter

## Files

Created:
- `apps/web/src/app/dashboard/runs/[runId]/stream/neko-client-api-shim.ts` (87 lines) — `createNekoClientApi()` binds the structural `NekoClientApi` to `neko-client.ts` module helpers.

Modified:
- `apps/web/src/app/dashboard/runs/[runId]/stream/stream-viewer.tsx` — `NekoSurface` now constructs and drives a `NekoSurfaceAdapter`. Added a capture-phase pointer dispatch effect that calls `adapter.sendPointer(...)`. Removed `startNeko` / `stopNeko` imports; replaced with `NekoSurfaceAdapter` (from `@pdpp/remote-surface`) + `createNekoClientApi` (shim). Net change ~+120 lines inside `NekoSurface`.
- `apps/web/src/app/dashboard/runs/[runId]/stream/neko-client.ts` — append-only: added `getNekoPointerControlForAdapter()` and `mapNekoPointerToRemoteForAdapter(clientX, clientY)` under a clearly-commented section. **No other changes.**
- `apps/web/package.json` — added `"@pdpp/remote-surface": "workspace:*"`.

## Resolution of step-2 open questions

1. **Coordinate mapper signature.** Confirmed via `neko-client.ts:1423`: `getNekoControlPos(clientX, clientY)` reads viewport-absolute `clientX/clientY` (prefers `nekoInstance._overlay.getMousePos`, then overlay-rect-relative math, then media-element-rect-relative math). The dashboard wire site passes `event.clientX / event.clientY` from the `PointerEvent`. The shim's `mapPointerToRemote` is a direct delegate.

2. **Hover-move gate.** Implemented in the wire-site `useEffect`: `if (type === "pointermove" && event.pointerType === "mouse" && event.buttons === 0) return;`. Touch and pen moves always forward. Mouse drag (buttons!=0) forwards.

3. **Reconnect identity.** `neko-client.ts:2615` sets `nekoInstance = null` on `stopNeko`, and `nekoInstance = neko` is re-assigned only inside `startNeko`. The `control` object is a property of `nekoInstance` — when `nekoInstance` is replaced (full restart), `control` identity changes; the adapter's `pointerControllerControl !== control` check rebuilds `NekoPointerController` automatically. WebRTC reconnects in-place do NOT swap `nekoInstance`, so the same controller is reused — also correct, because `control` identity is stable across WebRTC reconnects.

## Typecheck & tests

- `packages/remote-surface`: `tsc --noEmit` clean.
- `packages/remote-surface`: `pnpm test` → **20/20 pass** (11 NekoSurfaceAdapter, 9 NekoPointerController).
- `apps/web`: `pnpm types:check` clean (`fumadocs-mdx && next typegen && tsc --noEmit` all green).

## Build & deploy

`DOCKER_BUILDKIT=1 docker compose ... build web` succeeded; `up -d --force-recreate web` recreated `pdpp-web-1`. Container reports healthy; `/dashboard/stream-playground` returns 307 (auth redirect, as expected unauth'd). Adapter is present in compiled chunks (grep `NekoSurfaceAdapter` against `.next/static/chunks/*.js`).

## Tap-to-click validation — **PASS**

Pixel 8 Pro (ADB 39111FDJG00ECM, 1008x2244), Brave, URL `https://peregrine-dev.vivid.fish/dashboard/stream-playground?backend=neko&stream_debug=1`.

| Step | Screenshot | Counter |
|------|-----------|---------|
| Stream loaded | `/tmp/step3-stream-open.png` | 0 |
| First tap on "Click me" at (270, 480) | `/tmp/step3-tap-click2.png` | **1** |
| Second tap | `/tmp/step3-tap-click3.png` | **2** |

Remote-page log in screenshots shows the `click at (118, 116)` entry preceding each `touchstart`, confirming Chromium synthesizes the click from the X11 button-press/release pair the adapter emits via `NekoPointerController`.

## Anti-requirement compliance

- `git diff neko-client.ts` is **additive-only**: a single `// ── Exports consumed by ...` block at EOF with two functions (`getNekoPointerControlForAdapter`, `mapNekoPointerToRemoteForAdapter`). No existing function altered.
- `<BrowserSurface>` (CDP backend) untouched — still uses its `postInput` path.
- No new npm deps; only the existing workspace package `@pdpp/remote-surface` added to `apps/web/package.json`.
- No other connector flows touched.

## Notes

- The wire-site pointer listener is registered with `{ capture: true, passive: true }` on the surface container. With `passive: true`, neko's own internal handlers on the overlay textarea (which `preventDefault` for native touch scrolling) still function — both paths see each event. Empirically (counter = 2 after two taps, not 4) Chromium de-duplicates the redundant click side, so we're not seeing double-delivery on the validated path. The pre-existing `clickNekoAtPoint` fallback (in `startMobileTouchScrollBridge`) only fires when no native click is observed, so it stays dormant when our adapter path delivers.
- `sendText` in the shim calls `pasteTextIntoNeko` which already internally calls `focusNekoKeyboard()`. Adapter's `sendText` therefore continues to work for the existing text-paste flow once step 4 (MobileInputController) wires through.
