# Connector Public Listing Honesty

## Why

The reference Docker deployment registers proven connectors, unproven
manifests, local-only readers, and e2e stubs through one manifest path.
Today only `spotify` and `imessage` declare their listing status
explicitly. The other 14 unproven first-party manifests rely on the
default-visible fallback in `isPublicReferenceConnector` and therefore
appear in `GET /_ref/connectors` as if they were ready. This breaks the
SLVP honesty bar called out in
`design-notes/connector-public-listing-honesty-2026-05-15.md`: operators
cannot distinguish "proven working" from "manifested but never run."

## What Changes

- Codify the reference-only connector public-listing policy that
  `reference-implementation/server/ref-control.ts:isPublicReferenceConnector`
  already encodes: stub connector IDs, `public_listing.listed: false`,
  `public_listing.status: "unproven"`, and unguarded `local_device`
  bindings SHALL NOT appear in the default public connector catalog.
- Require every first-party manifest under
  `packages/polyfill-connectors/manifests/` to declare
  `capabilities.public_listing` explicitly instead of relying on the
  default-visible fallback. Unproven manifests SHALL set
  `listed: false, status: "unproven"`.
- Forbid the silent combination of "hidden from catalog" plus
  "background-safe": a manifest that is not publicly listed SHALL NOT
  declare `refresh_policy.background_safe: true`, so that the existing
  scheduler eligibility filter
  (`reference-implementation/server/index.js:6309`) cannot quietly run
  a hidden connector on a schedule.
- Forbid the schedule-dishonest combination of "broken in current
  deployment" plus "background-safe" or "automatic": a manifest whose
  `public_listing.status` is `"broken_in_current_deployment"` SHALL NOT
  declare `refresh_policy.background_safe: true` and SHALL NOT declare
  `refresh_policy.recommended_mode: "automatic"`, so a known-broken
  connector cannot keep advertising itself as automatically
  schedulable.
- Forbid the schedule-dishonest combination of "needs human auth" plus
  "background-safe" or "automatic": a manifest whose
  `public_listing.status` is `"needs_human_auth"` SHALL NOT declare
  `refresh_policy.background_safe: true` and SHALL NOT declare
  `refresh_policy.recommended_mode: "automatic"`. No durable
  no-human unattended auth capability is modeled today, so a connector
  that needs a human in the loop to authenticate cannot honestly
  advertise itself as automatically schedulable.
- Forbid the dishonest combination of "deprecated upstream" plus
  "listed" / "background-safe" / "automatic": a manifest whose
  `public_listing.status` is `"deprecated_upstream"` SHALL declare
  `public_listing.listed: false` and SHALL NOT declare
  `refresh_policy.background_safe: true` or
  `refresh_policy.recommended_mode: "automatic"`. The motivating
  case is Pocket, which Mozilla shut down on 2025-07-08: the existing
  manifest still declared `listed: true, status: "proven",
  background_safe: true, recommended_mode: "automatic"` even though
  the upstream API no longer exists, so honesty requires both the
  catalog hide and the schedule-eligibility hide at the manifest
  layer.
- Require the reference operator catalog to be complete on a fresh
  database: every first-party manifest under
  `packages/polyfill-connectors/manifests/` with
  `capabilities.public_listing.listed: true` SHALL appear in
  `GET /_ref/connectors` after `reconcilePolyfillManifests` runs on
  startup, without requiring a prior schedule or run row. Registration
  is NOT schedule enablement; scheduler eligibility continues to gate
  background runs through `refresh_policy.background_safe`. Hidden /
  unproven manifests, custom user-supplied manifests outside the
  shipped set, and stub connector IDs SHALL NOT be auto-registered by
  this path.
- Replace the single-connector spot tests
  (`public-listing-manifest-honesty.test.ts`) with a data-driven test
  over the whole manifest set, plus an end-to-end
  `connector-public-catalog-completeness` test that wires the shipped
  manifests dir through `reconcilePolyfillManifests` and
  `listConnectorSummaries` to pin the catalog contract.

This change touches reference/operator catalog and scheduler behavior
only. PDPP protocol-level connector semantics are unchanged.

## Capabilities

### Modified Capabilities

- `reference-implementation-architecture` — adds normative requirements
  for the reference-only connector catalog filter and its scheduler
  eligibility interlock.

## Impact

- Operators reading `GET /_ref/connectors` see only connectors that have
  been declared as ready or that lack any "unproven" / "hidden" /
  "local_device" signal.
- Connectors marked hidden cannot be silently scheduled in Docker; the
  manifest must explicitly opt in via `public_listing.listed: true`
  before scheduler eligibility is considered.
- No PDPP protocol contract changes. No public client-facing API change
  beyond the operator-only `_ref` surface.
- No proven, currently green connector is hidden or unscheduled by this
  change.
- The Pocket manifest flips from
  `listed: true, status: "proven", background_safe: true,
  recommended_mode: "automatic"` to
  `listed: false, status: "deprecated_upstream", background_safe: false,
  recommended_mode: "manual"`, aligning the manifest with the upstream
  API shutdown documented in `packages/polyfill-connectors/CONNECTORS.md`.
- Listed first-party manifests that were not previously exercised by a
  schedule or run row (`notion`, `oura`, `strava`) are auto-registered
  by `reconcilePolyfillManifests` on startup so the operator catalog is
  complete on a fresh database. Their schedules remain disabled until
  the operator explicitly enables them.
