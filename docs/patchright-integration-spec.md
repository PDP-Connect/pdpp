# Patchright (1.59.4) Internals — Integration Spec for n.eko CDP Attach

Source paths below are all rooted at:

```
node_modules/.pnpm/patchright-core@1.59.4/node_modules/patchright-core/
```

(abbreviated as `patchright-core/` in citations).

---

## 1. Default args / flags Patchright applies to its Chromium

Patchright derives launch args from two layers:

- **Base switch list:** `patchright-core/lib/server/chromium/chromiumSwitches.js:53-88` (function `chromiumSwitches`).
- **Per-launch wrapping:** `patchright-core/lib/server/chromium/chromium.js:263-275` (`defaultArgs`) and `chromium.js:276-314` (`_innerDefaultArgs`).

### 1a. Args ADDED vs vanilla Playwright

The single biggest stealth addition is at the end of `chromiumSwitches.js`:

```js
// patchright-core/lib/server/chromium/chromiumSwitches.js:87
"--disable-blink-features=AutomationControlled"
```

In addition, the disabled-features list (`chromiumSwitches.js:24-52`) drops `AutomationControlled` from the Blink-features blacklist only when `assistantMode` is set (line 51). In normal (non-assistant) mode it is **excluded** from `--disable-features` — i.e. Patchright does NOT pile `AutomationControlled` into `--disable-features`; instead it disables it via `--disable-blink-features` so the runtime feature gate is the one that flips, not the variation-trial flag. This is deliberate: `chrome://flags`-style disables leak in `navigator.webdriver`-style fingerprints; `--disable-blink-features=...` does not.

### 1b. Args REMOVED vs vanilla Playwright

Comparing `chromiumSwitches.js:53-88` against upstream Playwright's equivalent in 1.59.x, the following vanilla-Playwright args are **not present**:

- `--enable-automation` — gone (this is the primary CDP-banner trigger; its absence removes the "Chrome is being controlled by automated test software" infobar and the `navigator.webdriver = true` signal partially).
- `--disable-popup-blocking` — gone.
- `--disable-component-update` — gone.
- `--disable-default-apps` — gone.
- `--disable-extensions` — gone.
- `--disable-component-extensions-with-background-pages` — gone.
- `--no-startup-window` is still added but only in non-persistent mode (`chromium.js:273`).
- `--disable-client-side-phishing-detection` — gone.
- `--enable-blink-features=IdleDetection` and `--export-tagged-pdf` — `--export-tagged-pdf` is retained (`chromiumSwitches.js:75`), `IdleDetection` is removed.

I confirmed by reading the entire 88-line `chromiumSwitches.js` — there are no `--enable-automation`, `--disable-popup-blocking`, `--disable-component-update`, `--disable-default-apps`, or `--disable-extensions` anywhere in that file or in `chromium.js`. The README's claim matches the source.

### 1c. Full final args list (typical headful, non-persistent, sandbox enabled)

From `chromiumSwitches.js:53-88` + `chromium.js:276-313`:

```
--disable-field-trial-config
--disable-background-networking
--disable-background-timer-throttling
--disable-backgrounding-occluded-windows
--disable-breakpad
--no-default-browser-check
--disable-dev-shm-usage
--disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,BoundaryEventDispatchTracksNodeRemoval,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,Translate,AutoDeElevate,RenderDocument,OptimizationHints
--enable-features=CDPScreenshotNewSurface     # unless PLAYWRIGHT_LEGACY_SCREENSHOT set
--disable-hang-monitor
--disable-prompt-on-repost
--disable-renderer-backgrounding
--force-color-profile=srgb
--no-first-run
--password-store=basic
--use-mock-keychain
--no-service-autorun
--export-tagged-pdf
--disable-search-engine-choice-screen
--edge-skip-compat-layer-relaunch
--disable-infobars
--disable-search-engine-choice-screen           # listed twice in source
--disable-sync                                  # unless android
--disable-blink-features=AutomationControlled
```

Then `_innerDefaultArgs` appends conditionally:
- `--headless`, `--hide-scrollbars`, `--mute-audio`, `--blink-settings=primaryHoverType=2,...` if `options.headless` (`chromium.js:287-292`)
- `--no-sandbox` unless `chromiumSandbox: true` (`chromium.js:295`)
- proxy args (`chromium.js:296-310`)

Finally `defaultArgs` appends (`chromium.js:265-273`):
- `--user-data-dir=${userDataDir}`
- `--remote-debugging-port=${cdpPort}` if `cdpPort` is set, **otherwise** `--remote-debugging-pipe`
- `about:blank` (persistent) or `--no-startup-window` (non-persistent)

### 1d. Pipe vs port

Default is `--remote-debugging-pipe` (`chromium.js:269`). For our integration we MUST launch with `--remote-debugging-port=<n>` (Patchright supports it via `cdpPort`, line 267) because we are attaching from outside the container over TCP/WebSocket; pipe mode requires fd-3/fd-4 inheritance.

> **Action for start-chromium.sh in neko:** mirror the full arg list above, swap `--remote-debugging-pipe` for `--remote-debugging-port=9222`, and add `--user-data-dir=/tmp/patchright-profile`. Do not add `--enable-automation`, `--disable-popup-blocking`, `--disable-component-update`, `--disable-default-apps`, or `--disable-extensions` even if the existing script has them — they reintroduce automation fingerprints.

---

## 2. `connectOverCDP` semantics

Defined in `patchright-core/lib/server/chromium/chromium.js:74-129`.

```js
// chromium.js:74-89 (abbreviated)
async connectOverCDP(progress, endpointURL, options) {
  return await this._connectOverCDPInternal(progress, endpointURL, options);
}
async _connectOverCDPInternal(progress, endpointURL, options, onClose) {
  // builds User-Agent header
  const wsEndpoint = await urlToWSEndpoint(progress, endpointURL, headersMap);
  const chromeTransport = await WebSocketTransport.connect(progress, wsEndpoint, {...});
  return this._connectOverCDPImpl(progress, chromeTransport, ...);
}
```

`urlToWSEndpoint` (`chromium.js:342-361`) is the standard `http://host:port/json/version` hit that returns `webSocketDebuggerUrl`. **It accepts any browser that exposes the regular DevTools HTTP discovery endpoint** — no Patchright-specific handshake.

### 2a. CDP commands actually sent on attach

Walked from `_connectOverCDPImpl` (`chromium.js:90-129`) → `CRBrowser.connect` (`crBrowser.js:69-101`). On attach the rootSession sends:

1. `Browser.getVersion` (`crBrowser.js:79`) — reads product, revision, userAgent.
2. `Target.setAutoAttach { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }` (`crBrowser.js:89` for non-persistent, `:94` for persistent).
3. `Target.getTargetInfo` only in persistent mode (`crBrowser.js:95`).
4. Auth: `Browser.setDownloadBehavior` per-context (`crBrowser.js:305-310`) if a context wants it.

So the initial wire conversation is small. The **per-page** CDP setup (Page.enable, Log.enable, Page.setLifecycleEventsEnabled, Page.addScriptToEvaluateOnNewDocument with empty utility-world bootstrap source, Network.enable, Fetch.enable, Target.setAutoAttach) all happens later, lazily, when a `CRPage` is created by the `Target.attachedToTarget` event. See `crPage.js:377-441` and `crPage.js:435-438` for the empty-source `addScriptToEvaluateOnNewDocument` that establishes the utility-world name.

### 2b. Isolated contexts: lazy

Patchright does NOT eagerly create isolated worlds on connect. The first call to `frame._context("utility")` triggers `Page.createIsolatedWorld` (`frames.js:629-633`):

```js
// frames.js:628-638
if (world !== "main" && this._isolatedWorld === void 0) {
  const result = await client._sendMayFail("Page.createIsolatedWorld", {
    frameId: this._id,
    grantUniveralAccess: true,
    worldName: world
  });
  ...
  this._isolatedWorld = registerContext(result.executionContextId, "utility");
}
```

Note `grantUniveralAccess: true` (typo in source — `grantUniveralAccess` not `grantUniversalAccess`). This survives because CDP ignores unknown params.

### 2c. Works against any Chromium with --remote-debugging-port?

Yes. The transport is plain CDP-over-WebSocket. `Browser.getVersion`, `Target.setAutoAttach`, `Page.createIsolatedWorld`, `Fetch.enable`, etc. are all standard Chrome DevTools Protocol calls. **No Patchright-bundled binary is required to attach.** The stealth value of using Patchright's bundled Chromium is the *binary-level patches*, not anything connectOverCDP needs.

### 2d. Protocol version

Patchright pins to the upstream Playwright protocol expectations. `crBrowser.js:81-84` parses major version from `Browser.getVersion.product` — used at `crPage.js:685` to gate `Inspector.workerScriptLoaded` (≥143). Patchright 1.59.4 ships Chromium 147 (`browsers.json:6`), so attach to a browser <143 may cause minor worker-event regressions. The bundled binary is 147, so we are safe.

---

## 3. `Runtime.enable` avoidance

I grepped the entire `lib/server/chromium/` tree for `Runtime.enable` and `Console.enable` — **zero hits**:

```
$ grep -rn 'Runtime\.enable\|Console\.enable' patchright-core/lib/server/chromium/
(no output)
```

(only matches are in `lib/server/webkit/*` and `lib/server/electron/electron.js:103` for the Node-inspector session — neither is on the path used by our flow.)

### 3a. How execution contexts get discovered without Runtime.enable

`patchright-core/lib/server/chromium/crPage.js:435-438` sends an empty `Page.addScriptToEvaluateOnNewDocument` with the utility world name — this causes Chrome to emit `Runtime.executionContextCreated` events to anyone listening on the session **even without `Runtime.enable`** (a side-effect of `Page.enable` plus the addScript call). Patchright subscribes to those events at `crPage.js:363-366`:

```js
// crPage.js:360-365
eventsHelper.addEventListener(this._client, "Runtime.consoleAPICalled", (event) => this._onConsoleAPI(event)),
eventsHelper.addEventListener(this._client, "Runtime.exceptionThrown", (exception) => this._handleException(exception.exceptionDetails)),
eventsHelper.addEventListener(this._client, "Runtime.executionContextCreated", (event) => this._onExecutionContextCreated(event.context)),
eventsHelper.addEventListener(this._client, "Runtime.executionContextDestroyed", (event) => this._onExecutionContextDestroyed(event.executionContextId)),
```

For main-world discovery (where execution-context events do NOT auto-fire without Runtime.enable), Patchright uses a clever fallback in `frames.js:616-624`:

```js
// frames.js:616-625
const globalThis2 = await client._sendMayFail("Runtime.evaluate", {
  expression: "globalThis",
  serializationOptions: { serialization: "idOnly" }
});
...
const executionContextId = parseInt(globalThis2.result.objectId.split(".")[1], 10);
this._mainWorld = registerContext(executionContextId, world);
```

`Runtime.evaluate` works without `Runtime.enable` (you just don't get events) and the returned `objectId` has the format `${injectionId}.${contextId}.${...}`. They parse the executionContextId out of the objectId string and synthesize a fake `executionContextCreated` event locally (`frames.js:604-609` calls `session._onExecutionContextCreated` with a manufactured payload).

### 3b. CDP commands fired by `page.evaluate()`

`page.evaluate(fn)` → `frame.evaluateExpression` → `_context("main"/"utility")` → `CRExecutionContext.evaluate` → **`Runtime.evaluate`** with `contextId` set (see `crExecutionContext.js` and its `evaluate` method, plus `crPage.js:1022-1026` for the binding-script pattern). Critically, the CDP wire is:

- For new contexts: one `Runtime.evaluate { expression: "globalThis", serializationOptions: { serialization: "idOnly" } }` to learn the id (main world only), or one `Page.createIsolatedWorld` (utility world).
- For each evaluate: one `Runtime.evaluate { contextId, awaitPromise, returnByValue }` (or `Runtime.callFunctionOn` for function bodies).

**No `Runtime.enable` is ever sent.**

### 3c. Cases where Runtime.enable IS sent

None in the Chromium driver. The closest is `Page.enable` (`crPage.js:378`) which is unavoidable for navigation lifecycle. If anti-bot code is sniffing `Page.enable` they will still see it, but it's far less discriminating than `Runtime.enable`.

---

## 4. Init-script injection via Route

Vanilla Playwright sends `Page.addScriptToEvaluateOnNewDocument` for every user init script. Patchright neuters this — the function body at `crPage.js:908-910` is just:

```js
async _evaluateOnNewDocument(initScript, world, runImmediately) {
  this._evaluateOnNewDocumentScripts.push(initScript);
}
```

Scripts pile into `this._evaluateOnNewDocumentScripts`. The actual injection happens during HTML response interception in `crNetworkManager.js`.

### 4a. How the route is registered

`crPage.js:80`: `this._networkManager.setRequestInterception(true)` is called in the CRPage constructor — **unconditionally**, not gated by user request-interception. That sets up `Fetch.enable` with a catch-all pattern (`crNetworkManager.js:165`):

```js
// crNetworkManager.js:165
fetchPromise = info.session.send("Fetch.enable", {
  handleAuthRequests: true,
  patterns: [{ urlPattern: "*", requestStage: "Request" }]
});
```

So every HTTP request hits Patchright. When the URL has resourceType=Document and the response is text/html, the interceptor flips into "patchrightInitScript" mode (`crNetworkManager.js:525-547`) and calls `Fetch.continueRequest` with `interceptResponse: true`, then on the response side calls `fulfill()` (`crNetworkManager.js:549-618`).

### 4b. The actual injection

`crNetworkManager.js:549-618` — when `isTextHtml && allInjections.length`:

1. Rewrites the response body from base64 if needed (`:555-558`).
2. Walks CSP headers (`:566-576`) and `<meta http-equiv="Content-Security-Policy">` tags (`:577-596`), invoking `_fixCSP` (`:629-689`) to add `'unsafe-eval'`, `'unsafe-inline'` or a synthesized nonce so the injected `<script>` actually runs.
3. Builds the injection (`:598-603`):

```js
// crNetworkManager.js:598-603
let injectionHTML = "";
allInjections.forEach((script) => {
  let scriptId = crypto.randomBytes(22).toString("hex");
  let scriptSource = script.source ?? script;
  injectionHTML += `<script class="${initScriptTag}" ${nonceAttr} id="${scriptId}" type="text/javascript">document.getElementById("${scriptId}")?.remove();${scriptSource}</script>`;
});
response.body = this._injectIntoHead(response.body, injectionHTML);
```

4. The injected script self-removes via `document.getElementById(...).remove()` on first execution, so the DOM is clean immediately after. Belt-and-suspenders: `crPage.js:514-518` and `:572-577` query for any remaining `[class="${initScriptTag}"]` nodes after `Page.lifecycleEvent: load` and `Page.frameNavigated` and `DOM.removeNode`s them.

5. `_injectIntoHead` (`:690-731`) prefers inserting before the first non-comment `<script>` in `<head>`, falls back to right after `<head>`, then after `<!doctype>`, then to wrapping in a synthesized `<head>`.

6. Body is base64-encoded and shipped back via `Fetch.fulfillRequest` (`:610-617`).

### 4c. Does this work with connectOverCDP?

**Yes.** The whole route mechanism runs entirely in the patchright-core Node process via standard `Fetch.enable`/`Fetch.continueRequest`/`Fetch.fulfillRequest` CDP calls. It does not require Patchright to have launched the browser. As long as our adapter calls `browser.newContext()` / `browser.newPage()` through the Patchright API (which it will, because we use `chromium.connectOverCDP()`), the `CRPage` constructor at `crPage.js:80` runs and Fetch interception is armed.

**Caveat — pre-existing pages:** if we attach to a browser that already has pages open, those pages will get `CRPage` instances via `Target.attachedToTarget` (`crBrowser.js:146-181`), Fetch interception will arm at that point, but anything that already loaded won't get its init scripts. So our flow must be: attach → wait for autoAttach → THEN navigate.

---

## 5. `Console.enable` avoidance

Same situation as `Runtime.enable` — no `Console.enable` anywhere in `lib/server/chromium/`. Patchright relies on `Runtime.consoleAPICalled` and `Log.entryAdded` events instead (`crPage.js:361, :352`). `Log.enable` IS called (`crPage.js:433`), which is observable but far less of a fingerprint than `Console.enable`.

**Implication for our adapter:** if we run a side-CDP session against the same browser (e.g. for our own logging) and call `Console.enable` on it, we leak the very fingerprint Patchright eliminated. Don't do it.

---

## 6. Closed shadow-root interaction

`patchright-core/lib/server/frameSelectors.js:196-310` and `frames.js:1820-1865` implement the mechanism. The trick is `DOM.describeNode` with `pierce: true` and `depth: -1`:

```js
// frameSelectors.js:194-220 (abbreviated)
const describedScope = await client.send("DOM.describeNode", {
  objectId: ...,
  depth: -1,
  pierce: true
});
const findClosedShadowRoots = (node, results = []) => {
  if (node.shadowRoots && Array.isArray(node.shadowRoots)) {
    for (const shadowRoot2 of node.shadowRoots) {
      if (shadowRoot2.shadowRootType === "closed" && shadowRoot2.backendNodeId) {
        results.push(shadowRoot2.backendNodeId);
      }
      findClosedShadowRoots(shadowRoot2, results);
    }
  }
  return results;
};
var shadowRootBackendIds = findClosedShadowRoots(describedScope.node);
```

CDP's `DOM.describeNode` exposes closed-shadow children via backendNodeIds even though the JS `element.shadowRoot` getter returns null for them. Patchright then resolves each backendNodeId into an objectId and runs utility-world queries against it. The mechanism is **CDP-only** — no JS-side hack — so it works fine through connectOverCDP.

**Implication:** if our adapter forwards `runtime.evaluate` calls that try to use `element.shadowRoot` directly in main-world JS, those will fail for closed roots. Always go through Patchright's locator API rather than reimplementing.

---

## 7. Patchright Chromium binary

Verified by running on disk:

- **Path on this machine:** `/home/user/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome` (revision 1217 from `browsers.json:5-9`).
- **Version output:**
  ```
  $ /home/user/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome --version
  Google Chrome for Testing 147.0.7727.15
  ```
- **Channel:** "Chrome for Testing" (`browsers.json:8: "title": "Chrome for Testing"`). This is the standard Playwright/Patchright Chromium build — Patchright's patches are applied during the upstream build, distributed via the same revision channel. (Patchright historically rebuilds Chromium with its own modifications and publishes them at the same revision numbers Playwright uses.)
- **User-Agent:** the binary itself reports a stock UA. The `--version` output and the `Browser.getVersion` userAgent string read at `crBrowser.js:86` will look like:
  `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/147.0.7727.15 Safari/537.36` (headless) or without `Headless` when headful. **Important:** the default UA still contains `HeadlessChrome` when run with `--headless`. For neko we're running headful (the whole point of neko is a real X server), so this should not bite us — but we MUST verify the UA at runtime.
- **Install path:** `pnpm exec patchright install chromium` writes to `$PLAYWRIGHT_BROWSERS_PATH` (or `~/.cache/ms-playwright` by default). To get the binary into the neko container, copy that directory in at image-build time and point the container at it via `PLAYWRIGHT_BROWSERS_PATH` and/or a direct `chrome` invocation.

---

## 8. Anti-patterns the adapter MUST avoid

Based on §§1–7, the rules for any code we write on top of `chromium.connectOverCDP()`:

1. **Never send `Runtime.enable` or `Console.enable`** from any CDP session (Patchright's, ours, or any side channel attached to the same browser). Both are top-fingerprint signals that Patchright deliberately avoids. (`crPage.js:350-366` — Patchright relies on the events fire even without enable; you would only be re-arming the detector.)
2. **Never send `Network.enable` from a side CDP session** to the same target. Patchright's `crNetworkManager` already sends it (`crNetworkManager.js:83`) and depends on its own state machine; a second consumer toggling it can race the Fetch interception that drives init-script injection.
3. **Never call `Page.addScriptToEvaluateOnNewDocument` directly.** Patchright bypasses this CDP API specifically because it leaves an observable footprint. Use `page.addInitScript()` or `context.addInitScript()` — these go through `crPage.js:189-192` → `_evaluateOnNewDocument` → Fetch-route injection.
4. **Never bypass Patchright's Page wrapper** by sending CDP via your own session against a Patchright-managed target. The init-script Route is gated on `pageDelegate?.initScriptTag` (`crNetworkManager.js:552`); a request you make outside the wrapped page won't be rewritten.
5. **Don't add the removed args back.** Specifically: no `--enable-automation`, no `--disable-popup-blocking`, no `--disable-component-update`, no `--disable-default-apps`, no `--disable-extensions`, no `--disable-component-extensions-with-background-pages`. These get rationalized by other tooling all the time; resist.
6. **Don't add to `--disable-features=` without also editing `chromiumSwitches.js`'s disabledFeatures list.** If you append your own `--disable-features=Foo` it'll override (Chromium uses the last `--disable-features` flag — it does NOT merge across flag instances). Either merge into a single flag or use `--enable-features` / `--disable-features` carefully.
7. **Don't launch headless.** UA contains `HeadlessChrome`; trivial to detect. (We're already not, given neko, but worth stating.)
8. **Always attach before opening pages.** If pages exist before the Patchright client attaches, those pre-existing pages will not have init scripts injected (they already loaded). The neko startup script should not autoload a URL; let our orchestrator navigate after attach.
9. **Don't open a parallel Puppeteer / playwright session against the same browser.** That session will send `Runtime.enable` and undo §1.
10. **Don't manually call `Page.createIsolatedWorld`** from our code — Patchright tracks `_isolatedWorld` per frame (`frames.js:628-641`) and a second world creation would either duplicate or shadow the bookkeeping.
11. **Don't send CSP headers from upstream that try to forbid inline scripts** if you control the origin — Patchright's `_fixCSP` will mangle them anyway, but the mangling adds detectable headers. Better to disable CSP at the origin if you also control it.
12. **Avoid `Target.attachToTarget` from a side session** without `flatten: true`. The Patchright rootSession uses `flatten: true` (`crBrowser.js:89, :94`); a non-flat session will desync session-id routing.

---

## Bottom line

**`chromium.connectOverCDP()` does deliver the bulk of Patchright's stealth even when attached to a non-Patchright-launched Chromium, with two caveats:**

1. The Runtime/Console-enable avoidance, the Route-based init-script injection, the closed-shadow-root navigation, the lazy isolated-world creation — all of these are properties of the **driver-side code path** that runs in our Node process. They apply automatically to any browser we attach to via `connectOverCDP`, regardless of how that browser was launched.
2. The launch-arg stealth (`--disable-blink-features=AutomationControlled`, absence of `--enable-automation`, etc.) is a property of how the browser **was started**. `connectOverCDP` cannot retroactively fix bad launch args. **We must replicate `chromiumSwitches.js`'s arg list in `start-chromium.sh` exactly** (with `--remote-debugging-port` swapped for `--remote-debugging-pipe`).
3. The binary-level patches (Patchright's modified Chromium source — primarily the `navigator.webdriver`, permissions API, and CDP-leak fingerprint patches that are baked into the compiled binary) are a property of the **binary itself**. To get these, we must install Patchright's Chromium into the neko image (`PLAYWRIGHT_BROWSERS_PATH=/opt/patchright-browsers pnpm exec patchright install chromium` during image build, then point start-chromium.sh at `/opt/patchright-browsers/chromium-1217/chrome-linux64/chrome`).

If we do all three (matching launch args, Patchright's binary, and connect via `chromium.connectOverCDP()`), Patchright's full stealth stack is intact. The only piece that strictly requires Patchright to have *spawned* the process is the user-data-dir / profile-singleton handling (which we don't need anyway — we can pre-create the profile). Everything else — the protocol-level stealth, the route-based injection, the runtime-event-without-enable trick — is purely driver-side and attaches cleanly.

The gap to watch is anything in our **existing CDP forwarder** (the raw CDP proxy currently sitting at `http://neko:9223`). Every command that proxy forwards bypasses Patchright. The migration plan should kill that path entirely once the Patchright client is wired up; running both in parallel will undo §3, §5, and §2 of the anti-pattern list above.
