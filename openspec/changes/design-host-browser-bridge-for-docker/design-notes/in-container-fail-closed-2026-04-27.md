# In-container fail-closed gate for HEADED browser-backed connectors (P1)

Date: 2026-04-27 (revised twice the same day post owner-review)
Status: implemented (code change, no spec delta)
Author: docker-ops bughunt lane

## Revision history

- **2026-04-27 r1** — initial implementation. Gate fired on every
  in-container browser acquisition with empty bridge env; over-broad.
- **2026-04-27 r2** — narrowed to `headless === false` (visible
  browser). First owner-review pass.
- **2026-04-27 r3** — fixed `headless: undefined`. The launcher's
  destructured default is `headless = false`, so an omitted field
  effectively requests a headed browser. The r2 gate skipped that
  case and would have let the original silent-headed-in-container
  path slip through for any library-direct caller writing
  `acquireBrowserForConnector({ profileName })`. The decision helper
  now mirrors the launcher's effective default via
  `ACQUIRE_ISOLATED_BROWSER_HEADLESS_DEFAULT`.

## Problem

`resolveHostBrowserBridgeConfig` returns `mode: "disabled"` when ALL
three bridge env vars are empty. `acquireBrowserForConnector` then
falls through to `acquireIsolatedBrowser`, which inside a container
launches Patchright Chromium with `headless: false` — an invisible
headed window the operator cannot see or interact with.

Browser-backed connectors that require interactive flow (Cloudflare,
OTP, "is this you?") then block forever on the `auto-login`
INTERACTION handshake with no operator-visible signal. README.md
documents this as the remaining gap; design.md § "Failure Mode When
Unavailable" already requires Docker runs to fail or pause with an
actionable message rather than launch an invisible headed browser.

## Decision

The fix is purely runtime-level. The existing spec text already
mandates the desired behavior for **headed** Docker runs; we are
closing the implementation gap for that case only.

**Narrow gate (revised twice):** the fail-closed branch fires only when
ALL of the following are true:

1. `resolveHostBrowserBridgeConfig` returns `mode: "disabled"`
   (bridge env vars are empty), AND
2. `isRunningInContainer()` returns true (PDPP_REFERENCE_MODE=composed
   OR `/.dockerenv` exists OR PDPP_FORCE_CONTAINER=1), AND
3. The caller's effective `headless` is `false`, where "effective"
   means the value after applying the same default as
   `acquireIsolatedBrowser` (which destructures `{ headless = false }`).
   In practice this means: `headless: false` explicit OR `headless`
   omitted entirely (undefined).

Headless acquisitions in container (`headless === true`) are
**intentionally allowed**. They are a legitimate non-interactive
workload: cookie-authenticated scrapes against an existing session,
fingerprint-only fetches, or anything that never needs to surface a
window to the operator. Failing those would block real Docker
deployments without addressing the silent-hang risk.

**Escape hatch:** `PDPP_ALLOW_HEADED_CONTAINER_BROWSER=1` bypasses the
gate. The runtime emits a per-acquisition stderr warning so the
override is visible in container logs. Intended for operators doing
local X11/VNC forwarding of a headed container browser; intentionally
not promoted in operator-facing documentation.

No spec delta required: the bridge OpenSpec change's design.md
already says "Docker runs SHALL fail or pause with an actionable
message rather than launching an invisible headed browser." A headless
container browser is not invisible — it is non-interactive by design.

## Implementation

1. New helper `packages/polyfill-connectors/src/runtime-environment.ts`
   exports `isRunningInContainer(env, deps)`. Detects via:
   - `PDPP_REFERENCE_MODE === "composed"` (authoritative for our
     compose stacks; set in `docker-compose.yml`),
   - `/.dockerenv` sentinel (catches plain `docker run`, Podman, and
     Compose deployments that omit the MODE env), or
   - `PDPP_FORCE_CONTAINER === "1"` (explicit override for tests and
     non-Docker container runtimes).

   Pure function; tests inject `fileExists` to control the outcome.

2. `acquireBrowserForConnector` adds a fail-closed branch in the
   `mode: "disabled"` arm gated on `effectiveHeadless === false &&
   isRunningInContainer()` AND
   `process.env.PDPP_ALLOW_HEADED_CONTAINER_BROWSER !== "1"`.
   Throws `HostBrowserBridgeUnavailableError` with the existing stable
   `host_browser_bridge_unavailable` code so the dashboard's existing
   `BridgeUnavailableSection` renders the deployment-config callout
   that the bridge OpenSpec change already shipped. Error message
   names the gate scope explicitly ("Headed (visible) browser-backed
   connector …" + "Headless container browsers are unaffected…") so
   operators never confuse it for a general Docker-can't-use-browsers
   failure.

3. The host-direct path is unchanged: an untouched host process won't
   match any container signal and continues to launch an isolated
   Patchright context against `~/.pdpp/profiles/<name>/`.

## Tests

`packages/polyfill-connectors/src/runtime-environment.test.ts`:
- clean host returns false,
- `PDPP_REFERENCE_MODE=composed` returns true,
- `/.dockerenv` presence returns true,
- `PDPP_FORCE_CONTAINER=1` returns true,
- arbitrary `PDPP_REFERENCE_MODE` values return false,
- whitespace is trimmed before matching,
- `fileExists` throws are treated as "not detected".

`packages/polyfill-connectors/src/browser-launch.test.ts`:
- Pure-helper unit tests for `decideContainerHeadedBrowserGate`:
  - host-direct headed (`headless: false`, not in container) → `proceed`.
  - host-direct headless (`headless: true`, not in container) → `proceed`.
  - HEADLESS in container (`headless: true`, in container) → `proceed`
    (legitimate non-interactive workload).
  - HEADED in container (`headless: false`, in container) → `fail_closed`.
  - Escape hatch downgrades HEADED-in-container to `warn_and_proceed`.
  - Escape hatch is a no-op outside container.
  - **Undefined `headless` in container → `fail_closed`** (regression
    for r3 owner review: matches `acquireIsolatedBrowser`'s default of
    `headless = false`).
  - Undefined `headless` outside container → `proceed`.
  - Explicit `headless: true` in container still `proceed`s after the
    undefined-as-headed fix.
- Integration tests (short-circuit before launcher work):
  - `acquireBrowserForConnector({ profileName, headless: false })` in
    container with no bridge → rejects with the typed error; message
    names `PDPP_HOST_BROWSER_BRIDGE_URL` and explicitly mentions that
    headless is unaffected.
  - `acquireBrowserForConnector({ profileName })` (omitted headless)
    in container with no bridge → rejects with the typed error
    (regression for r3).

## Out of scope

- Connector-side `kind=host_browser_required` interaction emission
  (already deferred per the bridge change's tasks.md).
- Profile-divergence between host bridge and in-container modes (P3
  finding #7 in the docker-ops audit).
- Promoting the escape-hatch into operator docs. Intentionally kept
  internal: the supported docker workflows are (a) host bridge for
  headed, (b) host-direct for headed, (c) headless in container for
  non-interactive.
