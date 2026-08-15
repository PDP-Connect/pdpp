# Design note: generic periodic full-refresh repair primitive

**Status:** proposed, not implemented. **Origin:** GroupMe `group_messages` incremental
rework (2026-08-10, `waspflow/groupme-incremental-frontier-0810`). **Scope of this note:**
design only — no scheduler code changes are included in the GroupMe patch this note
accompanies.

## The observed gap

GroupMe's `group_messages` stream now resumes forward from a durable per-group cursor
(`after_id`) instead of re-walking full history every run. This closes exact forward
incrementality: an ordinary run does bounded work proportional to what's genuinely new.

It does **not** close old-message mutable-field repair. `favorited_by`/`like_count` can
change on a message that already fell behind the resume cursor on a prior run (someone
reacts to a message from 6 months ago). A forward-resuming walk never revisits that
message again. The manifest now honestly declares `group_messages` as `mutable_state`
(not `immutable_log`) to reflect this, but declaring it honestly doesn't repair it.

This is not GroupMe-specific. Any connector whose incremental walk resumes from a forward
watermark — and whose records can mutate after they first pass that watermark — has the
identical gap: Reddit's `submitted`/`comments` (score/gilded status), Slack (reactions,
edited messages arriving after their `ts` window closed), any "message + reactions" shaped
API. A connector-local fix (a local timer, a hardcoded "re-scan every N days" inside one
connector's `collect()`) would need to be reinvented per-connector, would be invisible to
an owner/operator, and — per the same objection that got GroupMe's original
timestamp-overlap design rejected — would be an ungrounded, ad-hoc policy baked into code
instead of a declared, auditable decision.

## What was verified before writing this note

- `reference-implementation/runtime/index.ts`'s `collectionMode` defaults to
  `"incremental"` (`collectionMode = "incremental"` at the START-build call site) whenever
  prior state exists — there is no generic per-stream "do a full refresh every N runs/days"
  policy anywhere in this codebase today. `full_refresh` currently only reaches a connector
  from an explicit, one-off trigger (e.g. an owner-initiated re-sync), never from a
  periodic scheduler decision.
- No manifest field anywhere in `packages/polyfill-connectors/manifests/*.json` declares a
  repair cadence, and no code in `reference-implementation` reads one.

This note proposes the primitive that's missing, in enough detail to implement later
without re-deriving the shape from scratch — it does not implement it.

## Proposed primitive

### 1. Manifest-owned policy (per stream, optional)

```json
{
  "name": "group_messages",
  "semantics": "mutable_state",
  "repair_policy": {
    "kind": "periodic_full_refresh",
    "interval_days": 30
  }
}
```

- Optional field on any stream. Absent = no periodic repair policy (today's behavior,
  unchanged for every existing connector/stream).
- `kind` is an open enum so future repair strategies (e.g. a provider-specific delta/audit
  endpoint) can be added without redesigning the field — `periodic_full_refresh` is the
  only kind this note specifies.
- `interval_days` is a connector-author-declared value, reviewed the same way any other
  manifest field is reviewed (PR review, not a runtime-configurable knob an individual
  connector process could drift from). It expresses "how stale is old-message mutation
  drift acceptable to be for this specific provider/stream", which only whoever authored
  the connector (with knowledge of the provider's cost/rate-limit profile and how mutable
  the field actually is in practice) can reasonably set.

### 2. Generic scheduler interpretation (RI, connector-agnostic)

RI already parses and forwards `collection_mode` on the wire (confirmed above); this
primitive only adds a decision RI makes about **which value to set**, not a new wire
concept. At the point RI currently defaults to `collectionMode = "incremental"` whenever
prior state exists, it would instead:

1. Read the requested stream's manifest `repair_policy` (if any).
2. If `repair_policy.kind === "periodic_full_refresh"`, read the LAST time this
   stream successfully completed a `full_refresh` pass for this connection (a new,
   generic timestamp RI would need to persist per stream — NOT provider-specific state,
   just "when did stream X last complete a full_refresh cleanly").
3. If `now - lastFullRefresh >= interval_days`, set `collection_mode: "full_refresh"`
   for that stream's START instead of `"incremental"`.
4. Otherwise, `"incremental"` as today.

This is entirely generic: RI never inspects what `group_messages`/`favorited_by` mean —
it only reads a declared interval and a "when did this last happen" timestamp, exactly the
same shape RI already uses for ordinary incremental cursors, just at the stream level
instead of the record level. No GroupMe-specific (or any other provider-specific)
knowledge is added to RI.

### 3. Explicit `collection_mode: full_refresh`, not a silent behavior change

The connector-side contract is unchanged: `CollectContext.collectionMode` is exactly the
same field GroupMe already reads today. A periodic-repair-triggered `full_refresh` looks
identical, on the wire and to the connector, to an owner-initiated one. This matters for
crash/checkpoint semantics (below) and keeps the connector-side implementation this note
is attached to already forward-compatible with the primitive once it exists — GroupMe does
not need to change when this primitive ships.

### 4. Crash/checkpoint semantics

- The "last successful full_refresh" timestamp is committed ONLY when the full_refresh
  pass itself completes cleanly (the connector's own `failed: false` outcome — GroupMe's
  `collectGroupMessages` already reports this correctly). A crashed/interrupted
  full_refresh run must NOT advance the "last repaired" timestamp, or a real old-message
  mutation could go permanently unrepaired because the scheduler believes it already ran.
- This is the same commit-only-on-clean-pass discipline the STATE cursor itself already
  uses (see `CollectionOutcome`'s doc comment in `groupme/index.ts`) — the periodic-repair
  timestamp should be persisted alongside/adjacent to the stream's own cursor state, not
  as a separate uncoordinated write that could desync from it.
- A failed full_refresh should fall back to trying again next scheduled incremental run
  (the interval check re-evaluates every run; a missed window just means the next run
  after that reattempts), not retry immediately in a tight loop.

### 5. Thundering-herd / rate-limit considerations

- A fleet-wide "every connection's 30-day timer expires the same week" scenario is a real
  risk once many connections onboard around the same time. The interval check should
  compare against a PER-CONNECTION timestamp (when THIS connection's stream last full-
  refreshed), which naturally staggers over time since connections don't all onboard
  simultaneously — but a fleet operator should still be able to see/reason about the
  aggregate full-refresh load this creates across all connections of the same connector,
  since a full_refresh is measurably more expensive (full history walk) than an ordinary
  incremental run.
- This note does NOT propose a fleet-wide jitter/staggering mechanism — that's a genuine
  open question for whoever implements this (a naive per-connection interval could still
  cluster if many connections onboarded in the same window) and should be resolved with
  real data on onboarding distribution, not speculated here.
- The existing per-provider pacing/governor (`createConnectorHttpGovernor`,
  `groupmePacingProfile`) already rate-limits any single connector's requests — a
  full_refresh under this primitive still goes through that same governor, so it can't
  itself cause a burst faster than the provider's already-declared ceiling. The risk this
  section is about is aggregate SCHEDULING load (many full_refreshes landing in the same
  window), not per-request rate-limit violation.

## Acceptance criteria (for whoever implements this)

1. A stream with no `repair_policy` in its manifest behaves EXACTLY as every stream does
   today — this must be provably a no-op for every existing connector (a test asserting
   `collection_mode` selection is unchanged for a manifest lacking the field).
2. A stream declaring `repair_policy.kind: "periodic_full_refresh"` gets
   `collection_mode: "full_refresh"` exactly once the declared interval has elapsed since
   its last CLEAN full_refresh completion, and `"incremental"` otherwise.
3. A crashed/failed full_refresh does not advance the "last repaired" timestamp (tested:
   interrupt a full_refresh pass, verify the next run's interval check still sees it as
   overdue).
4. The interval check is scoped per-connection, not global to the connector type across
   all connections.
5. Zero GroupMe-specific (or any other provider-specific) branching exists anywhere in RI
   to implement this — the mechanism reads only the generic manifest field and a generic
   per-stream timestamp.
6. `group_messages` in GroupMe's manifest can adopt `repair_policy` with zero code changes
   to `connectors/groupme/index.ts` beyond, at most, tuning `interval_days` — because the
   connector-side `collectionMode` contract this note relies on already exists and is
   already correctly implemented (this patch).

## Why this is a note, not an implementation

This primitive touches `reference-implementation` (the scheduler/START-build path,
per-stream timestamp persistence, and the manifest schema itself) — explicitly out of
scope for a connector-local patch per this task's instructions ("no provider knowledge in
RI", "RI remaining connector-agnostic", and the broader standing rule not to touch RI from
a connector-scoped change). It is also a large enough change (new manifest schema field,
new RI persistence, new scheduler decision logic, fleet-load analysis) to warrant its own
reviewed implementation and test suite rather than being folded into an already-large
connector rewrite. This note exists so that work has a concrete starting point instead of
being re-derived from scratch when someone picks it up.
