# Host-Browser Bridge Feasibility Spike

Memo-only output of the feasibility slice for the
`design-host-browser-bridge-for-docker` change. Captures what we learned
about driving a visible host browser from a Dockerized connector runtime,
the constraint surface that shapes the recommendation, and the smallest
vertical slice we'd build first.

This memo is a sibling of `design.md`. `design.md` carries the
normative-ish design statements; this file carries the spike evidence,
non-recommended alternatives, and tradeoffs we examined.

## Summary

- **Recommendation**: a small host-side **PDPP host bridge** process that
  uses Patchright's `launchPersistentContext` against
  `~/.pdpp/profiles/<connector-or-subject>/` and exposes the resulting
  browser's CDP endpoint over loopback. The Dockerized connector runtime
  attaches to that endpoint via Patchright's `chromium.connectOverCDP()`.
- **Not recommended (default)**: connecting Docker directly to the user's
  daily Chrome via `--remote-debugging-port=9222`. Acceptable only as a
  documented operator escape hatch with explicit profile guidance.
- **Out of scope** (confirmed): noVNC/Xvfb, WebRTC, browser streaming,
  managed-browser providers, full host connector worker.

## Constraint Surface

### C1. `launchServer()` cannot use a user data dir

Playwright's `BrowserType.launchServer({ ... })` does not accept
`userDataDir`. Persistent profiles are only first-class via
`BrowserType.launchPersistentContext(userDataDir, options)`. The
"`launchServer` + connect" pattern that pixelfactoryio/playwright-server
documents is non-persistent by design.

This kills the simplest mental model ("`patchright.launchServer()` on the
host, Docker connects"). Instead the host must run its own process that
owns the persistent context and exposes its CDP endpoint.

References:
- Playwright `BrowserType.launchServer`: no `userDataDir` argument.
- Playwright `BrowserType.launchPersistentContext`: the persistent path.
- Patchright README "Best Practices" mandates `launchPersistentContext`
  with `channel: "chrome"` for full stealth coverage; this is also the
  shape `acquireIsolatedBrowser` already uses today.

### C2. Patchright stealth has a launch-side and a client-side layer

The launch-side patches (modified Chromium flags, removal of
`--enable-automation`, blink feature toggles) live with the process that
**spawns** the browser. The client-side patches (e.g. avoiding
`Runtime.enable`, isolated execution contexts) live with the **client**
that drives the browser via CDP.

This means:

- Spawning a vanilla Chrome with `--remote-debugging-port=9222` and
  attaching from a Patchright client gives you the client-side layer but
  loses the launch-side layer.
- Spawning Patchright Chromium and attaching with stock Playwright keeps
  the launch-side layer but loses client-side stealth.
- Best stealth requires Patchright on both sides of the bridge.

The bridge therefore needs Patchright installed on the host **and** in
the Docker image. Patchright is already a dependency of
`packages/polyfill-connectors/package.json`, so the container side is
already covered.

### C3. Persistent contexts are single-writer

Chromium will not let two processes share one user data dir. So:

- Concurrent runs across different `profileName`s are safe (different
  dirs).
- Concurrent runs against the same `profileName` are not — same as the
  current native behavior in `acquireIsolatedBrowser`. The bridge must
  serialize per-profile and surface a clear error on contention.

This also means the bridge cannot share a profile with the user's daily
Chrome unless Chrome is closed for that profile, which is one of several
reasons we keep `~/.pdpp/profiles/<...>/` separate from the daily
profile.

### C4. The host-to-container hop crosses Docker's network namespace

In Compose, `host.docker.internal` works on macOS/Windows out of the
box; on Linux it requires
`extra_hosts: ["host.docker.internal:host-gateway"]`. The bridge
endpoint must:

- Bind to loopback **on the host** (`127.0.0.1`) so other machines on
  the LAN can't drive the bridge.
- Be reachable from the container via `host.docker.internal` or, where
  the operator prefers, an explicit host-mode network on Linux.

This is friction but well-trodden — the same shape used by host-side
DBs that Compose stacks talk to. We do **not** expose the bridge on
`0.0.0.0`.

### C5. Patchright client requires version-matched server

Playwright "connect" requires the major.minor of client and server to
match. With Patchright pinned at `^1.59.4` on both sides today, this
holds. Any upgrade on one side has to land on the other. The bridge's
README must call this out.

### C6. CDP-attach to a foreign Chrome is the dangerous default

`chrome --remote-debugging-port=9222 --remote-allow-origins=*` exposes
the user's entire current browser session — every cookie, every
extension, every signed-in tab — to anything that can reach
`127.0.0.1:9222`. On Linux, every non-root process on the host can
reach that port. We will not make this the default.

When this fallback is documented at all, it must:

- Be opt-in via a clearly named env var that includes the word
  `DAILY_CHROME` so it cannot be set by accident.
- Require the user to launch Chrome with
  `--user-data-dir=~/.pdpp/profiles/<connector>/` (a dedicated profile,
  not their daily one).
- Refuse to run if the configured profile path looks like the user's
  daily Chrome `User Data` directory.

## Recommendation

### Path A (chosen): host PDPP browser bridge process

A small Node process on the host. Conceptually:

```text
host                                  | docker
─────────────────────────────────────  | ────────────────────────────
pdpp-host-bridge (Node, Patchright)    |  reference container
  └─ launchPersistentContext(          |    polyfill-connector
       ~/.pdpp/profiles/<name>/,       |     ↳ acquireRemoteBrowser()
       { channel: "chrome",            |        │
         headless: false,              |        │  CDP over WS
         viewport: null })             |  ◀────┘  (loopback only)
  └─ exposes context CDP endpoint      |
       at ws://127.0.0.1:<port>        |
       gated by a per-launch token     |
```

Why this shape:

- It preserves the existing `~/.pdpp/profiles/<name>/` profile layout
  used by `acquireIsolatedBrowser`. The native and Docker paths share a
  profile-naming convention, which keeps multi-account future work
  unified.
- It keeps Patchright on both sides, so launch-side and client-side
  stealth both apply.
- The host bridge is thin: it doesn't impersonate the connector; it
  just owns the persistent context and a token-gated handoff.
- It is explicit. The user starts the bridge themselves
  (`pnpm pdpp host-bridge` or similar). If it is not running, Docker
  runs that need a browser fail fast with a copy-paste fix.

### Path B (fallback only): host Chrome over CDP

Acceptable for `local-debug` mode if the operator has a dedicated
PDPP-only Chrome window already running with a dedicated profile. We
document it as a tradeoff, not a default. We do not auto-detect it.

### Path C (deferred): full host connector worker

Run the polyfill-connector process on the host, runtime stays in
Docker. This avoids cross-namespace browser control entirely. It was
not pursued in this slice because it requires its own runtime/worker
protocol and crosses the stop-and-report trigger — "any path requiring
a durable runtime/worker boundary." Worth re-opening only if Path A is
shown to be too brittle on at least two of macOS / Linux / Windows.

## Required Surface (for the implementation tranche after this design)

These belong to the implementation change, not this design memo. Listed
here so the next tranche has a concrete starting point:

### Env vars (host side)

- `PDPP_HOST_BRIDGE_PORT` — loopback port to bind. Default `7670`.
- `PDPP_HOST_BRIDGE_TOKEN` — required per-launch shared secret.
- `PDPP_HOST_BRIDGE_PROFILE_ROOT` — defaults to `~/.pdpp/profiles`.
- `PDPP_HOST_BRIDGE_LOG` — optional path for the bridge log.

### Env vars (container side)

- `PDPP_HOST_BROWSER_BRIDGE_URL` — e.g.
  `ws://host.docker.internal:7670`. When set, the connector uses the
  bridge instead of `acquireIsolatedBrowser`.
- `PDPP_HOST_BROWSER_BRIDGE_TOKEN` — must match the host token.
- `PDPP_HOST_BROWSER_BRIDGE_DAILY_CHROME` — opt-in escape hatch flag for
  the documented "drive my real Chrome" tradeoff. Off by default.

### Auth/binding

- Bridge binds `127.0.0.1` only.
- Bridge requires the shared token in the WS upgrade headers.
- Bridge rejects connections whose `Origin`/`Host` does not match
  `127.0.0.1`/`host.docker.internal`.
- Bridge logs every accepted connection to its log file.

### Profile path

- Default `~/.pdpp/profiles/<connector-or-subject>/`. Same convention
  as `browser-launch.ts` so native and Docker share storage.
- Daily-Chrome profile is supported only via the explicit env var above
  and only when `--user-data-dir` is overridden by the operator.

### Failure mode when bridge is unavailable

- The runtime tries to dial the bridge on first browser-needing step.
- Failure surfaces as a typed run failure with a stable code (e.g.
  `host_browser_bridge_unavailable`).
- The dashboard run timeline renders this as a distinct state, not a
  generic "interaction needed" pause.
- Error copy includes the exact host command the operator should run.

## Dashboard / Run Timeline Behavior

Today the run timeline distinguishes form-only interactions
(`kind=credentials`, `kind=otp`) from generic browser-required steps.
The bridge-aware behavior layers on top:

- New interaction `kind=host_browser_required` for steps that explicitly
  need a visible host browser (e.g. Cloudflare turnstile, "is this you"
  challenges). The connector emits this when the step is one a hidden
  fetch can't satisfy.
- The dashboard renders this kind with explicit copy: "This run needs
  to drive a browser window on your machine. Open the host bridge or
  switch this connector to the native runtime."
- If the runtime dialed the bridge and got `unavailable`, the run shows
  a deployment-config error state, not a pending interaction.

The exact card design is the next slice's problem; the kind name and
state machine are the parts this design needs to commit to.

## First Vertical Slice

**Connector**: ChatGPT (`packages/polyfill-connectors/connectors/chatgpt`).

Why ChatGPT:

- Already browser-backed via `acquireIsolatedBrowser` and
  `auto-login/chatgpt.ts`.
- Login + 2FA + occasional Cloudflare check are exactly the steps where
  "user sees a real browser" matters.
- No money-movement risk during validation (vs. USAA/Chase).
- Existing fixtures and runtime cover most of the data path; the slice
  only swaps browser acquisition.

**Validation flow**:

1. Operator starts `pnpm pdpp host-bridge` on the host. Bridge prints
   the token and the WS endpoint.
2. Operator exports `PDPP_HOST_BROWSER_BRIDGE_URL` and
   `PDPP_HOST_BROWSER_BRIDGE_TOKEN` into the Compose environment.
3. Operator starts the Compose stack and triggers a ChatGPT connector
   run from the dashboard.
4. The connector dials the bridge. A real Chrome window appears on the
   host using `~/.pdpp/profiles/chatgpt/`.
5. If the profile is fresh, the operator completes login + OTP in that
   window. The connector reads the resulting bearer token and proceeds.
6. The run completes. The dashboard timeline shows the
   host-browser-required step transition cleanly.
7. Operator stops the host bridge. Re-running the same connector
   surfaces `host_browser_bridge_unavailable` immediately, with the
   correct copy-paste fix.

**Smoke checks** beyond the happy path:

- Concurrent runs against two different profiles succeed.
- Concurrent runs against the same profile fail with a single-writer
  error, not a hang.
- Restarting the bridge mid-run produces a clean failure rather than a
  zombie page.

## Open Questions Deferred to the Implementation Tranche

- Whether the bridge should be a CLI subcommand of an existing
  package or a tiny standalone binary. Either is fine for the design.
- Windows behavior. The spike confirms macOS and Linux paths;
  Windows likely works (Patchright is Chromium-only, and Playwright
  supports Windows) but needs its own validation. Mark Windows as
  "documented but unverified" in the first slice.
- How the bridge handles concurrent connector requests beyond
  per-profile serialization (queueing, multi-context, etc.).
- Whether to ship the bridge with the main repo or as a separate
  installable. First-pass: in-repo CLI.

## Residual Risks

1. **Patchright version drift** between host and container produces
   confusing connect-time failures. Mitigation: bridge prints both
   versions on startup; container logs both; mismatch fails fast with a
   clear message.
2. **Profile collision** if the operator runs the native pipeline and
   the Docker pipeline against the same connector. Mitigation:
   `acquireIsolatedBrowser` already takes the lock; the bridge surfaces
   the lock as a typed error.
3. **Operator confusion about which is "real"** — is it the bridge or
   the container's bundled Chromium? The bridge banner and dashboard
   copy must say "host" explicitly.
4. **Stealth regression** if a future Patchright change diverges from
   our recommended `launchPersistentContext` shape. Mitigation: the
   bridge launches with the exact same options as
   `acquireIsolatedBrowser` so the two paths share posture by
   construction.
5. **Daily-Chrome escape hatch creep** — if the env var becomes
   undocumented folklore, operators will drift into using their daily
   profile. Mitigation: the runtime warns loudly on every run when the
   daily-Chrome flag is set, and the dashboard surfaces it as a
   non-default trust posture.

## Why Not...

- **noVNC/Xvfb in the container**: visible-but-fake. The owner decision
  is "real host browser." Out of scope.
- **Cloudflare-friendly managed browser providers**: trust boundary
  expands to a third party. Out of scope for the local-device tranche.
- **Reuse of the user's daily Chrome profile**: cookie blast radius and
  daily-browser lock collisions. Documented escape hatch only.
- **Streaming the container's browser to the user**: WebRTC/noVNC
  again. Out of scope.

## Validation Run

```text
$ openspec validate design-host-browser-bridge-for-docker --strict
Change 'design-host-browser-bridge-for-docker' is valid

$ openspec validate --all --strict
[all changes valid]
```

(Commands to be re-run by reviewer; current outputs are recorded in the
workstream merge-queue card.)
