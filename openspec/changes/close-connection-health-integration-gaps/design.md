## Context

Six worktrees were spawned from `owner/connection-health-closeout-0710`
(merge-base `f2cbbd87f` with current `main`) to fix different symptoms of the
same underlying complaint: connection health rendered contradictory or
falsely-settled state for Slack, USAA, active runs, and Reddit scheduling. A
gate reviewer (`health-closeout-gate-0710-report.md`) rejected landing the
combined branch as-is. A later red-team pass on the current tree
(`health-contract-redteam-v2-0711.md`) re-verified which findings still apply
after the LFDT curation merge and added one new one (`anthropic` as a ninth
scaffold connector). This change reconciles both reviews against the six
lanes' actual commits rather than re-deriving the analysis from scratch.

## Decision: which commits are load-bearing vs rejected

| Lane | Commit(s) | Disposition | Reason |
|---|---|---|---|
| `usaa-autorecovery-0710` | `53ff53c8c` (scheduler-retry-classifier trusts explicit `retryable`) | **Keep** (as generic scheduler fix only) | Correct independent of the USAA-specific misclassification; both gate report and red-team agree. |
| `usaa-autorecovery-0710` | `14a2085ec` / `#294`'s connector-level bypass (folded via `53ff53c8c` branch lineage) | **Reject, revert** | Elevates a page-copy classifier match into a bypass of `manual_action` + asserted `retryable:true`. Falsified by the owner's own counter-evidence (works in a normal browser). |
| `usaa-profile-rootcause-0710` | `fbd553656` | **Keep** | Reverts the #294 bypass, restores `manual_action`, adds `captureDom` discriminating evidence. Definitively proven as a control-flow bug fix; the underlying stall cause is correctly left as inferred, not claimed proven. |
| `health-active-run-0710` | `41bad54e7` | **Keep** | Fixes the amber `Needs refresh`/`refresh_now` vs advancing-run contradiction in both `rendered-verdict.ts` and `source-actionability.ts`; includes a proportionate, behavior-preserving `buildRequiredActions` extraction to stay under the pre-tranche complexity ceiling. |
| `manual-freshness-policy-0710` | `be56bcf7c`, `c8f670457` | **Keep** | Reddit's `background_safe:false` rationale conflated static-secret storage with interactive-login friction; the connector's own code documents the same friction class Amazon's manifest already names, and grant #296 already established the precedent. Also carries the three pre-existing Amazon-related test fixes from #296 that were already broken on main before this lane touched them. |
| `bundled-coverage-audit-0710` | (read-only report, no commit) | **Adopt findings, not code** | Confirms Slack Finding 4 is superseded by the slack-full-coverage lane; surfaces Finding 1 (scaffold blind spot), which this change closes. |
| `schedule-all-eligible-0710` | (read-only report, no commit) | **Adopt findings, not code** | Live point-in-time matrix; confirms Reddit/USAA/rendered-verdict lineage and flags a Slack run-duration/backlog risk and a ChatGPT jitter hygiene fix as owner follow-ups, not blocking this change. |
| `slack-full-coverage-0710` | `8a766c9f6`, `2010f4e7a` | **Keep** | Independently re-verified by the red-team pass against the current tree; source-reachability proven by reading `rusq/slackdump` and `rusq/slack` directly, not assumed. This is the one item both reviews treat as load-bearing to close the P0. |
| `accepted-absence-ui-0710` | `fa5be19ae` | **Keep, re-scoped** | Copy-only fix is safe on its own terms (verified by its own tests distinguishing accepted-absence from `unknown`/`checking`), but only becomes non-misleading for Slack once the four streams are no longer accepted-absence at all. Ship together, not as a substitute for the Slack port. |
| `owner/connection-health-closeout-0710` (whole branch) | everything else in `f2cbbd87f..9522ac774` not named above | **Reject** | Gate-reviewed and rejected as a full closeout; no additional independent justification found for any other piece during this integration. |
| `waspflow/fx-suite-v2-0711` | `3d7aff2ac` | **Keep** | Ratified test-only fix: two tests still referenced Amazon where the manifest/behavior contract had already moved the assertion to USAA; not a behavior change. |

## Decision: scaffold gate design — conformance test on existing contract, no new manifest field

The owner picker (`isPublicReferenceConnector` in
`reference-implementation/server/ref-control.ts`) already hides every
scaffold connector today: all 9 declare `capabilities.public_listing.listed:
false`. This is not a live bug, and `public_listing.listed` already owns
owner-picker eligibility — it is the one correct place for that decision to
live. Manifest semantics are not free; this change does not add a second,
parallel manifest truth (`implementation_status`) to express something the
existing contract can already express through a conformance test.

The actual gap: nothing today *proves* a `public_listing.listed:true`
connector has real collection behind its `required:true` streams, or catches
a future accidental flip of a scaffold to `listed:true`. The fix is a
conformance gate over the existing fields plus the connector's own
implementation — the same "static source scan + hand-maintained roster
cross-check" pattern `provider-profile-conformance.test.ts` already
establishes for provider pacing profiles, not a new declared-truth field.

A static source/AST scan for `emitRecord(` was considered and rejected (see
Alternatives): it couples the gate to implementation syntax and helper
composition style (YNAB's `trackAndEmit`/`emitDetailCoverage` wrapper already
demonstrates a call shape a naive scan would miss), and is exactly the kind
of fragile, syntax-shaped inference the reason-string regex problem already
warned against — just moved to a different string. Fabricating a generic
fixture-replay runner for all 33 heterogeneous connectors was also rejected:
each connector's own test suite (parsers/integration/schemas) is already the
correct behavioral oracle, shaped to that connector; no single runner should
try to re-execute all of them generically.

Chosen fix: a TEST-ONLY explicit **production-ready connector roster**,
`packages/polyfill-connectors/src/connector-conformance-roster.ts`
(hand-maintained data) plus
`packages/polyfill-connectors/src/connector-conformance.test.ts`
(the executable cross-check):

1. `PRODUCTION_READY_CONNECTORS` names every connector this repo lists as
   owner-selectable, each entry pointing at that connector's own named
   existing collection/integration test file (its behavioral oracle — this
   gate does not re-run or reprove it).
2. `KNOWN_SCAFFOLD_CONNECTORS` names the 9 connectors with no real collection
   (`anthropic`, `doordash`, `heb`, `linkedin`, `loom`, `meta`, `shopify`,
   `uber`, `wholefoods`).
3. The test asserts, purely against the existing manifest field: the roster's
   connector set matches exactly which manifests declare
   `capabilities.public_listing.listed === true` (drift either direction
   fails CI); every roster `testFile` exists on disk; the two rosters are
   disjoint from each other; and known scaffolds are never listed.

This is an auditable test harness over the existing `public_listing`
contract, not a manifest semantic and not a claim that one generic runner
executes every connector — each connector's own suite remains the sole
behavioral oracle for whether it really collects real data.

## Alternatives considered

- **Add `capabilities.implementation_status: "scaffolded" | "shipped"` to
  every manifest.** Rejected on owner correction: `public_listing.listed`
  already owns owner-picker eligibility, and manifest semantics are not free.
  A second field asserting the same fact as `public_listing.listed` (whether
  a connector is real) is redundant truth that can drift from the first
  without either being caught, unless a test cross-checks them — at which
  point the test alone is the correct artifact and the field adds nothing.
  Introducing a new field would only be justified if the invariant could not
  be expressed over `public_listing` plus a conformance check of the
  implementation; it can, so the field is rejected.
- **Statically scan connector source for `emitRecord(`/`RECORD` call
  sites.** Rejected on owner correction: this couples validity to
  implementation syntax and breaks under helper abstractions (YNAB's
  `trackAndEmit`/`emitDetailCoverage` composition already would not match a
  naive `emitRecord(` grep). It is the same class of fragile inference as the
  reason-string regex problem, just relocated from runtime skip reasons to
  source text. The roster-plus-fixture-execution design instead observes
  real, executed behavior, which cannot be gamed by a refactor that changes
  nothing about actual emission.
- **Rely on the existing reason-string regex classification
  (`mapSkipCoverageCondition`) as sufficient.** Rejected: this is exactly the
  fragility both reviews flagged — a future incidental match against
  `RETRYABLE_SKIP_REASON_PATTERN`/`DEFERRED_SKIP_REASON_PATTERN`/etc. could
  silently reclassify a scaffold's skip as non-terminal. The conformance
  roster does not depend on reason strings at all; it depends on fixture
  -executed, observed emission.
- **Build one generic fixture-replay runner that executes every connector's
  `collect()` against a committed fixture.** Rejected: connectors are
  heterogeneous (browser/API/filesystem-backed, custom emit helpers, no
  uniform harness), and a generic runner would either be fake for
  browser-only connectors or require substantial new infrastructure out of
  scope for this change. Each connector's own existing test file is already
  the correct, connector-shaped oracle; the roster only needs to name it and
  assert it exists, not re-implement it.
- **Wire a new runtime branch into `connector-coverage-policy.ts` scoring.**
  Rejected: `terminal_gap` is already the correct, worst-case, non-green
  outcome, and no live connection currently depends on a scaffold connector
  (confirmed by the schedule-all-eligible audit's live matrix, which lists
  none of the 9 scaffolds among the 17 active connections). A new runtime
  branch would be complexity without a proven present defect; the
  conformance test closes the actual risk (silent future drift into
  `listed:true` or a real emission path appearing without roster upkeep) at
  build time instead.
- **Mark Slack's four streams `required:false` with a "documented gap"
  policy instead of implementing collection.** Rejected per explicit owner
  instruction: do not solve source-reachable-stream honesty by demoting the
  streams to optional. The correct fix is collecting what the credential can
  reach.
- **Leave USAA's `53ff53c8c` and `#294`'s bypass bundled as one commit to
  revert together.** Rejected: `53ff53c8c` is independently correct (both
  reviews agree) and touches the generic scheduler seam, not USAA-specific
  logic; reverting it along with the bad bypass would regress an unrelated,
  proven-good fix.

## Residual risk (explicitly owner-only, not blocking this change)

- Live deployed-revision check, live `pnpm stream-health:audit`, next USAA
  live manual-action/capture result, and a live schedule re-pull after deploy
  are all named in the red-team report as required before asking the owner to
  retest. This change does not and cannot satisfy those from a worktree.
