# Design — Connector Public Listing Honesty

## Context

The design note
`design-notes/connector-public-listing-honesty-2026-05-15.md` decided
that the reference deployment SHALL expose a connector maturity layer
distinct from the PDPP protocol contract. The implementation already
has the right machinery:

- `reference-implementation/server/ref-control.ts:isPublicReferenceConnector`
  filters `_ref/connectors` rows by manifest `public_listing` and by a
  hard-coded `NON_PUBLIC_CONNECTOR_ID_PARTS` list for known stubs.
- `reference-implementation/server/index.js:createReferenceSchedulerManager`
  filters scheduler-eligible connectors by
  `refresh_policy.background_safe` (`index.js:6309`).
- `packages/polyfill-connectors/src/public-listing-manifest-honesty.test.ts`
  pins Spotify and iMessage to the honest defaults.

What is missing is the **policy** layer: nothing forces a new manifest
to declare its listing status, nothing prevents a hidden manifest from
turning back on a background schedule, and the per-manifest test only
covers two of 31 first-party manifests.

## Derivation

The policy is the minimum that makes the existing filter trustworthy.

1. The reference catalog filter already inspects `public_listing` and
   the stub-id list, but treats "no `public_listing` block" as
   default-visible. The audit on 2026-05-15 found 14 first-party
   manifests sitting on that fallback with no Docker proof. Either the
   default needs to flip, or every manifest needs to declare. The
   latter is the safer choice because flipping the default would also
   hide proven connectors that never bothered to declare. So:
   declaration is mandatory and unproven manifests SHALL set
   `listed: false, status: "unproven"`.
2. The scheduler eligibility check is independent from the catalog
   filter. Today a manifest could in principle set
   `public_listing.listed: false` and `refresh_policy.background_safe:
   true` simultaneously — a connector hidden from operators but quietly
   running every interval. That violates the honesty bar. So the
   policy SHALL forbid the combination at the manifest layer.
3. The same dishonesty appears when a manifest declares
   `public_listing.status: "broken_in_current_deployment"` while
   keeping `refresh_policy.background_safe: true` or
   `recommended_mode: "automatic"`. The reference deployment already
   knows the runtime is broken (missing external tool, unresolved
   browser challenge, invalid deployment binding, etc.); advertising an
   automatic schedule under those conditions guarantees noisy failures
   on every tick. So the policy SHALL forbid the combination at the
   manifest layer, surfacing the breakage as manual-only until the
   underlying issue is resolved.
4. The data-driven test over the whole manifest set is the cheapest
   ongoing enforcement: new manifests fail loudly if they skip the
   declaration.

## Scope

In scope:
- `reference-implementation-architecture` capability requirements that
  describe the reference catalog filter and the catalog/scheduler
  interlock.
- A data-driven test in
  `packages/polyfill-connectors/src/public-listing-manifest-honesty.test.ts`
  that iterates all manifests.
- Manifest edits for the 14 unproven first-party manifests so each
  declares `public_listing.listed: false, status: "unproven"`.

Out of scope:
- Any change to PDPP protocol fields. `public_listing` and
  `refresh_policy` remain reference-implementation manifest metadata.
- Any change to scheduler eligibility semantics for already-proven
  connectors. `reddit` keeps its current
  `refresh_policy.background_safe: true` because it is a real
  connector blocked only on credentials, not on a runtime breakage; its
  schedule honesty is a separate workstream.
- A `connector_maturity` enum at the spec layer. The design note's
  five-bucket taxonomy is informative; this tranche encodes only the
  two states the catalog filter uses today (`listed` and `status`).
- Dashboard UI changes beyond what the existing `_ref/connectors`
  response already drives.

## Alternatives Considered

- **Flip the default to "hidden unless declared."** Cleaner in
  principle but riskier: a single proven manifest without
  `public_listing` would silently disappear from the catalog. The
  declaration-mandatory rule plus the data-driven test gives the same
  guarantee without that footgun.
- **Promote `public_listing` to the PDPP protocol manifest contract.**
  Out of scope. The protocol does not need to know whether the
  reference deployment has run a given connector. Keeping it reference-
  scoped preserves the boundary called out in the design note.

## Acceptance

- All first-party manifests under
  `packages/polyfill-connectors/manifests/` have
  `capabilities.public_listing.listed` declared as a boolean.
- No manifest has `public_listing.listed !== true` together with
  `refresh_policy.background_safe: true`.
- No manifest has `public_listing.status:
  "broken_in_current_deployment"` together with
  `refresh_policy.background_safe: true` or
  `refresh_policy.recommended_mode: "automatic"`.
- `node --test packages/polyfill-connectors/src/public-listing-manifest-honesty.test.ts`
  iterates the manifest set and passes.
- `node --test reference-implementation/test/ref-connectors-list-operation.test.js`
  continues to pass.
- `openspec validate add-connector-public-listing-honesty --strict`
  passes.

## Risks

- Adding `public_listing` to a manifest that the dashboard or another
  consumer reads downstream could surprise readers expecting a missing
  field. Existing readers default to "visible," so adding
  `listed: false` only narrows visibility for unproven manifests; no
  proven manifest changes state.
- The hidden+background-safe interlock is enforced at the manifest
  test, not at runtime. A future runtime audit could fold the same
  check into the scheduler manager. That is left as follow-up so this
  tranche stays narrow.
