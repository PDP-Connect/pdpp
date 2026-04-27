# In-container fail-closed gate for browser-backed connectors (P1)

Date: 2026-04-27
Status: implemented (code change, no spec delta)
Author: docker-ops bughunt lane

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
mandates the desired behavior; we are closing the implementation gap.
No spec delta required.

Implementation:

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
   `mode: "disabled"` arm: when `isRunningInContainer()` is true, it
   throws `HostBrowserBridgeUnavailableError` with the existing stable
   `host_browser_bridge_unavailable` code so the dashboard's existing
   `BridgeUnavailableSection` renders the deployment-config callout
   that the bridge OpenSpec change already shipped.

3. The host-direct path is unchanged: an untouched host process won't
   match any container signal and continues to launch an isolated
   Patchright context against `~/.pdpp/profiles/<name>/`.

## Rationale for "no spec change"

The bridge OpenSpec change's design.md already says: "If the bridge is
not configured, Docker runs SHALL fail or pause with an actionable
message rather than launching an invisible headed browser." We are
closing the implementation gap that
`tasks.md:39` (the "remaining gap is stricter fail-fast behavior" line
in README) already flagged as outstanding. No new spec assertion is
introduced.

## Tests

- `packages/polyfill-connectors/src/runtime-environment.test.ts`:
  - clean host returns false,
  - `PDPP_REFERENCE_MODE=composed` returns true,
  - `/.dockerenv` presence returns true,
  - `PDPP_FORCE_CONTAINER=1` returns true,
  - arbitrary `PDPP_REFERENCE_MODE` values return false,
  - whitespace is trimmed before matching,
  - `fileExists` throws are treated as "not detected".
- `packages/polyfill-connectors/src/browser-launch.test.ts`:
  - `acquireBrowserForConnector` rejects with
    `HostBrowserBridgeUnavailableError` when
    `PDPP_REFERENCE_MODE=composed` and bridge URL is empty, and the
    error carries the stable code, `bridgeUrl: null`, and an
    actionable message naming `PDPP_HOST_BROWSER_BRIDGE_URL`.
  - Same for `PDPP_FORCE_CONTAINER=1`.

## Out of scope

- Connector-side `kind=host_browser_required` interaction emission
  (already deferred per the bridge change's tasks.md).
- Profile-divergence between host bridge and in-container modes (P3
  finding #7 in the docker-ops audit).
