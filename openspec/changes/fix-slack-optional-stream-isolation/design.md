## Context

Root cause fully proven and cited in
`tmp/workstreams/2026-07-14-health-regression/slack-stars.md` (read-only
investigation, no code changed there). This design covers the fix.

## Decision: manifest declaration — `required: false`, no `coverage_policy`

Two options were available: `required: false` alone, or `required: false`
+ `coverage_policy: "collect"`. Traced every consumption site
(`ref-record-utils.ts:readAcceptedCoveragePolicy`,
`connector-verdict-input.ts:streamPriority`,
`connector-manifest-validation.ts`): `coverage_policy: "collect"` is
treated identically to omitting `coverage_policy` everywhere it's read —
it exists in the enum purely as an explicit "no accepted-absence claim"
spelling, not a distinct runtime signal. `connector-verdict-input.ts` has a
real, designed, but previously-unexercised `"optional"` rollup category for
exactly `required: false` + no/collect `coverage_policy`. No manifest in
the repo currently exercises it. Chose `required: false` alone: it's the
concept-correct state (these streams ARE actively collected, not
accepted-absent) and matches the rollup code's own semantics without
adding an inert field.

## Decision: run-isolation seam is connector-local, not shared

Traced whether `connector-runtime.ts` (the shared runtime every connector
uses) has typed access to per-stream `required` today. It does not:

- `StreamScope` (`connector-runtime-protocol.ts:28`) — the shape of each
  entry in `START.scope.streams`, i.e. what the connector subprocess
  actually receives — is `{name, resources?, time_range?, [extra:
  string]: unknown}`. No `required` field.
- Every START-construction site (`reference-implementation/runtime/
  index.js:392` `buildStartScope`, `controller.ts:3202`,
  `local-device-runtime.ts:209`) maps manifest streams down to `{name}` or
  `{name, resources, time_range, fields}` before sending START — `required`
  is read by the orchestrator's `manifestByStream` lookup but deliberately
  not forwarded.
- `required` is consumed ONLY by `reference-implementation/`'s post-run
  health/coverage rollup (`connector-coverage-policy.ts:155`,
  `connector-verdict-input.ts:75`), which operates on stored run history
  and the Collection Report, not live during a run.
- `connector-runtime.ts`'s only per-stream-failure-to-non-fatal precedent
  (`ical`'s `loadSubscriptionSources`, catching a fetch failure into a
  `SKIP_RESULT`) is itself connector-local, calling the shared `emit()`
  primitive but authoring the catch/convert decision entirely inside the
  connector.

Building a shared "catch this stream's error, mark it non-fatal by
manifest `required`" primitive in `connector-runtime.ts` would first
require threading a `required` bit through `StreamScope`/START — a
protocol change affecting every connector, disproportionate to fixing one
connector's four streams. The correct-scoped fix is the same shape as the
existing `ical` precedent: a small, connector-local wrapper
(`runOptionalStream`) around exactly the streams whose manifest declares
`required: false` and whose collection call is independent (not derived
from another already-fetched stream, so it can genuinely fail on its own).

If a second or third connector needs the identical pattern, that is the
trigger to extract a shared `connector-runtime.ts` primitive — at that
point the protocol-threading cost is amortized across real, not
speculative, callers. Speculatively generalizing now would be exactly the
kind of premature abstraction this codebase's own quality bar rejects.

## Decision: guardrail is a frozen-allowlist ratchet, not a blanket rule

The report's own suggestion (a static-call heuristic — grep manifest
streams for network-call patterns like `slackApiPost`/`slackApiGet` to
force an explicit `required` key) was rejected: it's exactly the kind of
brittle, connector-specific-helper-name-coupled heuristic the task
explicitly ruled out, and it wouldn't generalize past Slack (other
connectors use different HTTP call helpers, or none at all for
file-derived streams).

The concept-correct end state — every manifest stream declares `required`
explicitly, no silent default — is simple to state but currently violated
by 117 of 134 streams across every connector in the repo (verified by
direct scan of all `packages/polyfill-connectors/manifests/*.json` at
authoring time: only `stars`/`user_groups`/`reminders`/`dm_read_states`,
now fixed by this change, were affected on Slack; every other manifest
still has pervasive omissions). Failing all 117 at once as a side effect
of a Slack-scoped bug fix is out of proportion and would block unrelated
work.

Resolution: a ratchet test. `KNOWN_MISSING_REQUIRED` in
`coverage-policy-manifest-honesty.test.ts` is an explicit, frozen snapshot
of today's 117 omissions (by `connector.stream_name` key). The test scans
every manifest stream and fails only if it finds an omission NOT already
on that list — i.e., a NEW manifest stream, or an EXISTING stream not
already known-missing, that omits `required`. This is exactly the
authoring gap that let `7cc177eec` regress silently, and it's what would
have caught this exact bug had it existed before. The list is meant to
shrink over time (a follow-up change closing the repo-wide gap) and must
never grow via this test passing — any addition needs a deliberate
allowlist edit, which is itself a reviewable signal.

### Revision: a bare key allowlist does not catch edits to grandfathered streams

Independent review found a
real gap in the first version of this ratchet: `KNOWN_MISSING_REQUIRED`
was a `Set<string>` of `connector.stream` keys. That catches a brand-new
omission (a key not on the set), but a grandfathered stream can be edited
— schema widened, `semantics` flipped, a `coverage_policy` added — while
staying on the allowlist and still omitting `required`, and the test would
stay green throughout. The design's own stated goal ("new OR EDITED
streams") was not actually enforced by the implementation.

Two ways to detect "was this grandfathered entry edited" without brittle
git-history access (parsing `git show HEAD~N:path`/`git blame` in a test is
slow, environment-fragile — shallow clones/CI checkouts may not have the
history — and encodes a git-specific dependency into a package-level unit
test) were considered:

1. **Committed JSON baseline snapshot** — store each grandfathered
   stream's full semantic-field object in a companion file, deep-equal
   against it at test time. Rejected for this repo: 117 full stream
   objects (each with a nested JSON Schema) is a large, low-signal
   committed artifact, and the test would need its own JSON-diff rendering
   to make failures readable — machinery disproportionate to the problem.
2. **Per-entry content fingerprint** (chosen) — `KNOWN_MISSING_REQUIRED`
   becomes a `Map<string, string>` from `connector.stream` to a short
   SHA-256 digest of that stream's semantic fields, computed by
   `fingerprintSemanticStream()`. "Semantic fields" is every field except
   `description` and `display` (the two known-cosmetic, prose-only
   fields owners see as UI copy) — schema, `semantics`, `primary_key`,
   `cursor_field`, `incremental`, `query`, `coverage_strategy`,
   `freshness_strategy`, `coverage_policy`, and `required` itself (when
   present) are all included, so any of those changing on a grandfathered
   stream invalidates its fingerprint. The test recomputes each
   grandfathered stream's fingerprint on every run and fails if it no
   longer matches the frozen one — independent of git history, and
   independent of formatting (the object is parsed JSON, not raw text, so
   whitespace/key-order changes in the source file are inert).

This directly restores the design's original claim ("new or edited manifest
stream(s)... must declare `required`") as an actually-enforced invariant:
a semantic edit to a grandfathered stream now fails loudly with the exact
stream key, and the fix is either declare `required` explicitly or — if
the edit is a deliberate, reviewed decision to keep it grandfathered —
update its fingerprint in the same commit, which is itself visible in
review as a one-line hash change tied to the stream that moved.

Cosmetic edits (rewording `description`/`display` prose) are intentionally
exempt: those fields carry no behavioral contract, and requiring a hash
bump for prose-only changes would train authors to treat fingerprint
churn as routine noise, defeating the guardrail's signal value.

## Residual Risks

- **Underlying `stars.list` 401 cause is still unconfirmed.** This change
  makes the failure mode non-catastrophic but does not fix the auth issue
  itself. See the root-cause report's ranked hypotheses (H1 session/scope
  gap ~65%, H2 stale/rotated cookie ~25%, H3 pure `stars.list`-specific gap
  ~10%) and its "confirming evidence needed" curl tests — unrun, owner-only
  (requires the live captured credential).
- **Live acceptance unrun.** Whether the deployed connector actually
  recovers from `gave_up`/`blocked` scheduler state after this fix ships
  requires a live redeploy + a real scheduled run, both explicitly out of
  scope ("Do not touch live state or deploy" per task instructions). The
  root-cause report's "Live acceptance oracle" section names the exact
  SQL/log checks to run post-deploy.
- **Repo-wide `required` omission (117 streams) is untouched** apart from
  being frozen into the ratchet allowlist. A dedicated follow-up change
  should work through connector-by-connector, deciding `required: true`
  vs `false` per stream based on whether it's independently failable
  (matching the audit already on file in
  `project_bundled_coverage_audit_2026_07_10.md` for the 8 scaffold
  connectors already flagged there).
