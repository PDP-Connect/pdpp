# n.eko Streaming Stealth — SLVP Design Brief

**Status:** shipped 2026-05-11. Validated against `bot.sannysoft.com` (all tracked tests pass) and `chatgpt.com/auth/login` (page reached without Cloudflare Turnstile challenge).

**Authors:** the owner Nunamaker; multi-model review pending (Claude+Gemini+ChatGPT consensus pattern from the consent card brief).

**Related briefs:**
- `docs/patchright-integration-spec.md` — Patchright internals research (anti-pattern list, default-args citation, connectOverCDP semantics).
- `docs/neko-adapter-refactor-spec.md` — Deferred refactor of `neko-adapter.js` to use Patchright APIs for page introspection without burning stealth.
- `docs/patchright-init-script-debug.md` — Diagnostic walk-through that uncovered the utility-world vs main-world `page.evaluate` gotcha.

---

## Problem

n.eko streams a Chromium browser running on an X server inside a Docker
container to end users via WebRTC. The user types and clicks in the
streamed video; n.eko translates those events to OS-level X input. We use
this for connectors that need a human-in-the-loop session — most notably
ChatGPT, whose Cloudflare Turnstile re-challenges any browser it scores
as bot-like.

Pre-fix, our setup failed Turnstile. The same IP from the user's native
phone browser passed Turnstile cleanly, so the failure was browser-side,
not network-side.

A `fingerprint-probe.mjs` run against the live container identified the
detection vectors:

- `WebGL RENDERER = ANGLE (... SwiftShader ...)` — software rendering;
  no real user has this.
- `screen 1280x720 @ DPR 1` — desktop resolution rarely seen in
  consumer traffic; combined with SwiftShader, screams "container."
- `deviceMemory undefined` — real Chrome on Linux returns 8 or 16.
- `chrome.runtime undefined` — real Chrome has this even without
  extensions; vanilla Chromium does not.

And the launch flags we were using were classic automation-mode tells:

- `--test-type` — literally identifies the binary as automated.
- `--remote-debugging-port=9222` — exposes CDP. Detected by Turnstile's
  JS challenge probing.
- `--no-sandbox` — fingerprint-able, unusual for a real user.

But the dominant detection vector turned out to be not the binary itself,
but the **CDP commands our `neko-adapter.js` was issuing against the
user's tab**. Specifically `Runtime.enable` and
`Page.addScriptToEvaluateOnNewDocument`, which Patchright's README calls
out as the top fingerprint leak.

---

## Solution: three layers of stealth, each owned by a different component

```
   ┌─────────────────────────────────────────────────────┐
   │ Layer 1 — BINARY                                    │
   │   Patchright's bundled Chromium 147.0.7727.15 with  │
   │   C-level patches (navigator.webdriver, permissions │
   │   API quirks, CDP-leak fixes). Baked into the neko  │
   │   image via a multi-stage Dockerfile build.         │
   └─────────────────────────────────────────────────────┘
                              │
   ┌──────────────────────────┴──────────────────────────┐
   │ Layer 2 — LAUNCH ARGS                               │
   │   start-chromium.sh mirrors Patchright's canonical  │
   │   chromiumSwitches.js verbatim (with                │
   │   --remote-debugging-port for cross-container       │
   │   attach). No --enable-automation, --test-type,     │
   │   --disable-extensions, etc.                        │
   └──────────────────────────┬──────────────────────────┘
                              │
   ┌──────────────────────────┴──────────────────────────┐
   │ Layer 3 — DRIVER (CDP consumer)                     │
   │   Strict mode: no raw CDP touches the user's tab    │
   │   during interaction. Patchright (via               │
   │   chromium.connectOverCDP) handles any CDP we need  │
   │   for canary/diagnostic purposes — it avoids the    │
   │   detection vectors (Runtime.enable, Console.enable,│
   │   direct Page.addScriptToEvaluateOnNewDocument)     │
   │   that vanilla CDP clients emit.                    │
   └─────────────────────────────────────────────────────┘
```

Each layer is owned by upstream Patchright. We do not curate stealth
patches ourselves — the maintenance burden goes to where it belongs.

### What we DO own (environmental, outside Patchright's scope)

| Concern | Where | Why we own it |
|---|---|---|
| Window/screen size | `start-chromium.sh` + `NEKO_DESKTOP_SCREEN` | Patchright doesn't set viewport on attached contexts; 1440x900 is a top-five real-user resolution. |
| User-data-dir | `start-chromium.sh` | Persistent profile for cross-session login state. |
| CDP endpoint | `--remote-debugging-port=9222` + cdp-proxy.py | Patchright cannot launch the binary itself (must be n.eko's X-attached process); we expose CDP for connectOverCDP. |
| `webSocketDebuggerUrl` rewrite | `docker/neko/cdp-proxy.py` | Chromium hard-binds CDP to 127.0.0.1; the proxy rewrites the URL in `/json/version` responses so attaching clients can resolve it from the sibling docker network. |
| Strict mode contract | `neko-adapter.js` `stealthMode` | We commit to never sending raw CDP against the user's tab during streaming sessions. |
| GPU rendering | `--use-gl=angle --use-angle=swiftshader` | Known imperfection (see "Known limitations"). |

---

## Implementation

### Files changed

- **`docker/neko/Dockerfile`** — Added a `patchright-chromium` build stage that runs `patchright install chromium` and copies the resulting browser tree to `/opt/patchright-browsers/` in the runtime stage. Also retained the Google Chrome stable install as a fallback (Patchright also prefers `channel:chrome` when its bundled binary isn't available).

- **`docker/neko/start-chromium.sh`** — Rewritten end-to-end. Binary selection in priority order: Patchright Chromium → Google Chrome stable → system chromium. Launch flags are the verbatim Patchright canonical set from `chromiumSwitches.js`, with `--remote-debugging-port=9222` substituted for the default `--remote-debugging-pipe`.

- **`docker/neko/cdp-proxy.py`** — Added `rewrite_devtools_ws_urls()` that runs on DevTools JSON responses (`/json/version`, `/json/list`), rewriting `webSocketDebuggerUrl` from `ws://127.0.0.1:9222/...` to `ws://<inbound-host>/...` so Patchright's `connectOverCDP` can dial through. Also fixed `Content-Length` to match the rewritten body size.

- **`docker-compose.neko.yml`** — `PDPP_NEKO_STEALTH_MODE: strict` (was `balanced`). `NEKO_DESKTOP_SCREEN: 1440x900@30` (was `1280x720@30`).

- **`.env.docker`** — Same two changes overridden at the operator-config layer.

- **`reference-implementation/package.json`** — Added `patchright@^1.59.4` as a dependency so the reference container can `import { chromium } from "patchright"` for canary tests today and the adapter refactor tomorrow.

- **`reference-implementation/scripts/stealth/`** — Three diagnostic scripts (`fingerprint-probe.mjs`, `patchright-canary.mjs`, `turnstile-check.mjs`) + `README.md` documenting the validation procedure.

### Files NOT changed (deferred)

- **`reference-implementation/server/streaming/neko-adapter.js`** — The refactor from raw CDP to Patchright APIs is spec'd in `docs/neko-adapter-refactor-spec.md` but deferred. Under `stealthMode=strict` the adapter opens no CDP at all during the user's interaction, so no stealth is at stake. The refactor matters only when we want to add features (focus binding, viewport status polling) back without burning stealth — none of those are on the critical path.

---

## Validation

### 1. Fingerprint probe (raw CDP)

```
== fingerprint signals ==
  navigator.webdriver                    = false
  navigator.userAgent                    = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
  navigator.platform                     = "Linux x86_64"
  navigator.plugins.length               = 5
  window.chrome exists                   = "object"
  WebGL VENDOR                           = "Google Inc. (Google)"
  WebGL RENDERER                         = "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)"
  screen.width x height                  = "1440x900"
  devicePixelRatio                       = 1
  Runtime injected token (cdc_)          = false
```

### 2. Patchright canary

```
[canary] connecting via Patchright to http://neko:9223 ...
[canary] ✓ attached; 1 context(s), 18 pre-existing page(s)
[canary] result: {
  url: 'https://example.com/',
  title: 'Example Domain',
  canaryFromMain: 'ok',          ← addInitScript injected into main world
  webdriver: false,
  ...
}
[canary] ✓ all checks passed
```

### 3. bot.sannysoft.com — all known automation tests pass

```
  WebDriver (Old)        | missing (passed)
  WebDriver (New)        | missing (passed)
  WebDriver Advanced     | passed
  Chrome (object)        | present (passed)
  Plugins is PluginArray | passed
  PHANTOM_UA             | ok
  PHANTOM_PROPERTIES     | ok
  PHANTOM_ETSL           | ok
  PHANTOM_LANGUAGE       | ok
  PHANTOM_WEBSOCKET      | ok
  PHANTOM_OVERFLOW       | ok
  PHANTOM_WINDOW_HEIGHT  | ok
  HEADCHR_UA             | ok
  HEADCHR_CHROME_OBJ     | ok
  HEADCHR_PERMISSIONS    | ok
  HEADCHR_PLUGINS        | ok
  CHR_BATTERY            | ok
  CHR_MEMORY             | ok
  TRANSPARENT_PIXEL      | ok
  SEQUENTUM              | ok
  VIDEO_CODECS           | ok
```

### 4. chatgpt.com — login page reached without challenge

```
[turnstile] page url: https://chatgpt.com/auth/login
[turnstile] page title: Get started | ChatGPT
[turnstile] iframes: 0
[turnstile] hasTurnstileMarker: false
[turnstile] hasChallengeText: false
[turnstile] hasLoginCTA: true
[turnstile] ✓ PASSED — login page reached without challenge
```

The final live test — a user clicking through Turnstile via the WebRTC
stream — requires a human and cannot be automated.

---

## Known limitations

1. **WebGL renderer is `SwiftShader`.** Real users have Intel/AMD/NVIDIA
   GPUs reported through ANGLE. Mitigations: (a) configure neko with
   host GPU passthrough so the X server runs `--use-gl=desktop`; (b)
   patch the renderer string via a Patchright `addInitScript` that
   overrides `getParameter(UNMASKED_RENDERER_WEBGL)`. (a) is preferred
   because it makes the lie unnecessary; (b) is a workaround.

2. **`hardwareConcurrency` reports the host CPU count.** Our host has
   24 cores; real users mostly have 4-12. Could be normalized via
   addInitScript override or `--js-flags=--cpu-throttle=4`. Lower
   priority than WebGL — Cloudflare weights WebGL much higher.

3. **`platform: Linux x86_64`** is truthful but rare in consumer
   traffic. Combined with WebGL=SwiftShader, the combination reads as
   "containerized." If we ever need to fool a desktop-targeting
   detector, we'd lie about platform — but that requires lying about
   client hints and TLS fingerprint consistently too, which is more
   work than fixing WebGL.

4. **CDP is exposed on the docker network.** Anything on that network
   can attach to the browser as a debugger. Acceptable for our private
   docker-compose deployment but not for any setting where the docker
   network is shared with untrusted services.

5. **`page.evaluate()` runs in Patchright's utility world.** Reading
   main-world globals requires a DOM-script hop (see
   `scripts/stealth/patchright-canary.mjs`). Not a stealth issue, but
   the gotcha cost a few hours of debugging and is documented for the
   next maintainer.

6. **The neko-adapter still uses raw CDP for advanced features.** Under
   `stealthMode=strict` these calls are gated off; turning them back on
   (e.g. for focus-binding-driven UX) requires the deferred refactor in
   `docs/neko-adapter-refactor-spec.md`.

---

## Decisions log

- **Use Patchright's `connectOverCDP` rather than `launchPersistentContext`.**
  n.eko owns the X-attached browser process; Patchright cannot launch
  it. connectOverCDP gives us the driver-side stealth (no
  Runtime.enable, Route-based init injection) without owning the
  process tree.

- **Bake Patchright's binary into the neko image, not the reference
  image.** The browser the user sees and clicks in is n.eko's; the
  reference container only attaches as a CDP client. Putting the
  Patchright binary in the reference container would help nothing.

- **Keep cdp-proxy.py rather than dropping it.** Chromium hard-binds
  CDP to 127.0.0.1 regardless of `--remote-debugging-address`. We could
  work around this with `--remote-allow-origins` + iptables, but the
  proxy is small, well-scoped, and already handles header rewriting we
  need. Drop it only if it becomes a bottleneck.

- **Defer the neko-adapter refactor.** The current strict-mode
  contract — neko-adapter opens no CDP during the user's interaction —
  is sufficient for ChatGPT today. The refactor is required for future
  features (focus binding, viewport-status polling on the user's tab)
  but those features are not on the critical path. Refactor lands as
  a separate change with its own spec, test plan, and rollout.

- **Mirror Patchright's canonical args verbatim rather than hand-roll
  our own.** Maintenance goes upstream. If Patchright's maintainers
  add or remove a flag in a future release, we re-sync once and move
  on. Hand-rolled flags would drift the moment Patchright shipped a
  new chromiumSwitches.js.

---

## Validation procedure for future stealth changes

Before touching `start-chromium.sh`, `Dockerfile`, `cdp-proxy.py`, or
the Patchright dependency version:

1. `docker compose --env-file .env.docker -f docker-compose.yml -f docker-compose.neko.yml build neko`
2. `docker compose --env-file .env.docker -f docker-compose.yml -f docker-compose.neko.yml up -d --force-recreate neko`
3. Run all three canaries from inside the reference container:
   - `node scripts/stealth/fingerprint-probe.mjs` — verifies binary + launch args
   - `node scripts/stealth/patchright-canary.mjs` — verifies driver-side stealth
   - `node scripts/stealth/turnstile-check.mjs` — verifies end-to-end against a real bot-protected site
4. Any regression in (3) blocks the change.

For confidence in changes that touch CDP routing or Patchright wiring,
also re-run the reference test suite: `pnpm test` from
`reference-implementation/`. There is one pre-existing
wall-clock-flake in `run-interaction-stream-playground.test.js` that
is unrelated to stealth and can be ignored.
