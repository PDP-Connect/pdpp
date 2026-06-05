## 1. Browser-Client Seam

- [x] 1.1 Add a small n.eko browser-client module around Patchright `chromium.connectOverCDP` with injected/fakeable dependencies for tests.
- [x] 1.2 Expose only the adapter operations needed by n.eko: connect, get page, set viewport size, navigate, add init script, expose binding, evaluate, keyboard insert text, and close/disconnect.
- [x] 1.3 Add unit tests for the browser-client seam, including current-page script evaluation and disconnect behavior.

## 2. n.eko Adapter Refactor

- [x] 2.1 Wire assistive n.eko mode through the browser-client seam for initial navigation and page viewport sizing.
- [x] 2.2 Replace focus detection with browser-client `exposeBinding`, `addInitScript`, and one current-page evaluate fallback.
- [x] 2.3 Replace page status and copy helpers with browser-client evaluate calls.
- [x] 2.4 Replace fallback paste insertion with browser-client keyboard insert text.
- [x] 2.5 Preserve n.eko HTTP screen configuration, frame polling, token-scoped proxying, and native input dispatch.
- [x] 2.6 Keep strict/browser-owner mode page-attach-free for baseline viewing and input.
- [x] 2.7 Normalize `balanced` to the assistive path or return an operator-actionable compatibility error; do not keep it as a raw-CDP helper posture.
- [x] 2.8 Remove routine adapter-owned raw page-CDP helper code from `neko-adapter.js`.

## 3. Posture Tests

- [x] 3.1 Update n.eko adapter tests to assert strict mode never connects the browser client.
- [x] 3.2 Update n.eko adapter tests to assert assistive mode calls browser-client methods for navigation, viewport, focus, status, copy, and paste.
- [x] 3.3 Add a static grep or allowlist test proving n.eko routine controls do not send `Runtime.enable`, `Runtime.addBinding`, direct `Page.addScriptToEvaluateOnNewDocument`, `Browser.setWindowBounds`, direct `Emulation.setUserAgentOverride`, or direct device/touch emulation commands.
- [x] 3.4 Preserve or replace existing geometry/status regression coverage so viewport and media-settle behavior remain falsifiable without live browsers.

## 4. Gated Smoke Checks

- [ ] 4.1 If a local n.eko stack is available, run a canary smoke proving Patchright can connect through the configured CDP proxy, add an init script, navigate, and read the canary value after navigation.
- [ ] 4.2 If owner hardware is available, run a short n.eko stream smoke for tap/click, keyboard focus, paste, resize/orientation, and reconnect; record any failures as residual risks rather than blocking code-level posture cleanup.

## 5. Validation

- [x] 5.1 Run the focused n.eko/streaming test set.
- [x] 5.2 Run relevant typecheck/check commands for touched packages.
- [x] 5.3 Run `openspec validate consolidate-neko-patchright-browser-posture --strict`.
- [x] 5.4 Run `openspec validate --all --strict`.
- [x] 5.5 Grep the touched files for old raw-CDP helper patterns and read every touched file before claiming completion.
