## Owner Decision

Short-term Docker interaction support is specifically **host browser control**:

- The connector/runtime may run in Docker.
- The visible headed browser runs on the user's host machine.
- The user interacts with a normal desktop browser window.
- Docker connects to that host browser through an explicitly configured local bridge.

This change SHALL NOT pursue noVNC, WebRTC, or browser streaming for the short-term local-device tranche. Remote browser streaming remains a separate future deployment question.

## Profile Posture

The default host-browser bridge SHALL use dedicated PDPP host profiles, not the user's daily Chrome profile.

Recommended default:

```text
~/.pdpp/profiles/<connector-or-subject>/
```

This is the same profile root and naming convention already used by
`packages/polyfill-connectors/src/browser-launch.ts`, so the native and
Docker paths share storage. Each profile is independent; concurrent
runs across different profile names are safe; concurrent runs against
the same profile name are single-writer (Chromium constraint).

Rationale:

- Preserves cookies and trusted-device state across connector runs.
- Avoids giving connector code access to all of the owner's daily Chrome cookies and sessions.
- Reduces cross-connector fingerprint/cookie contamination.
- Avoids lock collisions with the user's already-running daily Chrome.
- Leaves room for future multi-account profile keys.

The user's actual Chrome profile may be a documented, explicit escape
hatch for local debugging or one-off bootstrap. It MUST NOT be the
default because it broadens the trust boundary, exposes every cookie
and signed-in tab to the connector, and risks mutating the daily
browser profile.

## Recommended First Implementation Path

The first implementation path is a small **host-side PDPP browser
bridge process** that owns a Patchright `launchPersistentContext`
against the dedicated profile directory and exposes an explicitly
configured local control endpoint over loopback. The Dockerized
connector runtime attaches through that bridge. The first
implementation tranche MUST prove whether the bridge can safely expose
the persistent context through CDP (`chromium.connectOverCDP()`) or
needs a thin bridge-owned command broker around the persistent context.

```text
host                                   | docker
─────────────────────────────────────  | ─────────────────────────────
pdpp host-bridge process                |  reference container
  └─ Patchright launchPersistentContext |    polyfill-connector
       (~/.pdpp/profiles/<name>/,       |     ↳ acquireRemoteBrowser()
        channel: "chrome",              |        │
        headless: false,                |        │  CDP over WS
       viewport: null)                 |  ◀────┘  loopback only
  └─ exposes control endpoint           |
       ws://127.0.0.1:<port>            |
       gated by per-launch token        |
```

This is the recommended path because it is the only one that:

- Uses a real host browser window the user can see and click.
- Preserves the dedicated `~/.pdpp/profiles/<...>/` profile layout that
  the native runtime already uses.
- Keeps the browser launch inside Patchright. If the implementation
  proves a Patchright client can attach cleanly to the persistent
  context, client-side stealth also stays Patchright-owned; otherwise
  the bridge-owned broker keeps connector code out of raw daily Chrome.
- Stays explicit: the bridge is a separate process the user starts and
  stops, not a container behavior the user can forget about.

The non-recommended alternatives are documented in
`design-notes/host-bridge-feasibility-spike.md`. The most important
constraint that shapes this decision: Playwright's
`BrowserType.launchServer()` does **not** accept `userDataDir`, so a
"`patchright.launchServer()` on the host, Docker connects" topology
cannot preserve persistent profiles. The persistent path is
`launchPersistentContext`, which must run in a host process the bridge
owns.

### Required Env Vars

Host side:

- `PDPP_HOST_BRIDGE_PORT` — port to bind on. Default `7670`.
- `PDPP_HOST_BRIDGE_BIND_HOST` — IP to bind on. Default `127.0.0.1`. On
  Linux Docker the operator MUST set this to the docker bridge IP
  (typically `172.17.0.1`); see Auth and Binding Model below.
- `PDPP_HOST_BRIDGE_TOKEN` — required per-launch shared secret.
- `PDPP_HOST_BRIDGE_ALLOW_PUBLIC_BIND` — set to `1` to acknowledge a
  `0.0.0.0` bind (LAN exposure). Off by default.
- `PDPP_HOST_BRIDGE_PROFILE_ROOT` — defaults to `~/.pdpp/profiles`.
- `PDPP_HOST_BRIDGE_LOG` — optional path for the bridge log.

Container side:

- `PDPP_HOST_BROWSER_BRIDGE_URL` — e.g.
  `ws://host.docker.internal:7670` (macOS/Windows Docker Desktop) or
  `ws://172.17.0.1:7670` (Linux Docker). When set, the connector uses
  the bridge instead of `acquireIsolatedBrowser`.
- `PDPP_HOST_BROWSER_BRIDGE_TOKEN` — must match the host token.
- `PDPP_HOST_BROWSER_BRIDGE_DAILY_CHROME` — opt-in escape hatch for the
  documented "drive my real Chrome" tradeoff. Off by default. The name
  intentionally includes `DAILY_CHROME` so it cannot be set by accident.

### Auth and Binding Model

The bind host depends on the operator's Docker platform. The earlier
draft of this design said "bind to 127.0.0.1 only"; that is correct on
macOS/Windows Docker Desktop (where Docker forwards
`host.docker.internal` to host loopback) but **wrong on Linux Docker**:
verified empirically, `host.docker.internal:host-gateway` resolves to
the docker bridge gateway IP (typically `172.17.0.1`), and a
127.0.0.1-only bind is not reachable from the container via that
gateway. The bridge therefore exposes an explicit `--bind-host` /
`PDPP_HOST_BRIDGE_BIND_HOST` knob.

- The bridge SHALL bind to a single, explicitly chosen IPv4 address.
  Default `127.0.0.1`.
- On Linux Docker, the operator SHALL set the bind host to the docker
  bridge gateway IP (e.g. `172.17.0.1`). The bridge SHALL emit a
  startup warning when running on Linux with a 127.0.0.1 bind.
- Binding `0.0.0.0` requires explicit acknowledgement
  (`--allow-public-bind` or `PDPP_HOST_BRIDGE_ALLOW_PUBLIC_BIND=1`)
  because it accepts traffic from every interface, including the LAN.
- The bridge SHALL require the shared token in the WS upgrade headers;
  unauthenticated connections SHALL be rejected with HTTP 401.
- The bridge SHALL reject connections whose `Host` header is not one
  of: `127.0.0.1`, `localhost`, `host.docker.internal`, or the IP the
  bridge bound to. `0.0.0.0` is never accepted as a Host header.
- On Linux Docker, the Compose stack SHALL set
  `extra_hosts: ["host.docker.internal:host-gateway"]` so the container
  can reach the bridge by that alias when the operator binds to the
  docker bridge IP.
- The bridge SHALL log every accepted connection.

### Failure Mode When Unavailable

When the runtime is configured to use the bridge and the bridge cannot
be reached:

- The run SHALL fail with a typed error code
  `host_browser_bridge_unavailable` rather than appearing to wait for an
  invisible browser.
- The dashboard run timeline SHALL render this as a deployment-config
  error state, not a generic pending interaction.
- The error message SHALL include the exact host command the operator
  must run, the configured URL, and a hint to verify the token.

## Candidate Directions Considered

### Host Patchright Persistent-Context Bridge (chosen)

See "Recommended First Implementation Path" above.

### Host Chrome Over Plain CDP (fallback only)

Run Chrome on the host with `--remote-debugging-port=9222` and have
Docker connect over CDP. Acceptable for a documented local-debug
fallback only. Tradeoffs:

- Loses Patchright's launch-side stealth layer (Chrome wasn't started
  with the patched flags).
- Requires the operator to launch Chrome explicitly with
  `--user-data-dir=~/.pdpp/profiles/<connector>/`. If they forget and
  point at their daily profile, every cookie and signed-in tab is
  exposed to the bridge client.
- The remote-debugging port is reachable by every non-root local
  process by default.

This direction MAY be documented as an escape hatch but SHALL NOT be
the default for browser-backed connectors.

### Full Host Connector Worker (deferred)

Run the whole connector process on the host while AS/RS/web remain
containerized. Avoids remote browser control entirely. Deferred:
requires its own runtime/worker protocol (a stop-and-report trigger for
this OpenSpec) and is only worth re-opening if the chosen path proves
too brittle on at least two of macOS / Linux / Windows.

## Security Requirements

- The bridge SHALL be explicit opt-in. Docker SHALL NOT silently
  expose browser control.
- The bridge SHALL bind to loopback by default.
- The bridge SHALL require a shared-secret token on every connection.
- The bridge SHALL use dedicated PDPP profiles by default.
- The bridge SHALL NOT use the owner's daily Chrome profile unless the
  operator sets `PDPP_HOST_BROWSER_BRIDGE_DAILY_CHROME`.
- When the daily-Chrome flag is set, the runtime SHALL emit a loud
  per-run warning and the dashboard SHALL surface it as a non-default
  trust posture.
- The dashboard/run timeline SHALL identify when a run requires
  host-browser interaction.
- If the bridge is not configured, Docker runs SHALL fail or pause with
  an actionable message rather than launching an invisible headed
  browser.

## UX Requirements

- The owner path SHALL be: "run needs browser interaction → visible
  host browser is already open or opens → owner completes challenge →
  connector continues."
- The run page SHALL distinguish form-only interactions
  (`kind=credentials`, `kind=otp`) from host-browser-required
  interactions (`kind=host_browser_required`).
- Setup docs SHALL state which host command/process must be running
  before Docker browser-backed connectors can use the bridge.
- The dashboard SHALL render `host_browser_bridge_unavailable` as a
  distinct deployment-config error state with a copy-paste fix.

## First Vertical Slice

The first connector that exercises the bridge SHALL be **ChatGPT**
(`packages/polyfill-connectors/connectors/chatgpt`).

ChatGPT is the right pick because:

- It is already browser-backed via `acquireIsolatedBrowser` plus
  `auto-login/chatgpt.ts`.
- Its login + 2FA + occasional Cloudflare path is the canonical case
  where "user sees a real browser" matters.
- It carries no money-movement risk during validation (vs. USAA or
  Chase).
- Its existing fixtures and runtime cover the data path, so the slice
  only swaps the browser-acquisition step.

### Validation Flow

The slice is "user sees host browser, completes interaction, connector
continues":

1. Operator starts the host bridge on their machine. The bridge prints
   the token and the local endpoint.
2. Operator exports `PDPP_HOST_BROWSER_BRIDGE_URL` and
   `PDPP_HOST_BROWSER_BRIDGE_TOKEN` into the Compose environment.
3. Operator starts the Compose stack and triggers a ChatGPT connector
   run from the dashboard.
4. The connector dials the bridge. A real Chrome window opens on the
   host against `~/.pdpp/profiles/chatgpt/`.
5. If the profile is fresh, the operator completes login + OTP in that
   window. The connector continues fetching.
6. The run completes successfully. The dashboard timeline shows the
   host-browser-required step transition cleanly.
7. Operator stops the host bridge. Re-running the connector surfaces
   `host_browser_bridge_unavailable` immediately with a copy-paste fix.

Smoke checks beyond the happy path:

- Concurrent runs against two different profile names succeed.
- Concurrent runs against the same profile name fail with a clear
  single-writer error, not a hang.
- Restarting the bridge mid-run produces a clean failure rather than a
  zombie page.

## Implementation Touchpoints

These belong to the implementation tranche after this design lands.
Listed here so the next slice has a concrete starting point:

- `packages/polyfill-connectors/src/browser-launch.ts` — add an
  `acquireRemoteBrowser` (or augment `acquireIsolatedBrowser`) that
  routes through the host bridge when
  `PDPP_HOST_BROWSER_BRIDGE_URL` is set.
- `reference-implementation/runtime/controller.ts` — recognize the
  typed `host_browser_bridge_unavailable` failure and surface it
  cleanly. Recognize `kind=host_browser_required` interactions.
- New host-bridge entry point — small Node CLI that wraps Patchright's
  `launchPersistentContext` with a token-gated WS handoff.
- `docker-compose.yml` / `docker-compose.dev.yml` — document
  `extra_hosts` and the bridge env vars; do not auto-start the bridge.
- `/dashboard/runs/:runId` — copy and a distinct visual state for
  `host_browser_required` and `host_browser_bridge_unavailable`.

## Non-Goals

- No noVNC/Xvfb sidecar in this tranche.
- No WebRTC/browser streaming in this tranche.
- No managed browser provider default.
- No use of the owner's daily Chrome profile by default.
- No full connector-worker protocol unless host browser control is
  shown to be too brittle on multiple platforms.

## Acceptance Checks

- [x] The design chooses between host Patchright server and host
      Chrome-over-CDP as the recommended first implementation. (Chosen:
      host Patchright persistent-context bridge.)
- [x] The setup path is understandable for local Docker Compose users.
      (Bridge env vars and `host.docker.internal` documented above.)
- [x] Security review covers profile isolation, control-channel
      binding, explicit opt-in, and daily-profile risks.
- [x] The implementation plan names the smallest vertical slice and one
      browser-backed connector to test. (ChatGPT.)
