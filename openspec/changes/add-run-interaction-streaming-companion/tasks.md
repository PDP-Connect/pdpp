## 1. OpenSpec And Prior-Art Review

- [x] 1.1 Validate this change with `openspec validate add-run-interaction-streaming-companion --strict`.
- [x] 1.2 Inspect `remote-browser-service`, `remote-browser-sandbox`, and `remote-browser` before choosing the implementation source.
- [x] 1.3 Record the final reuse/fork decision and why n.eko remains out of MVP.

## 2. Streaming Session Security

- [x] 2.1 Add a streaming session store or helper scoped to run id, interaction id, browser/session id, expiry, and token hash.
- [x] 2.2 Reuse existing owner/dashboard auth to mint links where possible.
- [x] 2.3 Add short TTL, single-use or interaction-bound invalidation, and cancellation on interaction resolution.
- [x] 2.4 Add tests for expired, wrong-run, wrong-interaction, resolved-interaction, and unauthenticated access.

## 3. CDP Companion Runtime

- [x] 3.1 Add a streaming companion abstraction around CDP screencast frames.
- [x] 3.2 Add CDP input event mapping for mouse, keyboard, and touch.
- [x] 3.3 Add viewport sizing from viewer dimensions and document supported resize behavior.
- [x] 3.4 Add a fake/mock CDP harness for deterministic tests.

## 4. Dashboard UX

- [x] 4.1 Add owner-facing notification or run interaction affordance when `manual_action` needs browser control.
- [x] 4.2 Add a stream viewer page that maps device-sized input to browser coordinates.
- [x] 4.3 Avoid generic “remote browser” copy; frame the page as satisfying the current connector step.
- [x] 4.4 Ensure resolved/cancelled/expired sessions show clear next steps.

## 5. Integration

- [x] 5.1 Wire manual-action interactions to mint streaming sessions without changing credential/OTP interaction semantics.
- [x] 5.2 Keep streaming companion separate from collector pairing and collector device credentials.
- [x] 5.3 Add run timeline/diagnostic events that show streaming session requested/opened/resolved without leaking sensitive input.

## 6. Validation

- [x] 6.1 Run `pnpm --dir reference-implementation test`.
- [x] 6.2 Run `pnpm --dir reference-implementation run typecheck`.
- [x] 6.3 Run `pnpm --dir apps/web run types:check`.
- [x] 6.4 Run `pnpm --dir apps/web run check`.
- [x] 6.5 Run `pnpm --dir apps/web run build`.
- [x] 6.6 Run `pnpm spec:check`.

## 7. Real CDP Adapter And Honest Unavailable State

- [x] 7.1 Add a real CDP adapter (`server/streaming/cdp-adapter.js`) that speaks JSON-RPC directly over a Chrome DevTools page-target WebSocket — no Playwright/Puppeteer dependency in the reference server.
- [x] 7.2 Resolve the CDP WebSocket URL from `PDPP_RUN_INTERACTION_CDP_WS_URL` (or `opts.streamingCdpWsUrl`); when neither is set, the default companion factory is `null`.
- [x] 7.3 Mint route returns `503 streaming_companion_unavailable` when no companion factory is configured. Tokens are never issued for a deployment that cannot stream.
- [x] 7.4 Dashboard viewer maps the unavailable response to a configuration-pointer state (no dead "Start streaming" button when streaming is impossible).
- [x] 7.5 Drop the legacy `host_browser_required` interaction kind from the streaming surface (route + viewer). The runtime no longer emits this kind after `introduce-local-collector-runner`.
- [x] 7.6 Add deterministic adapter tests using an in-memory fake `WebSocket` ctor that exercises JSON-RPC dispatch, screencast frame fan-out, ack, viewport mapping, error propagation, and close.
- [x] 7.7 Add an integration test that proves a server with no companion configuration returns 503 from the mint route.

## 8. DevTools HTTP Target Resolver And Live Smoke Proof

- [x] 8.1 Add `resolveCdpHttpUrlFromEnv(env)` reading `PDPP_RUN_INTERACTION_CDP_HTTP_URL` and a typed `createCdpTargetFromHttp({ httpUrl, fetch })` that issues `PUT /json/new?about:blank` (with GET fallback) and returns `{ webSocketDebuggerUrl, targetId, close }` from Chrome's DevTools HTTP endpoint.
- [x] 8.2 Extend `createDefaultStreamingCompanionFactory` to accept either a fixed `wsUrl` or an `httpUrl`. When only `httpUrl` is set, mint a fresh page target per streaming session and best-effort close that target on companion stop. Native `fetch` and native `WebSocket` are acceptable; do not add Playwright/Puppeteer to the reference server.
- [x] 8.3 Wire `opts.streamingCdpHttpUrl` through `server/index.js` so the reference server picks up the HTTP base alongside the existing WS URL option.
- [x] 8.4 Add unit tests for env resolution, target creation (PUT happy path, GET fallback, missing `webSocketDebuggerUrl`, malformed URL, non-2xx), and best-effort close. Inject a fake `fetch` so the tests do not need a real browser.
- [x] 8.5 Add a `PDPP_TEST_LIVE_CDP=1`-gated live smoke (`test/run-interaction-stream-cdp-live.test.js`) that auto-launches a headless Chrome on an ephemeral port (or attaches to `PDPP_TEST_CDP_HTTP_URL` / `PDPP_TEST_CDP_WS_URL`), proves frame + ack + input + `Runtime.evaluate` round-trip, and cleans up. Add `pnpm --dir reference-implementation test:live-cdp` for convenience.
- [x] 8.6 Document the HTTP path and the live smoke as reference-only operator config in `design.md`. Restate that the final collector/session-to-CDP-target binding remains optimistic behavior pending human-owner alignment.

## 9. n.eko Alternate Backend

- [x] 9.1 Generalize run streaming targets from legacy CDP `ws_url` to typed backend descriptors while preserving the legacy request body.
- [x] 9.2 Add a n.eko companion/proxy backend that satisfies the run-interaction lifecycle and never exposes the sidecar without a scoped stream token.
- [x] 9.3 Add dashboard viewer support for the native n.eko same-origin surface while leaving the CDP JPEG stream as default.
- [x] 9.4 Extend connector-side streaming-target registration to register n.eko descriptors.
- [x] 9.5 Add deterministic n.eko backend/proxy/registry tests and a gated live smoke hook if Docker/n.eko is available.
- [x] 9.6 Re-run OpenSpec validation and affected package checks.

## 10. Docker n.eko SLVP

- [x] 10.1 Add an optional Compose overlay that starts n.eko on the private Compose network and publishes only the WebRTC media mux ports.
- [x] 10.2 Add Docker env example defaults for n.eko and pass Docker-needed topology/connector env keys into the reference container explicitly.
- [x] 10.3 Add a playground backend selector so `/dashboard/stream-playground?backend=neko` registers a n.eko descriptor without launching the CDP test browser.
- [x] 10.4 Document the n.eko overlay test path and re-run affected checks.

## 11. n.eko UX Parity Hardening

- [x] 11.1 Add an embedded n.eko presentation layer so the owner sees the remote browser surface without n.eko product chrome, menus, or branding.
- [x] 11.2 Port the remote-browser-sandbox resize model: n.eko screen selection and Chromium app-window bounds follow the viewer viewport; page-level CDP device/touch emulation degrades to diagnostics when unavailable.
- [x] 11.3 Preserve n.eko's native same-origin paste/input path and keep the iframe keyboard overlay focused on mobile touch.
- [x] 11.4 Add reference-side diagnostics/tests for n.eko viewport, scoped status, input fallback, and embedded proxy behavior.
- [x] 11.5 Rebuild/restart the Docker n.eko overlay, recreating `reference` and `neko` together, and run a public smoke against `peregrine-dev.vivid.fish`.

## 12. n.eko UX Completion Tranche

- [x] 12.1 Reconcile the worker lift map, stealth matrix, and acceptance plan into this change before implementation starts.
- [x] 12.2 Replace the iframe n.eko surface with a direct `@demodesk/neko` client mount behind the existing token-scoped same-origin `/neko` proxy.
- [x] 12.3 Port the remote-browser-sandbox overlay focus model so n.eko's own textarea handles keyboard, paste, and mobile soft-keyboard focus on user gesture.
- [x] 12.4 Port the viewport pipeline: n.eko screen selection, Chromium app-window bounds, direct n.eko internal screen-size remap, local crop/remap for residual gutters, and true 1:1 probes where modes allow it.
- [x] 12.5 Define and enforce browser-owner modes: n.eko-owned Chromium for the SLVP, browser-owner/Patchright-compatible Chrome for stealth-sensitive runs, and stealth-gated page-level helpers (`strict`, `balanced`, `assistive`).
- [x] 12.6 Harden browser chrome suppression: no forced extension pages, no unexpected tab/address chrome, no n.eko room UI, and deterministic target/window selection after rebuild/restart.
- [x] 12.7 Add automated and manual acceptance coverage for chrome-free display, pointer/touch alignment, local-to-remote paste, mobile keyboard open/dismiss/reopen, resize/orientation, reconnect/app switch, and public `peregrine-dev.vivid.fish` testing.
- [ ] 12.8 Rebuild/recreate the n.eko Docker overlay and run the full desktop plus real-phone smoke matrix before marking the tranche complete. No-human checks (OpenSpec, remote-surface + reference streaming units, console types/build, live-CDP smoke) pass via `pnpm stream:no-human-verify`; physical real-phone smoke matrix remains. Re-confirmed green 2026-06-01 for the nine deterministic checks. **Docker rebuild sub-gate now CLOSED (2026-06-01):** the prior `patchright-chromium` build hang was root-caused to patchright's out-of-process zip extractor (extract-zip/yauzl) stalling after the 170 MiB download in this overlayfs build env — the bytes are fine (`unzip` of the same archive finishes in seconds), the extraction promise just never resolves. Fixed in `docker/neko/Dockerfile` + new `docker/neko/install-patchright-chromium.sh`: extract with the system `unzip` into the exact layout a real install leaves (`chromium-1217/chrome-linux64/chrome` + `INSTALLATION_COMPLETE`), revision/version read from the pinned `patchright@1.59.4` package. Full `pdpp-neko:local` now rebuilds `--no-cache` with no hang (extract ~1.8s); final image `chrome --version` → `Google Chrome for Testing 147.0.7727.15`. `PDPP_DOCKER_DYNAMIC_NEKO_ALLOCATOR_SMOKE=1 pnpm stream:no-human-verify` rebuilds/recreates the overlay and proves dynamic two-surface allocation (distinct ports 59101/59102) green. Also fixed two smoke-script bugs surfaced en route: the post-DELETE assertion was host-global (flaked to 9!==2 against other sessions' labeled surfaces) — now scoped to the surfaces the smoke created; and a masked-exit where `docker compose exec -T` heredoc could report exit 0 despite an inner assertion throw — now gated on an explicit success sentinel. **Residual: (a) physical real-phone smoke matrix only.**

## 13. Viewer Support Library Refactor

- [x] 13.1 Adopt `transformation-matrix` for coordinate transforms; do not keep `react-use-measure` or `hotkeys-js` unless they improve the shipped stream UX.
- [x] 13.2 Preserve the explicit stream-frame `ResizeObserver`/viewport listener pipeline because PDPP owns remote-resize policy, not the measurement hook.
- [x] 13.3 Move fit/contain pointer remapping onto matrix-based transforms and keep deterministic unit coverage for letterbox cases.
- [x] 13.4 Preserve native n.eko copy/cut/paste chord delivery and document why shortcut libraries are not used inside the streamed surface.
- [ ] 13.5 Re-run affected checks, rebuild/recreate the n.eko Docker overlay, and run public desktop plus real-phone smoke with debug telemetry. Affected no-human checks pass via `pnpm stream:no-human-verify` (matrix-transform coordinate/letterbox coverage lives in remote-surface units); public desktop + real-phone smoke with debug telemetry remains. Re-confirmed green 2026-06-01. Docker rebuild sub-gate now CLOSED (see 12.8 — patchright-chromium build hang fixed; `PDPP_DOCKER_DYNAMIC_NEKO_ALLOCATOR_SMOKE=1 pnpm stream:no-human-verify` rebuilds/recreates the overlay green); public desktop + real-phone smoke remain owner-run.

## 14. Stream Interaction Control Core

- [x] 14.1 Define the viewer control contract: normalized stream events, commands/effects, replay fixture shape, and telemetry redaction boundaries.
- [x] 14.2 Add runtime protocol validators for SSE payloads and n.eko status payloads, with deterministic tests.
- [x] 14.3 Add pure viewport/keyboard classification based on layout viewport, visual viewport, focus intent, orientation, safe-area, and optional VirtualKeyboard geometry, with Android/iOS-style fixtures.
- [x] 14.4 Add pure n.eko/WebRTC media settle logic that compares requested viewport, n.eko screen status, media intrinsic size, and inbound stats before marking a stream settled.
- [x] 14.5 Add a replay harness for stream viewer traces so real-device resize, keyboard, clipboard, reconnect, and wide-viewport regressions can be reproduced without manual browser testing.
- [x] 14.6 Integrate the protocol validators and control-core decisions into `stream-viewer.tsx` without changing the owner-facing UI.
- [ ] 14.7 Run affected unit checks, OpenSpec validation, Docker n.eko rebuild/recreate, and public desktop plus real-phone smoke with debug telemetry. Affected unit checks + OpenSpec validation pass via `pnpm stream:no-human-verify` (protocol validators, viewport/keyboard classification, media-settle, and replay-harness coverage all green in remote-surface units); Docker rebuild/recreate + public desktop + real-phone smoke remains. Re-confirmed green 2026-06-01. Docker rebuild sub-gate now CLOSED (see 12.8 — patchright-chromium build hang fixed; `PDPP_DOCKER_DYNAMIC_NEKO_ALLOCATOR_SMOKE=1 pnpm stream:no-human-verify` rebuilds/recreates the overlay green); public desktop + real-phone smoke remain owner-run.

## 15. Mobile Clipboard SLVP

- [x] 15.1 Research current 2026 mobile Clipboard API constraints and remote-desktop prior art, then capture the plan in `design-notes/mobile-clipboard-plan-2026.md`.
- [x] 15.2 Add a redacted clipboard capability/policy module that classifies browser support, owner gesture requirements, direction policy, and strict/balanced/assistive helper eligibility.
- [x] 15.3 Replace mobile raw Copy/Paste toolbar buttons with a Keyboard-first control set and a single Clipboard Sheet entry point once the sheet exists.
- [x] 15.4 Build the mobile Clipboard Sheet with host-to-remote paste field, Paste from Device enhancement, Send to Browser action, remote-to-host buffer, Copy to Device action, and manual selectable fallback.
- [x] 15.5 Rework remote clipboard SSE handling so mobile buffers remote text until a direct owner tap writes to the device clipboard, while desktop remains best-effort seamless.
- [x] 15.6 Keep n.eko `control.paste` as the primary paste path and gate CDP/page-level clipboard helpers behind non-strict assistive mode.
- [x] 15.7 Add deterministic tests and replay fixtures for Android Chrome, iOS Safari, mobile Firefox, desktop Chrome, desktop Safari, desktop Firefox, permission denied, multiline/Unicode text, password-like masking, and session cleanup.
- [ ] 15.8 Re-run affected checks, OpenSpec validation, Docker n.eko rebuild/recreate, and public desktop plus real-phone smoke focused on mobile clipboard. Affected checks + OpenSpec validation re-run green via `pnpm stream:no-human-verify` (clipboard-policy fixtures for all browser/permission/Unicode cases live in remote-surface units). Public desktop and Playwright mobile-emulated smoke passed previously; physical real-phone smoke remains. Re-confirmed green 2026-06-01. Docker rebuild sub-gate now CLOSED (see 12.8 — patchright-chromium build hang fixed; `PDPP_DOCKER_DYNAMIC_NEKO_ALLOCATOR_SMOKE=1 pnpm stream:no-human-verify` rebuilds/recreates the overlay green); physical real-phone mobile-clipboard smoke remains owner-run.

## 16. Visual Quality Telemetry

- [x] 16.1 Add pure pixel-fit telemetry for decoded media size, displayed CSS size, physical-pixel size, stretch ratio, gutter/empty-area ratio, and CSS/physical 1:1 flags.
- [x] 16.2 Add debug-only video sharpness sampling for contrast, Laplacian variance, Sobel edge energy, and edge density.
- [x] 16.3 Integrate visual-quality samples into the existing opt-in stream debug pipeline without changing the owner-facing stream UI.
- [x] 16.4 Document that pixel-fit is high-confidence, while sharpness metrics require a known calibration pattern for strict pass/fail decisions.

## 17. Mobile Stream UX Hardening

- [x] 17.1 Reuse the stream control-core reducer for local n.eko presentation remaps so orientation/browser-chrome transients hold instead of stretching the visible stream.
- [x] 17.2 Add mobile keyboard optimistic reacquire on owner gesture with rollback when the remote page does not confirm editable focus.
- [x] 17.3 Split CSS viewport dimensions from bounded high-DPR n.eko screen/capture dimensions and keep the backend CDP emulation CSS viewport stable.
- [x] 17.4 Add deterministic coverage for viewport authority, bounded capture target selection, keyboard reacquire wiring, and n.eko CSS-vs-capture backend behavior.
- [ ] 17.5 Re-run affected checks, rebuild/recreate the n.eko Docker overlay, and run public desktop plus real-phone smoke focused on keyboard reacquire, rotation settle, and visual sharpness. Affected checks re-run green via `pnpm stream:no-human-verify` (viewport-authority, bounded-capture, keyboard-reacquire, and CSS-vs-capture coverage in remote-surface units; live-CDP smoke proves frame/input/resize against real Chromium). Public raw-CDP desktop and mobile-emulated smokes passed previously with clean rotation/visual-quality/pointer telemetry; physical real-phone smoke remains. Re-confirmed green 2026-06-01. Docker rebuild sub-gate now CLOSED (see 12.8 — patchright-chromium build hang fixed; `PDPP_DOCKER_DYNAMIC_NEKO_ALLOCATOR_SMOKE=1 pnpm stream:no-human-verify` rebuilds/recreates the overlay green); physical real-phone keyboard/rotation/sharpness smoke remains owner-run.
- [x] 17.6 Add an automated owner-surface Docker/public smoke command for the n.eko stream playground that skips without a configured public URL and proves display, remote counter click, remote input, and telemetry capture when enabled.
