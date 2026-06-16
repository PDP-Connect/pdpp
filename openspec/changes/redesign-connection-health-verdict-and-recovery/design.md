## Context

The buildable-from design is
`docs/research/slvp-connector-health-FINAL-design-2026-06-15.md`. It folds the
agency + silence correction (`docs/research/slvp-connector-agency-and-silence-
2026-06-15.md`) into the honesty-complete ideal-design
(`docs/research/slvp-connector-health-ideal-design-2026-06-15.md`), which was in
turn diagnosed in `docs/research/slvp-connector-health-legibility-reflection-
2026-06-15.md` and grounded in prior art in `docs/research/slvp-connector-health-
priorart-2026-06-15.md`. This document records the load-bearing decisions, the
rejected alternatives, and the honesty<->usefulness tradeoffs so the spec deltas
read against an explicit rationale.

The existing model is `reference-implementation/runtime/connection-health.ts`
(2679 lines): a 7-state headline (`unknown | idle | needs_attention | blocked |
cooling_off | degraded | healthy`), four orthogonal axes (coverage / freshness /
attention / outbox), `badges`, `forward_disposition`, `conditions[]`,
`dominant_condition_id`, `next_action`. The projection is honest. The render seams
drop its axes (every surface re-derives from `health.state` alone) and the
recovery seam was never typed (`next_action` is a CTA string). This change is
strictly additive: a synthesis layer, one promoted field family, a recovery loop,
and a silence-routing field — not a new state machine.

The legibility-reflection named six design goals that were never formed on the
render and recovery side, even though the projection-side goal ("model state and
axes as orthogonal honest data") was formed and executed. This change owns those
six: (1) one synthesized verdict rendered verbatim; (2) a render-time consistency
gate; (3) every unhealthy state names a typed required action with a satisfaction
condition; (4) repair self-heals and auto-resumes; (5) creation/lifecycle
invariants so impossible configs cannot exist; (6) a collection-model-aware
productivity signal. The agency-and-silence correction adds a seventh: route
self-handled truth to an inspection layer rather than alarming the dashboard.

### Ground truth (live Postgres, 2026-06-15)

`docker exec pdpp-postgres-1 psql -U pdpp -d pdpp`. Every load-bearing claim was
re-run, and two source premises were falsified by it:

| connector | sched | pending gaps | recovered gaps | terminal gaps | reads as |
|---|---|---|---|---|---|
| **chatgpt** | 1 | 0 | 2,532 | 0 | scheduled, all gaps already drained, fresh today — the SILENCE case |
| **chase** | 0 | 1 | 0 | 0 | manual, one retryable `transactions` gap frozen ~2 months — the one real unhealthy case |
| **amazon** | 0 | 0 | 0 | 0 | manual-refresh, 31-day stale, nothing scheduled — the owner-actionable case |
| **reddit / usaa** | 0 | 0 | 0 | 0 | manual-refresh, stale |

ChatGPT is `source_kind=account`, scheduled, 126k records, and has **zero
credential rows** (it collects via owner-assisted browser sessions). There are
**zero terminal gaps anywhere** live. These two facts kill the "account =>
credential" creation invariant and the "design against a Chase terminal
`current_activity`" premise the source proposals carried.

## Goals / Non-Goals

Goals:
- One server-owned `RenderedVerdict` every owner surface renders verbatim.
- Honesty invariants enforced as a gate, not convention (no false-health tuples,
  no impossible tuples, no terminal "resumes collection").
- A `channel` routing field so the dashboard defaults to calm and interrupts the
  owner only when the owner is the sole resolution; self-handled signals route to
  an inspection layer, never to nothing.
- A typed `RequiredAction[]` with derived terminality, one unified
  `satisfied_when`, and a self-heal loop that lands on the existing connection.
- A refresh-contract creation invariant that makes manual-stale render an
  owner-refresh advisory without reclassifying stale freshness as broken
  collection health.

Non-Goals:
- Rewriting the 2679-line projection. `deriveForwardDisposition` stays the sole
  terminality oracle.
- An `account => credential` creation invariant (false at the wire; ChatGPT is
  account + scheduled + zero credentials).
- Exposing inspection-layer detail to grant-scoped clients.
- Designing terminal UX against a Chase terminal `current_activity` example that
  does not exist live; the taxonomy supports terminality, but the demonstrated
  unhealthy journey anchors on Chase's real recoverable-but-frozen gap.

## Key decisions

### D0 — health, freshness, and action urgency are separate display axes

the owner's overnight sources-lifecycle audit identified the highest-confusion live
failure: stale-but-healthy sources such as Reddit rendered `Needs you` while the
same panel said the source was calm, current enough to inspect, and collecting
normally. The original verdict design overcorrected from "do not claim complete
freshness while stale" into "stale means alarm label." That is wrong for the
reference operator surface. The pill now answers collection health only
(`Healthy`, `Checking`, `Degraded`, `Can't collect`), freshness is a co-rendered
annotation (`Fresh today`, `Last refreshed yesterday`, `Freshness unknown`), and
`Needs you` is reserved for owner-attention/action presentation when
`channel === "attention"` with an owner-satisfiable required action. A stale manual
refresh source can be `Healthy · Last refreshed yesterday` with an optional
`Refresh now`; a broken-but-recent source is `Can't collect · Last successful
refresh yesterday`, never `Can't collect · Fresh yesterday`.

### D1 — tone and channel are orthogonal (the agency correction)
`tone` answers collection health (worst-wins over health axes: state,
worst-stream coverage, disposition, attention, outbox). `channel` answers "whether to
interrupt" (a function of who can fix it), computed in the SAME pass AFTER `tone`.
The prior honesty-design conflated them, so any non-green visibly alarmed.
ChatGPT-fresh is `green / calm`; Amazon-stale is `green / advisory`; a
retryable Chase gap is `amber / advisory`; a revoked-credential connection is
`amber / attention`. The load-bearing split (FINAL design §3.2, fork A1) is that
tone says collection health while channel says owner interruption. Without this,
the dashboard cannot be both honest and calm.

### D2 — terminal is DERIVED from forward_disposition, never an independent flag
`RequiredAction.terminal === (forward_disposition === "terminal")`.
`deriveForwardDisposition` (`connection-health.ts:2111`) is the single terminality
oracle. A parallel boolean re-creates exactly the fragmentation this change
deletes (legibility-reflection P3-critical, ideal-design fork F2).

### D3 — one unified satisfied_when, not per-kind satisfaction logic
A single `SatisfactionContract` discriminated union
(`credential_present_and_unrejected | schedule_attached_and_enabled |
attention_resolved | confirming_run_succeeded | gap_recovered |
backfill_window_covered | none`) drives the self-heal watcher for every
owner-actionable kind. Terminal and `wait` kinds carry `{ kind: "none" }` (not
owner-satisfiable). One mechanism the controller evaluates against durable
evidence the projection already reads — not N per-kind branches scattered through
the controller.

### D4 — silence routes, never deletes (invariant S3)
Anything suppressed from the attention channel by the silence predicate is present
in the inspection-layer `detail`. The 2,532 drained gaps live in
`detail.detail_gap_backlog`; they never reach the dashboard. This is progressive
disclosure (NN/g), not concealment — the truth is one click down, never gone. The
synthesizer asserts `detail` is a strict superset of what the attention layer
dropped.

### D5 — refresh-contract creation invariant, not credential
An active `account` connection MUST resolve a refresh contract from its manifest
(`recommended_mode` + `background_safe`). `automatic` => a schedule row is attached
at activation (Amazon-shaped "automatic but no schedule" becomes un-constructable).
`manual` => schedule-absence is NOT a defect, but the connection is typed manual so
a stale projection routes to `owner_refresh_due`. No credential invariant — the
live DB proves ChatGPT (the flagship) is account + scheduled + zero credentials.

### D6 — the wait action-kind subsumes drain / cooldown / syncing
One concept (`wait`, `audience: "none"`, `satisfied_when: { kind: "none" }`,
channel `calm` by construction) replaces three separate "don't alarm"
special-cases: ChatGPT deferred drain, source-pressure cooldown, and in-flight
syncing. A `wait` action can never alarm; this is how "2,532 gaps draining" becomes
a calm, silent, detail-only fact.

### D7 — runtime faults don't cascade (invariant S4)
The synthesizer takes a `runtime_ok: boolean` input; when false it caps every
per-connection channel at `calm` and a single global runtime indicator is emitted
above the list. Per-connection pills stay honest (the connections aren't broken;
the runtime serving them is) but none individually alarms. This is the Temporal
runtime-vs-workflow lesson: a dead scheduler must not produce N false attention
pulls.

### D8 — RequiredAction is zero-or-MANY, ordered (not zero-or-one)
Amazon may need BOTH `refresh_now` AND `reauth`; a connection can mix a recoverable
stream and a terminal stream of opposite terminality. A single-action envelope
must lie about one. `required_actions[]` is ordered by urgency; the UI shows the
first as primary and the rest behind "+N more"; `streams[].action_ref` indexes
into it so a terminally-lost stream and a resuming stream render correctly in the
same verdict (ideal-design fork F1). This preserves Stripe's "single most-urgent
row" presentation while preserving the list-of-errors truth Stripe also keeps.

### D9 — collection-model-aware progress, never a lone records_emitted
`records_emitted` is structurally 0 for deferred connectors (ChatGPT: 46 succeeded
runs, all 0). `RenderedProgress.mode` (`scheduled | manual | deferred |
local_device`) privileges the right signal: `gaps_drained_last_run` +
`retained_records` for deferred, `records_committed_last_run` for scheduled,
`retained_records` + "last refreshed Nd ago" for manual. The "did it work?" eye
never lands on a structurally-zero number (ideal-design fork F5).

## Alternatives considered and rejected

### A — The honesty-only design (rejected as the endpoint, kept as the floor)
The ideal-design before the agency correction was honesty-complete but
usefulness-partial: it optimized telling the truth (one synthesized verdict, every
off-fresh pill carries its freshness annotation, terminal can never claim "resumes
collection") and would, correctly and honestly, have surfaced "2,532 gaps" as
coverage evidence on the dashboard. **Rejected as the endpoint** because honesty is
table stakes, not the product: a dashboard that honestly shows "stale, 2,532 gaps"
across connectors trains the owner to ignore it (the Google SRE alert-fatigue
finding — after ~100 low-signal alerts operators develop alert blindness, and once
they stop trusting the channel real alerts are missed too). **Kept as the floor:**
every honesty invariant (1–7) and every honesty fork (F1–F7) survives verbatim in
this change. The agency layer is not a weakening of honesty — silence is the
routing of true information to its correct layer (D4 / S3), never the withholding
of actionable truth. We reject honesty-maximalism as a UX, not honesty as a
constraint.

### B — The `account => credential` creation invariant (rejected: false at the wire)
The source proposals' invariant "an active account connection MUST have a schedule
+ credential" would brand the flagship impossible: ChatGPT is `source_kind=account`,
scheduled, 126k records, **0 credential rows** because it collects via owner-assisted
browser sessions (`interaction_posture: manual_action_likely`). **Rejected** in
favor of D5's refresh-contract invariant, which keys on the manifest
(`recommended_mode` + `background_safe`), never on credential presence. This is the
single most important correction the live DB forced: the impossible-config class is
real (Amazon/Chase/Reddit/USAA are active account sources with records and no
schedule and no credential), but the fix is "type them manual and route stale to
`owner_refresh_due`", not "require a credential that the assisted-session model
never produces."

### C — Per-kind `satisfied_when` logic (rejected: re-braids the controller)
A natural shape is for each `RequiredAction.kind` to carry its own bespoke
satisfaction check scattered through the connection controller. **Rejected** in
favor of D3's ONE `SatisfactionContract` discriminated union. Per-kind logic
re-creates the exact fragmentation this change exists to delete: N places deciding
"is this resolved?", each evaluated against the durable evidence differently, each
able to drift. The unified contract is a single watcher the controller evaluates;
terminal and `wait` kinds collapse to `{ kind: "none" }` rather than each inventing
a "never satisfiable" path.

### D — A new pill for "productive via deferred materialization" (rejected)
ChatGPT looks idle on a naive per-run readout (`records_emitted=0`). A tempting fix
is a new pill state. **Rejected** (ideal-design fork F5): a new pill violates the
orthogonal-axes principle the model was built on. `RenderedProgress.mode:
"deferred"` + `gaps_drained_last_run` distinguishes a healthy draining ChatGPT from
an idle never-collected connection without a binary pill ambiguity.

### E — Per-connection runtime alarms (rejected: cascade)
Letting a dead scheduler surface as N per-connection `cooling_off`/`degraded`
pills. **Rejected** (D7 / S4, the Temporal lesson): one fault becoming 12 false
attention pulls is the worst silence violation. One global runtime indicator;
per-connection channels capped at `calm`.

### F — Client-side synthesis (rejected: unenforceable)
Synthesizing the verdict in the console rather than server-side. **Rejected**
(ideal-design fork F7): server-side synthesis forwarded verbatim like
`connection_health` is what makes invariant 5 (no raw `health.state` read) and the
one-channel-owner simplicity constraint enforceable by a grep/lint gate over
`apps/console/**`. Client synthesis re-opens the N-formatter divergence that caused
the original bug.

## The agency / silence tradeoffs — calm vs inspectable, reconciled

The central tension (agency-and-silence §4.1): honesty-maximalism says show
everything accurate (2,532 gaps); usefulness says the owner cannot act on a
finished drain and showing it burns their attention budget. The resolution is NOT
"suppress information" — it is "route information correctly" across two layers that
already exist as separate surfaces in PDPP:

| Layer | Surface | Contents | Audience |
|---|---|---|---|
| **Attention** | owner dashboard list + connection header | `pill`, `channel`, `forward_statement`, the ONE freshness annotation, `required_actions[0]` iff owner-actionable | non-technical owner answering "do I need to do anything?" |
| **Inspection** | connection detail `<details>` + operator console | `detail` (gap counts, drain rate, retry state, `next_attempt_at`, conditions, raw disposition, `collection_rate`, `detail_gap_backlog`) | engineer / reviewer / power user answering "what exactly is happening?" |

The acid test: the number **2532 MUST NOT appear on the dashboard**; "Healthy ·
fresh today" MUST. This satisfies both the calm-tech ideal (Weiser & Brown:
attention resides mainly in the periphery; shift to center only when needed) and
PDPP's "reference must be inspectable" requirement (agency-and-silence §4.3) —
because these are a different user and a different layer, not a contradiction. The
engineer's relationship with the system is via the operator console and `detail`,
not the owner dashboard. The calm-technology ideal is enforced on the owner
dashboard only; nothing is hidden from the engineer, who can always navigate deeper.

The trade-off honestly costs us one thing: a sophisticated owner who *wants* to
watch gap counts to calibrate expectations now has to open the detail panel. We
accept that (agency-and-silence §6.3): trust is built by the dashboard being
*right*, not by it showing everything; the visibility is not removed, it is
correctly placed. The pathological-drain case (a stall the owner might catch by
eyeballing counts) is handled by the system's own escalation to `degraded`/`blocked`
(the `wait` action's `satisfied_when` watcher and existing stall detection), not by
training the owner to police a number.

The silence predicate is precise, not a vibe (agency-and-silence §5.1–5.2):
- **Agency rule:** a human is required iff the condition cannot be resolved by any
  operation the system can perform with credentials/access it currently holds AND
  inaction permanently harms completeness/capability. Else the system retries /
  waits / rotates / drains / self-heals silently. Sourced from manifest fields the
  projection already reads (`interaction_posture`, `background_safe`,
  `recommended_mode`), not runtime heuristics.
- **Silence rule:** suppress an honest signal from the attention channel if (a) the
  system is actively handling it AND (b) the owner cannot accelerate/improve the
  outcome by acting now. Routed to `detail`, never deleted.

## The Hickey de-braiding argument (simplicity, not over-engineering)

This change is a *deletion of divergence*, not new machinery — it untangles three
braids the existing code already half-implements ad hoc:

1. **N formatters -> 1 verdict.** Every surface re-deriving from `health.state`
   (the live diagnosis's root cause) collapses to one `synthesizeRenderedVerdict`.
   The honesty braid.
2. **Terminal is DERIVED, not a new flag** (D2). No second source of truth for
   "will a future run fix this." The terminality braid.
3. **ONE `satisfied_when` mechanism** (D3), not per-kind satisfaction logic
   scattered through the controller. The recovery braid.
4. **ONE silence predicate, not per-surface routing** (the biggest de-braid this
   change adds). `isHealthRelevant` (filters non-blocking notices from the
   headline), `pushPayload(owner_action:"none") -> null` (suppresses non-actionable
   pushes), and `stale_assisted_refresh` at info-severity are today three *separate*
   ad-hoc silence decisions in three files, each re-deciding "should this reach the
   owner?". This change lifts them into a SINGLE `channel` computation inside the
   synthesizer (invariants S1–S4). Every surface — list, header, push, operator
   console — inherits identical routing instead of each re-implementing it.
5. **The `wait` action-kind subsumes drain / cooldown / syncing** (D6). One
   concept replaces three "don't alarm" exceptions.

`channel` is not a new state machine — it is a pure projection of evidence the
snapshot already carries (`interaction_posture`, `owner_action`,
`forward_disposition`, `runtime_ok`), computed by the same function that computes
`tone`. It adds one enum field and four invariants; it removes three scattered
silence decisions and three drain/cooldown/sync special-cases. **Net complexity
goes DOWN.** The honesty constraint (no raw `health.state` read, invariant 5) and
the usefulness constraint (no raw silence decision, the unified `channel`) are the
*same shape of discipline*: one synthesizer owns the verdict, including its routing.

## The one simplicity constraint to hold during build

There is exactly ONE place that decides whether a connection's state reaches the
owner: the `channel` computation inside `synthesizeRenderedVerdict`, applying the
unified silence predicate (S1–S4). No surface, push transport, list view, or
operator console may re-decide "should this alarm?" — they read `verdict.channel`
and obey it. If any surface re-derives "is this actionable / should I push / should
I badge" from raw axes, the braid is back and both the honesty AND usefulness
guarantees rot one PR at a time — exactly how the original divergence happened.

## Calibration plan

Calibration is the step that keeps the implementation aligned with the SLVP ideal
rather than merely type-correct. The design has two classes of decisions:

1. **Fixed invariants.** These are not tunable: one server-owned verdict, no raw
   `health.state` rendering, worst-wins `tone`, `tone` orthogonal to `channel`,
   `attention` only with an owner-satisfiable action, suppressed truth present in
   `detail`, derived terminality, one `satisfied_when` mechanism, self-heal on the
   existing connection, grant-scope isolation, and no runtime-fault cascade.
2. **Calibrated judgments.** These are tuned from fixtures and live evidence:
   advisory-vs-attention threshold, stream-priority weighting in worst-wins rollup,
   stale windows and manual-refresh language, push eligibility, runtime liveness
   sensitivity, and the exact owner-facing sentence for each action.

The implementation SHALL expose a low-noise calibration trace for tests and
operator review. For each verdict, the trace should answer: which evidence set the
`tone`, which evidence set the `channel`, which evidence was suppressed from the
attention layer, where that evidence appears in `detail`, which required action is
primary, and which `satisfied_when` contract will clear it. The trace is not an
owner-surface field and must not be grant-scoped; it is a build/test and operator
diagnostic so implementers can prove the verdict is not hand-waved.

Calibration proceeds in four gates:

1. **Golden fixtures before UI.** The synthesizer is pinned against ChatGPT,
   Amazon, Chase, and synthetic terminal/runtime fixtures before any surface
   migration. The expected outputs include both verdict fields and the calibration
   trace. This prevents UI work from hiding a bad model.
2. **Shadow comparison against live connections.** Before replacing surfaces, run
   the synthesizer over the live connection set and compare old vs. new headlines.
   Any changed row must be categorized as a fixed lie, a deliberate silence
   correction, or an unexpected drift. Unexpected drift blocks rollout.
3. **Surface assertions, not screenshots alone.** Owner pages are tested by DOM
   assertions for the words and absences that define the ideal: no mechanistic
   backlog counts on the dashboard, exactly one primary action, no dead owner
   button for maintainer work, `detail` containing suppressed evidence, and push
   transport obeying `channel`.
4. **Live acceptance with residual log.** After deployment, the live three-journey
   acceptance is repeated and every residual is classified as invariant failure,
   calibration miss, or external/live-data change. Invariant failures block
   archive. Calibration misses become a small named tuning task with the evidence
   that triggered it; they do not become silent drift.

The calibration target is not "fewest warnings." It is "the owner only has to act
when the owner is genuinely useful, and every action presented can actually make
the system better." A calm dashboard that hides an owner-required fix is a failure;
an honest dashboard that asks the owner to process self-handled internals is also a
failure. The acceptance bar is the conjunction.

## Acceptance Checks

- `openspec validate redesign-connection-health-verdict-and-recovery --strict`
- `openspec validate --all --strict`
- Requirement deltas distinguish `tone` (worst-wins, how-worried) from `channel`
  (silence routing, whether-to-interrupt) and assert they are orthogonal.
- A composite-invariant test renders the WHOLE verdict and asserts the honesty
  invariants (freshness-mandatory-off-fresh, `collected <= considered`,
  `forward_statement` reconciliation, derived terminality, label<->tone bijection)
  — not N independently-tested formatters.
- A composite test asserts the silence invariants S1–S4: `channel === "attention"`
  implies an owner-self-satisfiable action exists; no mechanistic counts on
  calm/advisory annotations; suppressed evidence is present in `detail`;
  `runtime_ok === false` caps all channels at `calm`.
- A property test over `(state × freshness × coverage × disposition × attention)`
  asserts `tone` is worst-wins and never `labelFor(state)` directly.
- The three live journeys render correctly: ChatGPT `green / calm /
  "fresh today"` with **no `2532` anywhere on the dashboard** and `2532` present in
  `detail.detail_gap_backlog`; Amazon `green / advisory / "last refreshed ..." +
  Refresh now`; Chase `amber / advisory / "transactions stuck since Apr 22" +
  Retry now` with a per-stream row that truthfully says the next run retries.
- A calibration trace exists for test/operator review and explains, per verdict,
  the tone cause, channel cause, suppressed evidence, detail destination, primary
  action, and `satisfied_when` contract; the trace is not exposed to grant-scoped
  clients.
- A shadow run over live connections classifies every old-vs-new headline change as
  fixed lie, deliberate silence correction, or unexpected drift; unexpected drift
  blocks rollout.
- The self-heal loop test: satisfying a `refresh_now`/`reauth` action lands on the
  existing connection, the `satisfied_when` watcher fires ONE confirming run, the
  verdict flips green with no "now run it" step, and an identical re-failure
  re-presents the same action (no false green).
- The refresh-contract task verifies `ConnectionRefreshEvidence` is actually
  populated for amazon / chase / reddit / usaa at runtime (Risk 1), not just
  asserted from the manifest.
- A grep/lint gate forbids raw `health.state` reads AND raw silence decisions in
  `apps/console/**`.
- Grant-scoped REST/MCP reads expose records but NOT `RenderedVerdict.detail` or
  any inspection-layer diagnostic.

## Risks / trade-offs

- **Risk 1 (highest-leverage, gates the glance-correctness claim).** If
  `ConnectionRefreshEvidence` is not wired to the projection for amazon / chase /
  reddit / usaa at runtime, `isManualRefreshOnly` returns false, manual-stale falls
  through to `complete`, and Amazon stays green AND mis-channelled. Asserted from
  manifests, not traced end-to-end. The refresh-contract task must verify the
  runtime input.
- The terminal / `code_fix` channel-as-status path has zero live data (0 terminal
  gaps). The "we're updating the connector — nothing for you to do" status is
  designed, not exercised; the first real stale-selector failure is its acceptance
  test.
- The advisory-vs-attention threshold (Chase retryable, outbox-stalled) is
  principled SRE judgment, not proof. Whether `degraded`-retryable should escalate
  to a deferred push after N hours is an owner-mental-model question only live
  iteration settles.
- S4 depends on a reliable `runtime_ok` signal the projection does not yet take as
  input; a flaky liveness probe could itself become a noise source.
- Worst-wins can over-amber: one trivially-stale low-priority stream rolls the
  whole pill amber. Mitigation: the coverage rollup weights by manifest stream
  priority (the projection already distinguishes required vs accepted-absence
  streams) so optional staleness annotates without downgrading the pill.

## Honest confidence assessment — is this >95% the useful-and-honest ideal?

**FOR (the case for ≥95%):**
- It is **grounded and re-verified live.** ChatGPT's 2,532 gaps are confirmed 100%
  drained / 0 pending — the silence case is real, not hypothetical; zero terminal
  gaps confirm the terminal UX is the only unexercised path; two source premises
  (account=>credential, Chase terminal `current_activity`) were falsified and
  replaced with simpler, correct ones.
- It **folds usefulness in without weakening honesty.** Every honesty invariant
  (1–7) and fork (F1–F7) survives verbatim; silence is routing (S3 forbids
  deletion), never withholding.
- The **silence layer is a de-braid, not new machinery** — it lifts three existing
  ad-hoc silence decisions into one predicate the synthesizer owns. Net complexity
  DOWN (Hickey-clean).
- **tone ⊥ channel** is the precise correction to the prior design's conflation of
  collection health with whether to interrupt — the insight that lets ChatGPT stay
  calm, Amazon/Reddit stay healthy with a refresh affordance, and Chase degrade
  without false owner-urgent language.
- It is **instantly familiar** (Plaid silent-retry + LOGIN_REPAIRED auto-dismiss;
  Stripe `pending_verification` "no action"; Stripe `currently_due` tiering; SRE
  five-question test; calm-tech periphery-default) AND **engineer-respected**
  (single synthesizer, derived terminality, one satisfaction mechanism, one silence
  predicate, everything inspectable one click down).
- The **felt UX earns the right to be ignored** — the property the honesty-only
  design structurally could not reach: it was honest enough to show everything, and
  showing everything trains the owner to ignore everything.

**AGAINST (the named residual, none hidden):**
- **The manual-refresh wiring risk is now closed by reference tests, but still
  needs owner live acceptance after deploy.** `refresh-evidence-wiring.test.js`
  verifies the real manifest policy path for amazon/chase/reddit/usaa and
  `rendered-verdict.test.js` verifies stale manual sources render
  `Healthy/advisory + Refresh now`. The remaining check is visual/live:
  Reddit/Amazon stale rows should no longer read `Needs you`.
- **The terminal / `code_fix` channel-as-status path has zero live data.** The
  most-cited "your action won't help" experience has no live instance; it could be
  subtly wrong in ways only a real stale-selector failure reveals.
- **The advisory-vs-attention threshold is judgment, not proof** — a live-iteration
  question this design cannot fully settle from prior art.
- **S4's `runtime_ok` is a liveness dependency**; a flaky probe could itself become
  noise.

**Verdict: ≥95% confidence for the implemented useful-and-honest live display
contract.** The shape is right and earned twice over — honest (table stakes, fully
preserved) AND useful (the product, now structural). The live sources-confusion
correction closes the false-urgency gap: stale-but-healthy sources stay `Healthy`
with freshness annotation and refresh affordance, while actual degraded collection
health says `Degraded`. The named residuals are the undemonstrated live terminal
path, the owner-calibrated advisory-vs-attention threshold, and runtime-liveness
sensitivity — all honest, none hidden.
