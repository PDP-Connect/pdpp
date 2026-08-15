## Context

The reference runtime (`reference-implementation/runtime/index.ts`) and its manifest validator (`reference-implementation/server/connector-manifest-validation.ts`) already implement a complete checkpoint-dependency model:

- Two manifest fields, `state_stream` (single static parent) and `parent_streams` (one or more parents, gated by live `DETAIL_COVERAGE`), each validated for self-reference, unknown-stream, and duplicate-parent at manifest registration.
- `DETAIL_COVERAGE`/`DETAIL_GAP` wire messages, with `resolveStateStreamsForDataStream` computing each data stream's checkpoint parent(s) as: live-run `DETAIL_COVERAGE.state_stream` values (unioned) if any were observed this run, else the manifest declaration, else self-mapping.
- An eligible-checkpoint computation in `handleDoneClose` that unions failed-stream checkpoint parents with detail-coverage-shortfall checkpoint streams, and commits everything else.
- A process-close precedence order (`runTimedOut` → `ownerCancelRequested` → `doneMessage` → generic exit) that means an owner cancellation always pre-empts evaluating a certified stream-scoped failure, even if the connector's final DONE would otherwise qualify.

None of this is in the public `spec-collection-profile.md`. The profile's only textual reference to the mechanism is one sentence under `STATE` mentioning `state_stream` without defining it, and the message union (§5 TypeScript types) has no `DETAIL_COVERAGE`/`DETAIL_GAP` variant at all. This is the exact defect an independent review identified: the exception that lets a failed run commit sibling checkpoints depends on machinery a second implementer cannot discover from the normative spec.

## Goals / Non-Goals

**Goals:**

- Make the shipped algorithm fully derivable from the public profile alone, so an independent connector or runtime author can implement interoperable checkpoint-dependency behavior without reading reference-implementation source.
- Close the specific ambiguities the review flagged: manifest placement/type/cardinality, wire shapes, validation, precedence, the eligible-checkpoint algorithm, and the `recovery_hint` empty-object case.
- Add conformance evidence for the parts of the review's test matrix that no existing test — RI-level or otherwise — covers.

**Non-Goals:**

- Changing any shipped runtime behavior. Every rule in this change describes code that already runs in production; this is a documentation-and-conformance change, not a behavior change.
- Redefining `coverage_strategy`'s full five-value enum (`checkpoint_window`, `full_inventory`, `parent_detail_accounting`, `snapshot_import_receipt`, `singleton_presence`) or its non-checkpoint-dependency values — that is broader RI-internal surface than the checkpoint-dependency P1 requires. The profile references `coverage_strategy` only insofar as it gates which of `state_stream`/`parent_streams` is legal.
- Adding transitive (multi-level) checkpoint-parent chain resolution. The reference implementation validates and resolves exactly one level (a stream's direct parent(s)); the profile documents this as the conformance floor and leaves deeper chains to a future revision if a real connector needs them.

## Decisions

### Promote shipped RI semantics verbatim rather than redesigning

The existing algorithm is coherent: it has real validation (self-reference, unknown-parent, duplicate, cycle-free-by-construction since only direct parents are declared), a defensible precedence rule (live evidence wins over static declaration because it describes the actual run, not just the connector's declared capability), and machine-checked evidence gates (`gap_keys` must be backed by a matching `DETAIL_GAP`; `optional_skip_keys` requires an affirmative terminal-unavailability check, not a bare HTTP status). Rewriting or redesigning this risks a spec/implementation split the moment either side next changes. Promoting it verbatim, in the same vocabulary the source comments already use, keeps spec and code in lockstep per `CONTRIBUTING.md`.

Alternative considered: Option A from the review (narrow the exception to same-stream sibling failures only, defer multi-parent detail coverage to a later revision). Rejected because the shipped runtime, GroupMe connector, and existing tests already depend on the multi-parent behavior in production; narrowing the spec would make already-running code non-conformant rather than closing the gap.

### Explicit cycle-rejection rule despite no runtime cycle-detection code found

The manifest validator rejects self-reference and unknown parents but has no generic graph-cycle check, because only direct (one-level) parent declarations are supported — a stream cannot transitively chain through an intermediate parent today, so a "cycle" beyond a 2-node self-loop (already rejected as self-reference) is not currently constructible through the validated fields. The profile states the cycle rule normatively anyway (a manifest MUST NOT create one) so that a future runtime implementing deeper chain resolution has a normative floor to validate against, and marks the current one-level restriction as an explicit non-normative implementation note rather than silently baking the reference implementation's current limit into the requirement.

### `recovery_hint` empty/retryability-only object: fall through, don't reject

`isValidRecoveryHintShape({})` and `isValidRecoveryHintShape({ retryable: true })` both currently return `true` in the shipped validator, and `normalizeRecoveryHint` falls through to the runtime's generic inferred-action policy for both shapes today (`packages/../reference-implementation/runtime/connector-gap-bounding.ts`). Making `action` required (this change's alternative considered) would break every currently-valid `{}`/`{retryable}` emission across existing connectors and require a runtime code change — out of scope for a documentation-only change with no coordinated connector migration. Documenting the shipped fallback behavior as normative (present-but-actionless hint = "no action requested," but `retryable` still honored as authoritative input to the fallback policy) resolves the interoperability ambiguity without an incompatible change.

Alternative: treat empty object as a protocol violation. Rejected for the reason above (incompatible with shipped connectors) and because the review's own required resolution offered "explicitly define retryability-only semantics" as an acceptable alternative to requiring `action`.

## Risks / Trade-offs

- [A future runtime change alters `resolveStateStreamsForDataStream`'s precedence order without updating the profile] → The profile's algorithm section cross-references the exact function's behavior in commit history findable via `git blame`; a reviewer changing this function should update `spec-collection-profile.md` in the same PR per `CONTRIBUTING.md`'s "keep specs and code in lockstep."
- [The new conformance fixtures assert against RI-internal function names or mocks rather than wire-observable behavior] → Fixtures spawn a real subprocess connector stub speaking JSONL over stdio against the real HTTP server (the same idiom as `runtime-stream-collection-failed-commit.test.ts`), asserting only on `checkpoint_summary`, `/v1/state`, and timeline responses.
- [Postgres parity fixture becomes stale if `PDPP_TEST_POSTGRES_URL` is never set in CI] → Matches the existing project convention (`connector-state-scheduler-conformance-postgres.test.ts`): the fixture registers a single skipped test when the env var is absent, so its existence is still enforced by presence, not silently dropped.

## Migration Plan

1. Land the profile text and conformance fixtures together; no runtime or connector code changes.
2. Run `pnpm spec:check`, the new fixtures, and the existing checkpoint-eligibility suite to confirm the promoted text matches observed behavior exactly.
3. No rollback risk beyond reverting documentation and test files — no production behavior is touched.

## Addendum: independent checker review disposition

An independent review (`CHECKPOINT-CONTRACT-REVIEW.md`) against the pre-correction commit found several additional issues beyond the `recovery_hint` P0 (already fixed before the review ran). Disposition:

- **`coverage_strategy` gating undocumented (confirmed real).** Fixed: added `coverage_strategy` to the manifest field table, the two declaration-shape bullets, and a new Validation rule 7.
- **`parent_streams` fallback allegedly broken (disproven).** The reviewer's static read of `resolveStateStreamsForDataStream` in isolation missed that `detailCoverageStateStreamsByStream` is seeded from `manifestDetailParentStreamsByStream` at closure initialization (`runtime/index.ts:2715-2717`), several hundred lines before the function itself. Two independent, instrumented, subprocess-driven empirical tests (one with complete `DETAIL_COVERAGE` reported to isolate this mechanism from the separate coverage-shortfall path) proved the manifest fallback resolves correctly. No spec or code change was needed; this finding does not survive re-verification against running behavior.
- **Partial checkpoint-store failure identity granularity (confirmed real).** The original spec text claimed the runtime "MUST report exactly which checkpoint streams were staged and which were durably committed" as if from a single object; `checkpoint_summary` itself only exposes counts. Fixed: narrowed the claim to describe the actual, distributed identity contract — bounded counts in one place, the failing stream's identity in the rejected error's message, and each committed stream's identity via per-stream timeline events and durable state. Added assertions for all three channels to the conformance fixture.
- **Cycle detection: normative MUST with zero implementation (confirmed real).** The reference implementation validates only one-level parent declarations, making a genuine N-node cycle unconstructible through the validated fields today (self-reference, the only reachable "cycle," is already caught by rule 1). Rather than implement unreachable dead code or silently drop the rule, the spec now states explicitly that rule 6 is a normative floor for a runtime resolving transitive chains, and that a one-level-only runtime (like the reference implementation) may rely on rules 1-5 making it vacuously true rather than implementing separate cycle-detection logic. This is the reviewer's own offered alternative to implementing real cycle detection, chosen because implementing transitive-chain resolution is a runtime behavior change outside this documentation-only change's scope.
- **`DETAIL_COVERAGE` ordering unenforced (confirmed real).** Added a non-normative note disclosing that the reference implementation does not enforce message-ordering sequence, and that the eligible-checkpoint algorithm's correctness does not depend on it.
- **Chase/Amazon `optional_skip_keys` evidence-bar violations (confirmed real).** Chase (`packages/polyfill-connectors/connectors/chase/index.ts`) classifies a statement as `index_only` (which flows into `optional_skip_keys`) whenever `downloadStatementPdf` returns `ok: false` — a generic download failure, not an affirmed terminal-unavailability check. Amazon (`packages/polyfill-connectors/connectors/amazon/index.ts`) populates its `optionalSkip` set solely from the operator env var `PDPP_AMAZON_SKIP_DETAIL=1`, with no per-record evidence check at all. Neither is fixed by this change: correcting shipped connector logic is a connector behavior change outside a checkpoint-dependency profile-contract change's scope, and is being addressed separately by the connector lane.
- **SQLite/Postgres "parity" framing overclaim (confirmed real).** The original two test files ran different scenarios. Fixed: extracted a shared `runMultiParentScenario` helper (`test/helpers/checkpoint-dependency-multi-parent-scenario.ts`) that both the SQLite and Postgres test files now invoke with identical manifest, connector script, and assertions, so the parity claim compares one true scenario across both backends.

## Addendum 2: further independent re-review findings

A second independent re-review, run after `bd8ed5649` landed, found two additional gaps:

- **`state_stream`/`parent_streams` both-fields-present rejection was incidental, not direct (confirmed real).** `connector-manifest-validation.ts`'s two per-field validators each gate on a different `coverage_strategy` value, which today makes both fields present unrepresentable as a side effect — but there was no explicit, standalone check. Added a direct rejection immediately before the two per-field validators run, plus a discriminator test (`validateConnectorManifest rejects a stream declaring both state_stream and parent_streams`) that crafts a stream satisfying `state_stream`'s own checks while also declaring `parent_streams`, proving the explicit check fires rather than relying on the coverage_strategy side channel. Fail-before verified: temporarily reverting the fix reproduces the old incidental rejection message (`... declares parent_streams, which is only valid with coverage_strategy "parent_detail_accounting" ...`) instead of the direct one, confirming the test exercises the new code path.
- **§4 conformance checklist item 15 and item 13 still claimed stronger guarantees than the corrected body text (confirmed real).** Item 15 said the runtime "reports exactly which checkpoint streams committed" — the exact overclaim already corrected in the Eligible-checkpoint algorithm's step 5 during the prior round, but the checklist echo was missed. Item 13 listed "a cycle" alongside the other manifest-validation rejections as if cycle detection were implemented, contradicting the non-normative note explaining no separate cycle-detection code path exists for the reference implementation's one-level-only graph. Fixed: item 15 now describes the distributed three-channel contract; item 13 no longer lists cycle rejection as an implemented check, and explicitly states the vacuous-satisfaction relationship instead. Rule 6 itself (Validation section) was also given an inline forward-compatibility-floor label so the qualification is visible at the point of the rule, not only in the separate non-normative note below it.

Fixed in commit (see git log). Zero `recovery_hint`/`RecoveryHint` content changed — verified by diff before committing.
