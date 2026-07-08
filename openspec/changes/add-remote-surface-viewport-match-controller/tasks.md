## 1. OpenSpec

- [x] 1.1 Author proposal, design, tasks, and spec delta.
- [x] 1.2 Validate the change with `openspec validate add-remote-surface-viewport-match-controller --strict`.

## 2. Package controller

- [x] 2.1 Add `createViewportMatchController` under `packages/remote-surface/src/client/`.
- [x] 2.2 Reuse `StreamViewerSurface`, `classifyViewportTransition`, and `buildViewportPayload`.
- [x] 2.3 Expose mismatch telemetry, listener subscription, snap policy, debounce controls, fake-clock injection, and clean disposal.
- [x] 2.4 Add unit tests for layout resize, keyboard suppression, orientation transition, debounce coalescing, snap policy, target payload, telemetry, and disposal.
- [x] 2.5 Export the controller from the client entry and package root.

## 3. Backend seams

- [x] 3.1 Wire the CDP playground controller `applyViewport` to the existing CDP resize path.
- [x] 3.2 Add the visible viewport-match telemetry panel.
- [x] 3.3 Add a n.eko apply-viewport seam type/stub with mode-snap, Browser.setWindowBounds, and gutter-crop TODOs.

## 4. Docs and dist

- [x] 4.1 Document the controller in the package README.
- [x] 4.2 Rebuild dist and keep dist drift clean.

## 5. Validation

- [x] 5.1 `openspec validate add-remote-surface-viewport-match-controller --strict`
- [x] 5.2 `pnpm --filter @opendatalabs/remote-surface verify`
- [x] 5.3 `pnpm --filter @opendatalabs/remote-surface playground:test`
- [x] 5.4 Manual Playwright verification on port 3995 for desktop 1280x800 and Pixel 5 across inline, modal, and odd modes.
