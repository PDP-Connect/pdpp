## Why

Commit `7cc177eec` (squash-merged as `b76940998`, PR #297) implemented the
Slack connector's four supplementary gap streams (`stars`, `user_groups`,
`reminders`, `dm_read_states`) as real `stars.list`/`usergroups.list`/
`reminders.list`/`conversations.info` calls, but in the same diff deleted
their manifest `"required": false"` / `"coverage_policy": "deferred"`
declaration without replacing it with anything. `required` defaults to
`true` when absent, so all four silently became load-bearing.

`stars.list` is now returning HTTP 401 (`slack_auth_failed`) against the
live connection. That failure is classified non-retryable and, because
`packages/polyfill-connectors/src/connector-runtime.ts` has exactly one
top-level catch around the entire `collect()` call, it fails the *whole*
run — even though the other 7 declared streams (workspace, channels,
users, messages, files, canvases, channel_memberships) had already
succeeded and committed earlier in the same pass. After 7 consecutive
failed runs the scheduler's `BLOCKED_PROMOTION_THRESHOLD` gives up on the
connector entirely, disabling a connector whose core value streams are
healthy.

Root cause and full evidence trail:
`tmp/workstreams/2026-07-14-health-regression/slack-stars.md`.

This is also a spec gap, not just an authoring slip: the current
`polyfill-runtime` spec (`Connector manifest stream schema SHALL declare
and validate coverage_policy`) only requires `required: false` when a
stream also declares an *accepted-absence* `coverage_policy`
(`deferred`/`unsupported`/`unavailable`/`inventory_only`). It says nothing
about a stream that is genuinely, actively collected (no accepted-absence
claim) but independently network-callable and therefore capable of failing
on its own — exactly the `stars`/`user_groups`/`reminders`/`dm_read_states`
shape. The original `complete-slack-bundled-connector-coverage` proposal
that implemented these streams never named `required: false` as part of
"flip to `collect`", so nothing in that change's own tasks/acceptance
checks would have caught the omission.

## What Changes

- **Manifest**: declare `"required": false` on `stars`, `user_groups`,
  `reminders`, `dm_read_states` in `packages/polyfill-connectors/manifests/
  slack.json`. No `coverage_policy` — per `connector-verdict-input.ts`'s
  own `"optional"` rollup category, `required: false` with no accepted-
  absence policy is exactly the "actively collected, not load-bearing"
  state, and `coverage_policy: "collect"` is functionally inert everywhere
  it's read (identical to omission) so adding it would be redundant.
- **Run isolation (connector-local)**: wrap each of the four gap streams'
  dispatch in `packages/polyfill-connectors/connectors/slack/index.ts`
  (`runOptionalStream`) so a thrown error is caught, reported as a
  `SKIP_RESULT` (reason `optional_stream_failed`, honest retryable flag),
  and does NOT propagate to `connector-runtime.ts`'s top-level
  `run().catch()`. Required streams are unaffected — they are still called
  directly, so a required-stream failure still fails the whole run, which
  is correct.
  - This mechanism is intentionally connector-local, not a
    `connector-runtime.ts` primitive. Traced end-to-end: manifest
    `required`/`coverage_policy` is read only by
    `reference-implementation/`'s post-run health/coverage rollup
    (`connector-coverage-policy.ts`, `connector-verdict-input.ts`); the
    START protocol's `StreamScope` (`connector-runtime-protocol.ts:28`) —
    what actually reaches the connector subprocess — never carries a
    `required` bit, and the orchestrator's `buildStartScope`
    (`reference-implementation/runtime/index.js`) strips manifest streams
    down to `{name, resources?, time_range?, fields?}` before sending
    START. Building a shared "catch this stream, mark non-fatal" primitive
    in `connector-runtime.ts` would require first threading manifest
    requiredness through the protocol — new infrastructure disproportionate
    to this bug. The nearest existing precedent
    (`ical`'s `loadSubscriptionSources`, catching a per-URL fetch failure
    into a `SKIP_RESULT`) is itself connector-local.
- **Regression tests**:
  - `slackdump-runtime.test.ts`'s existing manifest-declaration test is
    extended to assert `required === false` explicitly (not merely
    "coverage_policy is absent") for all four gap streams.
  - `gap-streams.test.ts` gains direct tests for `runOptionalStream`: a
    failing optional stream resolves and emits a `SKIP_RESULT`; a
    succeeding one runs to completion with no side-channel emit; the
    retryable flag on the `SKIP_RESULT`'s `recovery_hint` reflects
    `SLACK_API_RETRYABLE_FAILURE_RE`; and a contrast test proving a bare
    (non-wrapped) required-stream call still propagates its error —
    demonstrating the isolation seam is opt-in per stream, not a blanket
    swallow.
  - `coverage-policy-manifest-honesty.test.ts` gains a new ratchet
    guardrail: any manifest stream that omits `required` must already be
    on a frozen, non-growing allowlist (`KNOWN_MISSING_REQUIRED`, a
    snapshot of the 117 pre-existing omissions across all connectors,
    verified at authoring time). The allowlist is a `Map<connector.stream,
    fingerprint>`, not a bare key set — `fingerprint` is a SHA-256 digest
    over each grandfathered stream's semantic fields (everything except
    the cosmetic `description`/`display` prose fields), so an edit to a
    grandfathered stream's real behavior (schema, `semantics`,
    `coverage_policy`, cursor/incremental strategy, etc.) that leaves
    `required` omitted fails the test even though the stream's key stays
    on the list — closing the gap a bare-key allowlist would leave (see
    design.md's "a bare key allowlist does not catch edits to
    grandfathered streams" revision). A new or edited stream — including
    any future edit to `stars`/`user_groups`/`reminders`/`dm_read_states`
    themselves — that omits `required` fails the test. This directly
    targets the authoring gap that let `7cc177eec` regress silently
    (the existing coverage_policy-contradiction test at
    `coverage-policy-manifest-honesty.test.ts:71` only fires when
    `coverage_policy` is present at all).

## Non-Goals

- **Why `stars.list` returns 401** is a separate, unresolved live-auth
  investigation (ranked hypotheses in the root-cause report: session/scope
  gap specific to that endpoint vs. stale/rotated cookie). This change does
  not touch credentials or auth flow; it makes the *symptom* (one optional
  stream's failure disabling the whole connector) non-catastrophic
  regardless of which hypothesis is correct.
- **Repo-wide `required` guardrail** (all 134 manifest streams declaring
  `required` explicitly) is the concept-correct end state but out of scope
  here — 117 of 134 streams across every connector predate this guardrail.
  The ratchet test freezes today's gap as a known baseline rather than
  fixing it wholesale; closing it is a separate, dedicated change.
- **Live acceptance** (confirming the deployed connector actually recovers
  from `gave_up`/`blocked` scheduler state) is owner-only and out of scope
  for this change — see Residual Risks in `design.md`.

## Capabilities

- Modified: `polyfill-runtime` — clarifies that a manifest stream backed by
  an independent network call (not derived from another stream's already-
  fetched data) must declare `required` explicitly, and that a `required:
  false` stream's runtime failure must be represented as stream-scoped
  SKIP_RESULT evidence, not a whole-run failure.

## Impact

- `packages/polyfill-connectors/manifests/slack.json`
- `packages/polyfill-connectors/connectors/slack/index.ts`
- `packages/polyfill-connectors/connectors/slack/gap-streams.test.ts`
- `packages/polyfill-connectors/connectors/slack/slackdump-runtime.test.ts`
- `packages/polyfill-connectors/src/coverage-policy-manifest-honesty.test.ts`
