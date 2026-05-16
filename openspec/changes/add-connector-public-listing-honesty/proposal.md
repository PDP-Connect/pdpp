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
- Replace the single-connector spot tests
  (`public-listing-manifest-honesty.test.ts`) with a data-driven test
  over the whole manifest set.

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
