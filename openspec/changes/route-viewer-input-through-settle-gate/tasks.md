## 1. Input dispatch cutover

- [x] 1.1 Retain console pointer capture and trusted-touch policy while dispatching eligible pointer intents through the mounted viewer handle.
- [x] 1.2 Route desktop wheel and fallback mobile touch-scroll delivery through viewer wheel intents; keep non-mounted direct helpers available.

## 2. Deterministic evidence

- [x] 2.1 Add a golden fixture that derives direct-path n.eko calls and compares routed pointer, wheel, and touch-scroll calls.
- [x] 2.2 Add console-level unsettled hold and settle-flush coverage.

## 3. Verification

- [x] 3.1 Run the stream-directory Node test gate without source-assertion weakening and record the baseline/final counts.
- [x] 3.2 Run console type checking, reference implementation streaming tests, unchanged #347 keyboard tests, and strict OpenSpec validation.

## 4. Adversarial cutover correction

- [x] 4.1 Upgrade the console package and lockfile to remote-surface 1.4.0 while retaining the reference implementation's 0.3.1 resolution.
- [x] 4.2 Separate mounted viewer dispatch from direct fallback movement and add gesture-scoped terminal touch wheel intents.
- [x] 4.3 Replace the hand replica parity test with a production-delivery harness covering non-zero residuals, consecutive gestures, and interleaved desktop wheel.
- [x] 4.4 Forward viewer input diagnostics to the console debug logger.
- [x] 4.5 Run the required console, reference-implementation, keyboard, and strict OpenSpec gates.

## 5. Metadata-only terminal boundary correction

- [x] 5.1 Upgrade the console package and lockfile to remote-surface 1.4.1 while retaining the reference implementation's 0.3.1 resolution.
- [x] 5.2 Emit a mounted-only, zero-delta terminal boundary at the last delivered touch coordinate; preserve non-mounted touchend behavior.
- [x] 5.3 Make production parity distinguish the legitimate metadata-only routed boundary from the direct path, and assert zero boundary control calls plus one move per touchmove.
- [x] 5.4 Run the required console, reference-implementation, keyboard, and strict OpenSpec gates.

## 6. Production terminal seam binding

- [x] 6.1 Bind parity's routed terminal step through the exported production touch-terminal handler, with changed touchend coordinates as input.
- [x] 6.2 Prove the touchend-coordinate mutation fails the bound test; restore the production behavior and run the required gates.

## 7. Rotation acceptance instrument

- [x] 7.1 Dispatch a production-shaped tap while the viewer is unsettled, settle to landscape geometry, and prove delivery uses the post-transition `stream-viewer-geometry.ts` projection.
- [x] 7.2 Route mounted fallback taps through the exported production delivery seam and prove it has no direct n.eko fallback call.
- [x] 7.3 Cancel tracked mounted pointer presses before remount teardown and prove a late terminal event cannot double-release.

## 8. Trusted-touch warm path

- [x] 8.1 Add a short-lived confirmed-editable-rect cache that permits a synchronous one-tap focus only for a matching mapped coordinate.
- [x] 8.2 Invalidate the cache on geometry epoch changes, remote navigation, and viewer remounts; preserve the late-confirmation affordance on cache miss or expiry.
- [x] 8.3 Add deterministic warm-hit, miss, expiry, lifecycle-invalidation, and outside-rect regression coverage; run the keyboard, stream-directory, type, and strict OpenSpec gates.
