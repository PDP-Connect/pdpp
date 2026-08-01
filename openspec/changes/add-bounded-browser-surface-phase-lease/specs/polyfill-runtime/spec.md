## ADDED Requirements

### Requirement: A connector SHALL be able to request a managed browser surface for a bounded mid-run phase

The connector runtime protocol SHALL provide a `BROWSER_SURFACE_REQUEST` /
`BROWSER_SURFACE_RESPONSE` message pair, mirroring the existing
`DETAIL_GAPS_PAGE` request/response pair, so a running connector subprocess
can acquire and release a managed browser surface for a bounded phase of its
run instead of only at spawn. `BaseCollectContext` SHALL expose this as
`requestBrowserSurfacePhase()`, returning a handle carrying `remoteCdpUrl`,
`leaseId`, an `env` overlay shaped like the existing
`browserSurfaceLeaseEnv` output, and an idempotent `release()`.

The granted `remoteCdpUrl` SHALL reach the connector as an explicit value in
the returned `env` overlay, composable with the existing
`resolveBrowserLaunchSource(visibility, env)` seam. It SHALL NOT be delivered
by mutating `process.env`.

A phase acquire response of `unavailable` SHALL NOT cause the connector to
fall back to a local/unmanaged browser when a managed surface is required.
The connector SHALL surface its own existing honest failure/degradation
handle instead.

#### Scenario: Connector acquires and releases a bounded phase surface

- **WHEN** a connector calls `requestBrowserSurfacePhase()` mid-run and the
  controller grants a surface
- **THEN** the returned handle SHALL carry a `remoteCdpUrl`, a `leaseId`, and
  an `env` overlay usable directly with `resolveBrowserLaunchSource`
- **AND** calling `release()` on the handle SHALL release the underlying
  lease and SHALL be safe to call more than once.

#### Scenario: Phase request never waits unboundedly

- **WHEN** the controller does not respond to a `BROWSER_SURFACE_REQUEST`
  within the configured timeout, or stdin closes while the request is
  outstanding
- **THEN** `requestBrowserSurfacePhase()` SHALL settle (resolve or reject)
  rather than hang
- **AND** its protocol listener SHALL be removed on resolve, reject, timeout,
  and close, so no listener accumulates across repeated phase requests.

#### Scenario: Unavailable surface does not fall back to a local browser

- **WHEN** `requestBrowserSurfacePhase()` resolves with `status: "unavailable"`
  for a connector where a managed surface is required
- **THEN** the connector SHALL NOT acquire or fall back to an unmanaged local
  browser for that phase
- **AND** it SHALL produce its own existing failure/degradation path instead.

### Requirement: A connector's browser-surface policy SHALL declare whether it needs a surface for its whole run or only for bounded phases

`packages/polyfill-connectors/src/browser-surface-policy.ts` SHALL declare a
`surfaceScope?: "run" | "phase"` field per connector runtime name, alongside
the existing retention/page-preservation fields. `"run"` (the default when
unspecified) SHALL preserve today's pre-spawn whole-run managed-surface
reservation unchanged. `"phase"` SHALL declare that the connector needs a
managed surface only for bounded phases of its run and that the controller
SHALL NOT reserve a run-level surface for it at spawn.

This field SHALL be the single declared source of phase-vs-run scope; no
connector-specific allowlist or branch elsewhere in the scheduler or
controller SHALL duplicate this decision.

#### Scenario: Unmodified connector is unaffected

- **WHEN** a connector's policy entry does not declare `surfaceScope`
- **THEN** it SHALL behave exactly as `"run"` — an unchanged pre-spawn
  whole-run surface reservation.

#### Scenario: Phase-scoped connector reserves no run-level surface

- **WHEN** a connector's policy entry declares `surfaceScope: "phase"`
- **THEN** the controller SHALL NOT reserve a managed browser surface for
  that connector's run at spawn
- **AND** the connector SHALL be able to request a surface mid-run via
  `requestBrowserSurfacePhase()`.
