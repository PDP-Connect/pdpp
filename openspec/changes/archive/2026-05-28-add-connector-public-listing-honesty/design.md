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
4. A parallel dishonesty appears when a manifest declares
   `public_listing.status: "needs_human_auth"` while keeping
   `refresh_policy.background_safe: true` or
   `recommended_mode: "automatic"`. The reference today models no
   durable no-human unattended auth capability — every connector in
   this bucket (Amazon, Chase, ChatGPT, Reddit, USAA) needs an
   operator to supply credentials, complete an OTP challenge, or
   perform a manual browser action before a run can succeed. Letting
   any of these enter the automatic scheduler guarantees consecutive
   failures (Reddit reached 12 in a row in the 2026-05-15 reference
   deployment before this rule was added). So the policy SHALL forbid
   the combination at the manifest layer. The rule remains conditional
   on the absent capability: if a future manifest models a durable
   unattended auth path explicitly, that capability can lift the
   restriction.
5. The data-driven test over the whole manifest set is the cheapest
   ongoing enforcement: new manifests fail loudly if they skip the
   declaration.
6. The catalog filter only ever sees connectors that are *registered*
   in the connectors table. Today that table is populated lazily —
   `pdpp seed`, scheduler bootstrap, or a manual run is what creates a
   row. As a result, listed=true first-party manifests that no
   operator has yet exercised (e.g. `notion`, `oura`, `strava`) never
   reach `GET /_ref/connectors`. The catalog is therefore *not*
   honestly complete: the catalog filter says "we are showing every
   listed manifest" but actually shows only the subset the operator
   has already touched. The minimum repair is to make
   `reconcilePolyfillManifests` register shipped manifests with
   `public_listing.listed: true` on startup. This stays narrow:
       - Only the shipped first-party manifests dir is scanned, so
         custom user-authored connectors are still left alone.
       - Only listed=true manifests are registered, so unproven and
         hidden manifests stay invisible (and the existing
         fixture→polyfill invalidation guarantee, which fires only on
         persisted-record diffs, remains unreachable on first
         registration).
       - Registration is not schedule enablement; the scheduler
         eligibility filter and the operator-driven schedule path
         continue to gate background runs on their own terms.
7. Pocket is the load-bearing motivating case for the
   `deprecated_upstream` status. `CONNECTORS.md` already documents
   that Mozilla shut Pocket down on 2025-07-08, but the manifest still
   declared `listed: true, status: "proven", background_safe: true,
   recommended_mode: "automatic"`. The existing `unproven` status was
   the wrong fit (we have nothing to prove against a dead API; it is
   not a "we never tried" case), so the spec gains a distinct
   `deprecated_upstream` status that pairs with `listed: false` and
   bans the background-safe / automatic combinations.

## Scope

In scope:
- `reference-implementation-architecture` capability requirements that
  describe the reference catalog filter, the catalog/scheduler
  interlock, the catalog-completeness rule for listed first-party
  manifests, and the `deprecated_upstream` honesty rules.
- A data-driven test in
  `packages/polyfill-connectors/src/public-listing-manifest-honesty.test.ts`
  that iterates all manifests.
- Manifest edits for the 14 unproven first-party manifests so each
  declares `public_listing.listed: false, status: "unproven"`.
- A manifest edit for Pocket to flip from the stale
  `listed: true, status: "proven", background_safe: true,
  recommended_mode: "automatic"` shape to
  `listed: false, status: "deprecated_upstream",
  background_safe: false, recommended_mode: "manual"`, reflecting
  Mozilla's 2025-07-08 shutdown documented in
  `packages/polyfill-connectors/CONNECTORS.md`.
- A narrow extension to `reconcilePolyfillManifests` that
  auto-registers shipped first-party manifests with
  `public_listing.listed: true` so the operator catalog can show them
  on a fresh DB; an end-to-end test that pins both the
  listed-visible and hidden-invisible paths.

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
- No manifest has `public_listing.status: "needs_human_auth"`
  together with `refresh_policy.background_safe: true` or
  `refresh_policy.recommended_mode: "automatic"`.
- No manifest has `public_listing.status: "deprecated_upstream"`
  together with `listed: true`, `refresh_policy.background_safe: true`,
  or `refresh_policy.recommended_mode: "automatic"`.
- Every first-party manifest with
  `capabilities.public_listing.listed: true` appears in
  `listConnectorSummaries()` after
  `reconcilePolyfillManifests` runs against the shipped manifests dir
  on a fresh database, and every hidden manifest stays invisible.
- `node --test packages/polyfill-connectors/src/public-listing-manifest-honesty.test.ts`
  iterates the manifest set and passes.
- `node --test reference-implementation/test/ref-connectors-list-operation.test.js`
  continues to pass.
- `node --test reference-implementation/test/polyfill-manifest-reconcile-invalidation.test.js`
  passes with the listed/unlisted catalog-completeness cases.
- `node --test reference-implementation/test/connector-public-catalog-completeness.test.js`
  passes against the real shipped manifests.
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
