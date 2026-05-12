# neko-adapter.js Patchright Refactor Spec

Companion to `docs/patchright-integration-spec.md` (henceforth "the research spec"). Drives a same-day migration of `reference-implementation/server/streaming/neko-adapter.js` from hand-rolled CDP-over-WebSocket to Patchright's `chromium.connectOverCDP()`.

Pre-reading required: research spec §3 (Runtime.enable avoidance), §4 (Route init-script injection), §8 (anti-patterns), and §Bottom-line.

---

## Section 1 — Current adapter CDP surface area

All citations are line numbers in `reference-implementation/server/streaming/neko-adapter.js`.

### 1.1 Session establishment

| Step | Where | What |
|---|---|---|
| Resolve page target | `getNekoPageTarget` — 835–851 | HTTP GET `/json` against `cdpHttpUrl`, picks first `type=page` target, normalizes ws URL via `normalizeCdpWebSocketUrl` (108–114, rewrites loopback hostnames). |
| Resolve browser ws | `getNekoBrowserWebSocketUrl` — 853–859 | HTTP GET `/json/version`. |
| Open page WS | `getPageCdpConnection` — 871–901 | `new WebSocketCtor(wsUrl)` + `Target.attachToTarget { targetId, flatten:true }` (879–886). Stores resulting `sessionId`. |
| Open per-call browser WS | `sendBrowserCdp` — 861–869 | One-shot WS to browser-level target for each `Browser.*` call. |

Stealth gating: page-CDP connection is created only inside callers that are gated by `pageEmulationCdpAllowed` / `pageNavigationCdpAllowed` / `pageFocusCdpAllowed` / `assistivePageCdpAllowed`. With `stealthMode === 'strict'` all four are false (597–601) → no WS is ever opened (verified by test "strict stealth mode does not use CDP for viewport application", 338–355).

### 1.2 Auth to neko (HTTP only, not CDP)

`authenticate` — 649–671. POST `/api/login` with `{ username, password }`, harvests Set-Cookie and JSON `token`/`session`. Always runs regardless of stealth mode. **Out of scope for this refactor** — Patchright connects to the CDP endpoint directly, not through neko's auth-gated HTTP. (See §5.)

### 1.3 Navigation

| CDP | Where | Gating |
|---|---|---|
| `Page.navigate { url }` | `applyInitialNavigation` — 1108 | `pageNavigationCdpAllowed` (balanced + assistive). |

No `Page.enable` is explicitly sent before navigate; the page session is freshly attached so Chromium accepts `Page.navigate` without prior enable.

### 1.4 Viewport / screen configuration

| CDP | Where | Gating |
|---|---|---|
| `Browser.getWindowForTarget` | 1021, 1198 | `browserWindowCdpAllowed` (balanced + assistive). |
| `Browser.setWindowBounds` | 1023–1037 | same. |
| `Emulation.setDeviceMetricsOverride` | 1045–1060 | `pageEmulationCdpAllowed`. |
| `Emulation.setTouchEmulationEnabled` | 1068–1072 | same. |
| `Emulation.setEmitTouchEventsForMouse` | 1073–1077 | same. |
| `Emulation.setUserAgentOverride` | 1086 | `assistivePageCdpAllowed` only. |

Plus a non-CDP path: `applyScreenConfigurationBestEffort` — 964–1002 hits neko's `api/room/screen/configurations` + `api/room/screen` HTTP endpoints to size the X server. That stays as-is.

### 1.5 Focus-detection binding (the tricky one)

`setupFocusDetectionBestEffort` — 926–949. Sequence on the page session:

1. `Runtime.enable` (930)
2. `Page.enable` (931)
3. `Runtime.addBinding { name: '__pdppNekoFocusChanged' }` (932)
4. `Page.addScriptToEvaluateOnNewDocument { source }` with `buildFocusDetectionScript()` body (934) — script attaches focusin/focusout listeners and calls `window.__pdppNekoFocusChanged(JSON.stringify(payload))`.
5. `Runtime.evaluate { expression: source }` to also run it on the *current* page (935).

Inbound binding events flow through `handlePageCdpEvent` — 908–924, which filters `Runtime.bindingCalled` and emits `{ kind: 'keyboard_focus', ... }`.

This is the single biggest stealth offender — see research spec §3, §5, §8 rules 1 and 3.

### 1.6 Page-state polling (status endpoint, assistive only)

| CDP | Where |
|---|---|
| `Runtime.evaluate { expression: buildViewportStatusExpression(), returnByValue:true }` | `readPageViewportStatus` — 1153–1169, called from `queryNekoStatus` 1220. |
| `Runtime.evaluate { expression: buildCopySelectionExpression(), returnByValue:true }` | `copySelectionViaCdp` — 1139. |
| `Input.insertText { text }` | `insertTextViaCdp` — 1121. |

### 1.7 Input forwarding

The adapter does **not** forward pointer/keyboard input through CDP. All routine input goes through neko's HTTP `inputEndpoint` (1418–1421) — neko's WebRTC layer reads it and synthesizes real OS-level events at the X server. The only "direct" inputs are `paste`/`copy` (1402–1416), gated by `assistivePageCdpAllowed`.

### 1.8 Window/screen resize handling

Same path as §1.4: `applyViewportBestEffort` (1261–1310) → screen config HTTP → `applyCdpViewportBestEffort`. Re-invoked on every `{ type: 'viewport' }` dispatch (1395–1399) and once at start (1367) plus a re-apply after navigation (1369–1375).

There is also a stale-metrics self-healing path inside `queryNekoStatus` — 1222–1241 — that closes the page session and re-runs `applyCdpViewportBestEffort` when `pageMetricsMismatch` flags drift.

### 1.9 Session termination

`stop` — 1383–1392: aborts the poll loop, calls `closePageCdpConnection` (951–962), clears handler sets. No explicit `Target.detachFromTarget` or `Browser.close` — closing the WebSocket is enough.

### 1.10 Anti-patterns currently present

Cross-referenced against research spec §8:

- **Rule 1 violation**: `Runtime.enable` at line 930 — top fingerprint signal.
- **Rule 3 violation**: `Page.addScriptToEvaluateOnNewDocument` at lines 934 — bypasses Patchright's Route injection.
- **Rule 10 risk**: no `Page.createIsolatedWorld`, but the side-CDP session against the same target that Patchright will manage creates a duplicate-session risk if both run concurrently.
- **Rule 12 borderline**: `Target.attachToTarget` at line 879 uses `flatten:true` — OK by itself, but conflicts with Patchright's rootSession `setAutoAttach` if both are live.

---

## Section 2 — Map each operation to Patchright API

Assume module-level `import { chromium } from 'patchright';`. Session bootstrap:

```
const browser = await chromium.connectOverCDP(cdpHttpUrl); // e.g. http://neko:9223 or http://neko:9222
const [context] = browser.contexts();                       // existing default context
let [page] = context.pages();                               // pre-existing page, if any
if (!page) page = await context.newPage();
```

Per research spec §4c we must **attach first, then navigate**, so that init scripts and Route interception arm before any HTML loads.

### 2.1 Operations table

| Operation | Current (neko-adapter.js) | Patchright |
|---|---|---|
| Resolve page target | HTTP `/json` poll + `Target.attachToTarget` (837–886) | `context.pages()` returns hydrated `Page` instances; auto-attach is already on (research spec §2a). |
| Browser-level resize | `Browser.getWindowForTarget` + `Browser.setWindowBounds` (1021–1037) | **No first-class Patchright API.** Use `await page.setViewportSize({width, height})` for the page surface. For the OS-level window/X-screen, keep the HTTP `api/room/screen` path (1.4 HTTP step) — that's what actually resizes the X display anyway. See §3 for the gap. |
| Device metrics override | `Emulation.setDeviceMetricsOverride` (1045) | `await page.setViewportSize({ width, height })` covers width/height. For deviceScaleFactor / mobile / hasTouch / screenWidth/screenHeight, Playwright only allows these at `newContext`/`launchPersistent` time — **not** changeable on an attached context. Options: (a) accept that these are fixed by the neko container start args; (b) drop to raw CDP via `context.newCDPSession(page).send('Emulation.setDeviceMetricsOverride', …)`. See §3. |
| Touch emulation | `Emulation.setTouchEmulationEnabled` (1068) | Same constraint — no high-level API on an existing context. CDP escape hatch only. |
| Emit-touch-for-mouse | `Emulation.setEmitTouchEventsForMouse` (1073) | CDP escape hatch only. |
| UA override | `Emulation.setUserAgentOverride` (1086) | Same constraint, but `await page.evaluate(() => { Object.defineProperty(navigator, 'userAgent', { get: () => '…' }); })` inside an `addInitScript` is the stealthier pattern. Likely just drop this entirely under Patchright (the bundled UA is already realistic — research spec §7). |
| Navigate to URL | `Page.navigate { url }` (1108) | `await page.goto(url, { waitUntil: 'load' })`. Patchright handles `Page.enable` internally; no re-apply of metrics is needed after navigate if metrics live on the context (the historical reason for the 1369–1375 re-apply was that target-scoped emulation drops on cross-process nav — Patchright's persistent emulation survives). |
| Focus binding | `Runtime.enable` + `Runtime.addBinding` + `Page.addScriptToEvaluateOnNewDocument` + `Runtime.evaluate` (930–935) | `await context.exposeBinding('__pdppNekoFocusChanged', (_source, payloadJson) => handleFocusPayload(payloadJson))` plus `await context.addInitScript(buildFocusDetectionScript())`. **Both attach to all current and future pages.** No Runtime.enable is sent (research spec §3, §5). The init script source can stay byte-identical — `window.__pdppNekoFocusChanged` will be defined by `exposeBinding`. For pre-existing pages that already loaded before attach, also do one `page.evaluate(buildFocusDetectionScript())` for parity with the current 935 call. |
| Drain viewport status | `Runtime.evaluate { expression: buildViewportStatusExpression(), returnByValue:true }` (1153) | `await page.evaluate(buildViewportStatusExpression)` — pass the function directly or wrap as `() => (eval(buildViewportStatusExpression()))`. Patchright's `page.evaluate` does **not** require Runtime.enable (research spec §3b). |
| Copy selection | `Runtime.evaluate { expression: buildCopySelectionExpression(), returnByValue:true }` (1139) | `await page.evaluate(buildCopySelectionExpression)` (same). |
| Paste text | `Input.insertText { text }` (1121) | `await page.keyboard.insertText(text)`. |
| Page metrics mismatch self-heal | Close session + re-apply (1222–1241) | Largely unnecessary — Patchright's context-level emulation persists across navs. If we still want a safety net, call `await page.setViewportSize(...)` again. The "close & re-attach" leg goes away. |
| Session teardown | Close raw WS (951–962, 1383–1392) | `await browser.close()` (disconnects; does NOT kill the remote browser since we attached). |

### 2.2 The exposeBinding callback adapter

The current binding fires with `params.payload` as a JSON string (line 913). With `context.exposeBinding(name, fn)`, Patchright calls `fn(source, ...args)` where `args` are the JSON-serializable args the page passed to `window.__pdppNekoFocusChanged(...)`. Since the in-page script already does `binding(JSON.stringify(payload))` (line 250 in `buildFocusDetectionScript`), the callback receives one string arg. Keep `JSON.parse` + `emitEvent({ kind: 'keyboard_focus', ... })` logic — only the transport changes.

---

## Section 3 — Operations with no Patchright equivalent

### 3.1 `Browser.setWindowBounds` (1023–1037)

No Patchright API. **Recommendation (c) — handle outside the adapter.** Resizing the X display already happens through neko's HTTP `api/room/screen` endpoint (`applyScreenConfigurationBestEffort`, 964–1002), which is what actually changes the WebRTC frame dimensions the user sees. The `Browser.setWindowBounds` call was an inside-the-browser cosmetic adjustment that piggybacked on CDP availability. Drop it. If aspect-ratio bugs surface, revisit with `context.newCDPSession(page).send('Browser.setWindowBounds', …)` (escape hatch (b)).

### 3.2 `Emulation.setDeviceMetricsOverride` with `deviceScaleFactor` / `screenWidth` / `screenHeight`

`page.setViewportSize` only sets width/height. Playwright/Patchright treat `deviceScaleFactor` and screen dimensions as immutable per-context properties set at context creation. We are attaching to a pre-existing context, so we cannot set them.

But: `reference-implementation/server/streaming/routes.js:224-238` (`normalizeViewportForNeko`) already pins `deviceScaleFactor: 1`, `screenWidth = width`, `screenHeight = height` for every n.eko viewport. So in practice the only varying field we care about is width/height — which `page.setViewportSize` handles perfectly. **Recommendation (a) — skip the DPR/screen knobs at the adapter layer.** The routes-layer normalization makes this safe.

Edge case: the tests pass `deviceScaleFactor: 2.25` and asymmetric screenWidth/height. After the refactor those test inputs become moot because routes.js flattens them before they reach the companion. We will need to update the tests (see §6) to assert the post-Patchright contract: `setViewportSize` is called with width/height, no DPR.

### 3.3 `Emulation.setTouchEmulationEnabled` / `setEmitTouchEventsForMouse`

No Patchright API. Two routes:

- **(a) Skip.** The neko frontend forwards real OS pointer events from the user's tap/click on the WebRTC video to the X server; there is no "synthetic touch from mouse" use case the way there is in headless test runs. Touch emulation was set up because the old CDP-driven world demanded it — under Patchright with real native input, it's redundant.
- **(b) Escape hatch** via `context.newCDPSession(page)` if a connector actually needs synthetic touch. **Cost:** the new CDP session must avoid `Runtime.enable` / `Console.enable` / `Network.enable` (research spec §8 rules 1, 2). `Emulation.*` commands are safe — they don't trigger those.

Recommend (a). Keep (b) as a comment-noted escape hatch in code.

### 3.4 `Emulation.setUserAgentOverride`

Drop entirely. Patchright Chromium 147 has a realistic UA; overriding it adds an inconsistency vector (UA says X, navigator.userAgentData says Y).

### 3.5 Read `Browser.getWindowForTarget` in `queryNekoStatus`

Used to surface windowId in the diagnostic status response (1198–1203). **Drop.** Replace with `page.url()`, `page.title()`, and `page.viewportSize()` — all sync or single-promise calls. The dashboard /neko/__pdpp/status JSON shape changes; routes.js consumer only checks `status.page_cdp_available` and forwards `status` opaquely, so the shape change is internal.

---

## Section 4 — stealthMode handling

Today (54–58, 597–601):
- `strict` → no CDP at all (no viewport, no nav, no focus, no paste/copy)
- `balanced` → viewport + nav + focus binding via CDP; no paste/copy
- `assistive` → all of the above + paste/copy + UA override

Under Patchright:
- The fingerprint cost of `balanced` was almost entirely `Runtime.enable` + `Page.addScriptToEvaluateOnNewDocument` from the focus binding setup. Patchright eliminates both (research spec §3, §4).
- `page.goto`, `page.setViewportSize`, `context.exposeBinding`, `context.addInitScript`, `page.keyboard.insertText`, `page.evaluate` all run under Patchright's stealth driver path — they are roughly equivalent in observability to "no CDP at all" from the page-script POV.
- The one residual delta is `Page.enable` (unavoidable, sent lazily by Patchright per-page — research spec §3c) and `Fetch.enable` (always on, for route-based injection — §4a). Both fire whether stealthMode is "balanced" or "assistive". `strict` cannot suppress them without breaking Patchright itself.

**Recommendation: collapse to two modes.**

- **`strict`** = read-only viewer. No `connectOverCDP` at all — adapter never opens a CDP path. Used when the connector says "do not introspect the page at all; just stream it." All assistive features unavailable (no focus events, no paste/copy, no viewport CDP).
- **`assistive`** (rename current `balanced`+`assistive` into one) = Patchright attached. Focus binding, viewport setViewportSize, navigation, paste/copy, viewport-status polling all available. Default.

Justify-the-collapse: under Patchright there is no meaningful "balanced" middle — once you attach via `connectOverCDP`, you've paid the entire stealth-cost (which is now near-zero) and gained full driver access. Splitting features across modes is operationally complex and saves nothing.

Migration: the existing `STEALTH_MODES` set drops `'balanced'`. Anything that passes `balanced` is mapped to `assistive` with a deprecation log line. `normalizeStealthMode` keeps `strict` as the default for `browser-owner` mode and `assistive` for `neko-owned`.

---

## Section 5 — The cdp-proxy.py question

### 5.1 Does Patchright work through cdp-proxy.py?

`connectOverCDP` flow (research spec §2): HTTP GET `/json/version` → parse `webSocketDebuggerUrl` → open WS. The current adapter already proxies this exact discovery via `cdpHttpUrl` (e.g. http://neko:9223) and normalizes loopback hostnames to the proxy hostname (line 105–115). Patchright's `urlToWSEndpoint` (research spec, `chromium.js:342-361`) does no extra header rewriting — it just hits `/json/version` and uses whatever `webSocketDebuggerUrl` the server returns.

**Expected outcome:** Patchright works through cdp-proxy.py as long as the proxy:
1. Returns a `webSocketDebuggerUrl` that resolves from the Patchright-runtime side (i.e. either rewrites it to the proxy hostname, or returns a path-only URL Patchright can compose). The current adapter relies on its own `normalizeCdpWebSocketUrl` for this — **Patchright will not call that**, so the proxy must return a resolvable URL itself. Verify in cdp-proxy.py that the `/json/version` response is rewritten host-side; if not, that becomes a one-line fix.
2. Holds the WS connection open. Research spec hints at "per-request Connection: close" in cdp-proxy.py — that affects HTTP discovery only, not the upgraded WS. Should be fine.

### 5.2 Can we eliminate cdp-proxy.py?

cdp-proxy.py exists because neko's chromium binds CDP to localhost inside the container. Two ways to drop it:

- **(a) Bind chromium to 0.0.0.0:9222 inside the neko container** (via `start-chromium.sh`) and expose 9222 directly on the docker network. Patchright connects to `http://neko:9222`. **Risks:** any container on the docker network could attach a debugger; in our deployment that network is private, so it's an acceptable trade. Also: CDP servers historically only accept connections with `Host: localhost`/`127.0.0.1` — Chromium since ~v92 honors `--remote-debugging-address`; verify the start args.
- **(b) Keep cdp-proxy.py for the Host-header rewrite (Chromium's default `Host` check is the main reason the proxy exists) and let Patchright go through it unchanged.**

**Recommendation: keep cdp-proxy.py for now (b).** It costs nothing once Patchright drives all the chatter, and removes one variable from the migration. After the refactor stabilizes, a follow-up can attempt the direct-bind path.

One thing to verify before merging: research spec §4 notes that Patchright relies on a long-lived `Fetch.enable` event stream for init-script injection. cdp-proxy.py must not coalesce or drop CDP event frames. If it does, Route injection silently fails (init scripts won't fire). Test: after the refactor wires up, `await page.addInitScript(() => { window.__pdppCanary = true; })`, navigate to a fresh URL, then `page.evaluate('window.__pdppCanary')` must return `true`. If it returns `undefined`, the proxy is eating Fetch events and we need to bypass it.

---

## Section 6 — Test surgery (`neko-adapter.test.js`)

The test file inspects raw CDP wire output via the `WebSocketCtor.commands` capture. Under Patchright, that wire is owned by `patchright-core`; we cannot mock it the same way without mocking patchright itself.

Two strategies:

1. **Mock `patchright`'s `chromium.connectOverCDP`** to return a fake `Browser` with stubbed `Page` methods. Tests assert on `page.setViewportSize`, `page.goto`, `context.exposeBinding`, etc. calls. This is the right level for unit tests; the wire is no longer ours.
2. **Promote the wire-level tests to integration** against a real Chromium instance, run only when `PDPP_INTEGRATION_NEKO=1`.

Recommend (1) for the bulk, (2) for one smoke test.

Per-test disposition:

| # | Test (line) | Disposition |
|---|---|---|
| 1 | "reapplies page CDP viewport after initial navigation" (144) | **Update.** Patchright's emulation persists across nav; the historical re-apply leg goes away. New assertion: `page.goto` is called after `page.setViewportSize`, and `setViewportSize` is called exactly once. |
| 2 | "high-DPR CDP viewport exposes the full captured surface" (185) | **Delete.** Routes.js's `normalizeViewportForNeko` flattens DPR to 1 before the companion sees it; the DPR contract is moot. The touch-emulation assertions (218–235) — also delete; touch emulation drops per §3.3. |
| 3 | "status reopens page CDP and reapplies viewport when page metrics mismatch" (237) | **Update.** "Reopen page CDP" disappears (no session to reopen). New assertion: when `page.evaluate(viewportStatusExpression)` returns mismatched dimensions, the companion calls `page.setViewportSize` again and the next status read is correct. |
| 4 | "desktop status does not reapply only because Chromium reports stale touch support" (291) | **Update.** Keep the behavioral contract ("ignore stale touch flag, don't loop") but assert against Patchright mock: `setViewportSize` count does not increase between status reads. |
| 5 | "strict stealth mode does not use CDP for viewport application" (338) | **Update.** New assertion: in strict mode, `chromium.connectOverCDP` is never called. (Drop the `WebSocketCtor.commands` check.) |
| 6 | "status drains playgroundEvents from the remote ring buffer" (357) | **Keep (logic), update (wire).** The `__pdppPlaygroundEvents` drain behavior is a contract; rewrite the assertion to verify `page.evaluate` is called with the viewport-status expression and that the returned `playgroundEvents` round-trip. |
| 7 | "buildViewportStatusExpression drains __pdppPlaygroundEvents and includes screenWidth" (421) | **Keep as-is.** Pure string-shape assertion on the expression builder. The builder doesn't change. |

Count: **2 kept, 4 updated, 1 deleted.** New tests to add:
- Patchright is **not** called when `stealthMode === 'strict'`.
- `context.exposeBinding('__pdppNekoFocusChanged', …)` is called exactly once on attach.
- Focus init script is registered via `context.addInitScript`, not `Page.addScriptToEvaluateOnNewDocument`.
- After `start()`, `page.goto(navigationUrl)` runs strictly after `exposeBinding` + `addInitScript` (init scripts must arm before navigation — research spec §4c).

---

## Section 7 — Risk register

1. **Pre-existing pages don't get init scripts.** Per research spec §4c, scripts only inject for navigations AFTER attach. If the neko container starts chromium with an autoload URL, focus-detection on that page will rely on the `page.evaluate(source)` fallback (the current line 935 equivalent). **Mitigation:** in `start-chromium.sh`, set start URL to `about:blank` and let our adapter drive the first `page.goto`.
2. **Race between Patchright and any remaining raw CDP.** If we ship Patchright *and* the old `sendPageCdp` paths in parallel (flag-gated), the second session will send `Runtime.enable` / etc. and undo Patchright's stealth (research spec §8 rule 9). **Mitigation:** delete the raw-CDP code in the same change that enables Patchright. No parallel mode. The implementation plan in §8 uses a build-time flag, not a runtime flag.
3. **cdp-proxy.py Fetch-event coalescing.** If the proxy drops or batches `Fetch.requestPaused` events, Patchright's Route-based init-script injection silently fails. **Mitigation:** the canary-init-script test described at the end of §5.2. Run it once after wiring up; if it fails, bypass cdp-proxy.py via direct neko:9222 binding (§5.2.a).
4. **`Browser.setWindowBounds` removal causes visual regressions.** If neko's X-server resize doesn't actually move the inner Chromium window (because the window manager isn't aware), the WebRTC frame might letterbox. **Mitigation:** in the neko container, ensure the window manager is configured to fullscreen-and-resize the chromium window when the X-screen resizes. This may already be handled by neko's startup scripts; verify.
5. **Test mocks for `patchright`**. Mocking the entire `patchright` module is heavier than mocking a WebSocket. **Mitigation:** introduce a thin internal `createNekoBrowserClient` abstraction that the adapter depends on; tests inject a fake. Keeps the adapter coupling to Patchright in one place.
6. **`page.evaluate` of a function vs string**. The current builders return source strings (e.g. `buildViewportStatusExpression`). Playwright's `page.evaluate` prefers a function. Two options: (a) wrap as `page.evaluate(`(${source})`)` keeping the string semantics; (b) rewrite builders to export functions. (a) is the surgical choice.
7. **`exposeBinding` collision across reconnects.** If the adapter `start()` runs twice on the same browser context (e.g. a reconnect), `exposeBinding` with the same name throws. **Mitigation:** wrap in try/catch and ignore the "binding already exists" error, or track a singleton flag on the context.

---

## Section 8 — Step-by-step refactor plan

Each step is mechanical and independently testable.

1. **Add `patchright` to the workspace.** It's already in `node_modules` (1.59.4). Confirm `reference-implementation/package.json` declares it; if not, `pnpm add patchright` in that package.
2. **Verify Patchright Chromium is available in the neko container.** Per research spec §7, `pnpm exec patchright install chromium` writes to `~/.cache/ms-playwright/chromium-1217`. Update neko's Dockerfile to install Patchright's binary into a known path and have `start-chromium.sh` invoke it (research spec, action note at end of §1d). **Out of scope for this file but blocker for end-to-end test** — track as a sibling task.
3. **Introduce `createNekoBrowserClient(opts)` abstraction** (new file `reference-implementation/server/streaming/neko-browser-client.js`). Wraps `chromium.connectOverCDP` and exposes the minimal surface the adapter needs: `connect()`, `getPage()`, `setViewportSize(p)`, `goto(url)`, `evaluate(source)`, `exposeBinding(name, fn)`, `addInitScript(source)`, `keyboard.insertText(text)`, `close()`. Pure passthrough; lets tests inject a fake.
4. **Wire `createNekoBrowserClient` into `createNekoCompanion` behind a feature gate** `PDPP_NEKO_USE_PATCHRIGHT=1`. When set, the new code path runs; when unset, the existing raw-CDP path runs. This is build-time-only (env at process start), not per-request — see Risk #2.
5. **Migrate operations one-for-one** following §2.1 table:
   1. `getNekoPageTarget` + `getPageCdpConnection` → `client.connect()` + `client.getPage()`.
   2. `applyCdpViewportBestEffort` → `client.setViewportSize({ width, height })`. Delete touch / UA / Browser.setWindowBounds branches.
   3. `applyInitialNavigation` → `client.goto(navigationUrl)`.
   4. `setupFocusDetectionBestEffort` → `client.exposeBinding(FOCUS_BINDING_NAME, payloadHandler)` + `client.addInitScript(buildFocusDetectionScript())` + one-shot `client.evaluate(buildFocusDetectionScript())` for the current page.
   5. `readPageViewportStatus` → `client.evaluate(buildViewportStatusExpression())`.
   6. `copySelectionViaCdp` → `client.evaluate(buildCopySelectionExpression())`.
   7. `insertTextViaCdp` → `client.keyboard.insertText(text)`.
   8. `closePageCdpConnection` + `stop` cleanup → `client.close()`.
6. **Collapse stealthMode.** Drop `'balanced'` from `STEALTH_MODES`; map incoming `'balanced'` to `'assistive'` with a `safeLog(logger, 'warn', 'neko_stealth_balanced_deprecated', …)`. Remove the `pageNavigationCdpAllowed` / `pageEmulationCdpAllowed` / `pageFocusCdpAllowed` distinctions — gate everything on `cdpControlAvailable && stealthMode !== 'strict'`.
7. **Run unit tests (§6).** Update them as you go: a new test file `neko-adapter.test.js` that mocks `createNekoBrowserClient`. Keep #7 (the byte-shape assertion on `buildViewportStatusExpression`) verbatim.
8. **Run the canary init-script test** (§5.2): boot a real neko container, attach via Patchright, addInitScript a `window.__pdppCanary = true` flag, navigate, verify the flag is set. If it fails, fall back to direct neko:9222 binding (§5.2.a) and re-test.
9. **Smoke-test the focus binding end-to-end** in a dev environment: load a page with a text input, click into it, verify `keyboard_focus` event arrives at the SSE viewer.
10. **Delete the old code path.** Remove `getPageCdpConnection`, `sendPageCdp`, `sendBrowserCdp`, `createCdpConnection`, `handlePageCdpEvent`, `normalizeCdpWebSocketUrl`, `closePageCdpConnection`, all CDP-allowed booleans. Flip `PDPP_NEKO_USE_PATCHRIGHT` to default-on by removing the gate. Re-run tests.
11. **Update `routes.js` if needed.** `routes.js:794-808` reads `companion.backend`, `companion.browserOwnerMode()`, `companion.stealthMode()` — those still work. `getNekoProxyTarget` still returns `{ origin }` — unchanged. No route changes required; this refactor is internal to the adapter.
12. **Grep for stragglers.** `rg 'Runtime\.(enable|addBinding)|Page\.addScriptToEvaluateOnNewDocument|setDeviceMetricsOverride|Browser\.(getWindowForTarget|setWindowBounds)|Emulation\.(setTouchEmulationEnabled|setEmitTouchEventsForMouse|setUserAgentOverride)'` across `reference-implementation/` to confirm no other module reintroduces the patterns. Per the workflow rule in `~/.claude/CLAUDE.md`: this verification is mandatory before declaring done.
13. **Commit.** One commit. Title: "Replace neko-adapter raw CDP with Patchright connectOverCDP". Body cites this spec and the research spec.

---

## Open questions to resolve during execution

- **Q1:** Does cdp-proxy.py rewrite `webSocketDebuggerUrl` in its `/json/version` response? If not, Patchright won't be able to dial through it without the per-call hostname rewrite the current adapter does in `normalizeCdpWebSocketUrl`. Fix at proxy layer, not adapter.
- **Q2:** Does the neko window manager fullscreen-fit the chromium window after an X-screen resize? If not, dropping `Browser.setWindowBounds` will letterbox; fix in neko container config.
- **Q3:** Do we want to keep `queryNekoStatus`'s window-info diagnostic at all, given there's no `windowId` to surface? Likely replace with `{ page: { url, title, viewport: page.viewportSize() } }`.

These are intentionally not pre-resolved — they want a live test against a real neko stack before locking in.
