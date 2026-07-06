## Context

The reference already has most of the primitives needed for safe recovery:
`DETAIL_GAP` persistence, `DETAIL_GAPS_PAGE_REQUEST`, attempt counts,
`next_attempt_after`, source-pressure cooldown, `ProviderBudgetController`,
`SendGovernor`, `RunBudget`, and a shared rendered-verdict/actionability model.
The missing piece is ownership. Recovery is still initiated and paced from a mix
of connector-local loops, fixed per-run caps, manual retry buttons, and schedule
ticks.

The Amazon order-item backlog exposed the defect. A local cap of 200 detail
attempts per run safely bounds one run, but repeating "Retry now" immediately
can bypass the intent of a recovery budget. The same class of problem exists
where the owner console says "Checking" for sources that are not actively being
checked; the UI lacks typed recovery state, so it uses a vague bucket.

Existing corpus is sufficient for the architecture:

- `docs/research/client-rate-governance-prior-art-2026-06-10.md` establishes
  the layer doctrine: retry budget, one send governor, post-failure backoff, and
  per-provider isolation.
- `docs/research/collection-governor-generalization-ideal-2026-06-11.md`
  establishes "shared scaffold, different controllers": API and browser
  connectors share the send-governor/detail-gap seam, but their policies differ.
- `docs/research/owner-actionability-prior-art-2026-06-29.md` and
  `docs/research/slvp-connector-health-FINAL-design-2026-06-15.md` establish
  that actionability is not status and that owner interruption should happen
  only when the owner can resolve the issue.

No new external research is required to reach greater than 95% confidence on
the architecture. Live calibration and connector-specific classifiers still
need implementation evidence.

## Goals / Non-Goals

**Goals:**

- Make recoverable detail gaps drain through a connector-neutral recovery
  governor, not through repeated owner clicks.
- Keep one pre-flight send-governor path per provider work domain.
- Reuse the existing provider-budget and source-pressure cooldown primitives
  rather than inventing another rate-control layer.
- Keep browser and API policies distinct while sharing the recovery interface.
- Replace indefinite "Checking" with a finite, evidence-backed owner state.
- Make Amazon order-item recovery the first proof without baking Amazon-specific
  semantics into the runtime.

**Non-Goals:**

- Not a new public protocol field or grant-scoped client surface.
- Not a complete browser-human-envelope calibration project. This change only
  requires browser recovery work to enter the same admission seam and respect a
  conservative browser policy.
- Not an exact unbounded `COUNT(*)` over all detail gaps. Floor counts remain
  valid when the read is intentionally bounded.
- Not a new "force through provider pressure" default. Any force path remains
  explicit and auditable.

## Decisions

### D1. Recovery unit is provider work, not a run

The governor admits recovery work at the smallest replayable unit the runtime
can safely identify: a durable detail-gap item or bounded page of such items.
A connector run is only the execution envelope. A run cap can stop the current
envelope, but the remaining work stays queued with `next_eligible_at` and
attempt metadata for the next eligible recovery envelope.

Alternative rejected: "increase the per-run cap" or "tell the owner to retry
until drained." That makes the run the control unit and offers no cross-run
protection.

### D2. One recovery admission API, two policy families

The runtime exposes one connector-neutral recovery admission concept:

```ts
type RecoveryAdmission =
  | { ok: true; mode: "recover"; workDomain: ProviderWorkDomain }
  | { ok: false; reason: "cooldown" | "budget" | "owner_required" | "system_issue"; nextEligibleAt?: string };
```

The policy behind that API depends on the connector modality:

- API/detail HTTP work uses the existing provider-budget/send-governor stack and
  provider profile.
- Browser/detail work uses the same admission seam but a conservative browser
  policy: serial execution, no owner-interactive auth repair during unattended
  recovery, challenge/session failure classification, and no adaptive speed-up
  from "success" alone.

This follows the prior research: the scaffold is shared; the controller policy
is modality-specific.

### D3. Manual retry uses the same gate

Ordinary owner clicks such as "Retry now" or "Refresh now" are not force
overrides. They ask the same recovery governor whether work may proceed now.
If provider pressure or a `next_attempt_after` floor is active, the UI reports
the next eligible time instead of starting another run.

An explicit force path may exist for operator debugging, but it must be named as
force, audited, and excluded from normal owner CTAs.

### D4. Outcome classification drives scheduling and UI

Recovery outcomes are normalized before they reach scheduler or UI policy:

- `run_cap_deferred`: planned stop; keep queued; no source-pressure cooldown.
- `retry_exhausted`: recoverable no-progress stop; keep queued; may use normal
  recovery cadence; no source-pressure cooldown by itself.
- `temporary_unavailable`: transient item/page failure; keep queued until the
  connector-specific no-progress threshold is reached.
- `rate_limited` / `upstream_pressure`: provider pressure; arm cooldown and
  record the next eligible attempt.
- `owner_required`: owner is the only resolution; surface repair.
- `connector_defect`: repeated deterministic parser/navigation failure or
  terminal classifier; capture fixture and surface system/connector issue.

This explicitly prevents local labels like Amazon's `navigation_retry_exhausted`
from becoming owner-facing copy or accidental source-pressure.

Classification is also directional in time: a pressure classification is
evidence about the provider *then*, not a permanent property of the item.
Cooldowns arm from fresh pressure evidence and expire into automatic
resumption; residual pressure-classified rows must not re-arm a cooldown on
their own. This is not hypothetical: the live ChatGPT diagnosis
(`docs/research/chatgpt-cooldown-and-gap-drain-diagnosis-2026-06-11.md`) found
51 stale `upstream_pressure` gaps re-arming the domain cooldown every tick,
which — combined with the scheduler skipping the whole dispatch under cooldown —
held 942 non-pressure recoverable gaps hostage indefinitely. That live residue
is the regression fixture for this change.

### D4b. Pressure cooldown gates pressure retries, not the connection

The scheduler eligibility seam must consider pending non-pressure recovery work
when a source-pressure cooldown is active. An envelope may launch to drain
non-pressure work during a pressure cooldown because connectors run
recovery-first with in-run guards (density stop, circuit breaker, send
governor), which keep a launched run safe. The cooldown continues to gate
pressure-class retries within the envelope. The rejected alternative — skipping
the entire dispatch while any cooldown is active — is exactly the live
starvation bug above.

### D8. Recovery is live, not a label

"Queued" is a scheduling state with a liveness obligation: eligible work is
self-admitted on cadence, and a queue that stops receiving attempts while
eligible is a detectable system condition (stall watchdog), never a permanent
"catching up" label. Recovery and forward collection get bounded shares of
successive envelopes so neither starves the other.

### D9. Idempotent items, crash-honest accounting

The replayable unit must tolerate replay: recovered records deduplicate on
durable identity, so an attempt interrupted between emit and gap-state update
cannot double-emit. Attempts are counted even when interrupted, and repeated
interruption escalates like deterministic failure — a crash loop must converge
to a connector/system issue, not an infinite retry.

### D10. Quarantine poison items individually

Per-class no-progress thresholds catch systematic defects; per-item thresholds
catch poison items. One item that deterministically fails while siblings
progress is quarantined with captured evidence and a terminal class, keeps its
place in accounting (never silently dropped), and stops consuming the recovery
budget of the items behind it.

### D11. Owner UI pattern: one sentence, one evidence line, one action

The owner UI target is not "show the recovery state machine." The target is a
small number of owner-comprehensible rows that answer, in order:

1. what is happening;
2. whether the owner can usefully act;
3. what evidence supports that answer.

Every source row follows the same composition:

- source and connection name;
- one primary sentence;
- one evidence line;
- at most one primary action.

The primary sentence is a product sentence derived from current evidence, not a
raw status label. Examples:

- "Syncing order details now."
- "Catching up order items when it is safe to retry."
- "Waiting until 3:40 PM before retrying order details."
- "Refresh available."
- "Coverage has not been measured yet."
- "Reconnect this account before collection can continue."
- "Connector needs a fix before this can collect."

The evidence line is concrete and bounded. Examples:

- "396 recovered · at least 2,093 still queued"
- "Last successful sync today · next eligible retry 3:40 PM"
- "No active run · coverage evidence missing for 4 streams"

Normal owner actions never bypass the governor. If the safe answer is "wait",
the row has no retry CTA; it explains the next system step. If the safe answer
is "owner can run this now", the one action may be "Refresh now" or "Retry now".
If the safe answer is "owner repair is required", the one action is the repair
action. If the safe answer is "connector defect", there is no normal retry
button.

The grouped source-attention surface uses owner-action groups, not internal
state taxonomy:

- **Needs you**: the owner is the only practical resolver, such as reconnecting
  an account.
- **Available actions**: the owner can safely start useful work now.
- **PDPP is working**: active collection, queued recovery, or cooldown-backed
  automatic resumption.
- **Needs engineering**: connector/runtime defect or stalled recovery.
- **Not measured**: evidence is absent and no active check is running.

"Checking" is not a durable group. A temporary active check may render only as
named work: "Checking session...", "Measuring coverage...", or "Updating
status...", with an age or timeout. If the temporary work expires, the row moves
to the concrete result state rather than remaining in a vague bucket.

The source detail page adds progressive disclosure for people who want to
understand the recovery queue:

- current step: active, queued, cooling down, waiting for owner, or blocked by
  connector/system issue;
- progress: recovered count, remaining floor count, quarantined count when
  present;
- next attempt: next eligible time or normal cadence;
- why not now: cooldown, budget, owner repair, system issue, or no measured
  coverage;
- recent non-secret evidence: last attempt, last progress, last classified
  failure, and fixture availability when captured.

For the Amazon proof path, the intended UI states are concrete:

- Active recovery: "Syncing order details now." Evidence: recovered count and
  remaining floor. No owner action.
- Queued recovery: "Catching up order items when it is safe to retry." Evidence:
  recovered count, remaining floor, last progress. No owner action.
- Cooldown: "Waiting until 3:40 PM before retrying order details." No normal
  retry action.
- Eligible manual refresh: "Refresh available." Action: "Refresh now."
- Deterministic failure: "Connector needs a fix before this can collect." No
  retry CTA; link to diagnostics or captured evidence.

### D5. The governor owns continuation; connectors own domain work

Connectors still know how to recover an item: which page to open, which API
endpoint to call, which record to emit. The runtime governs when it is safe and
useful to attempt the work, how the attempt is counted, and when repeated
no-progress should stop or escalate.

Connector code therefore shrinks toward:

1. ask for eligible detail-gap page;
2. for each gap, acquire recovery admission/send governor;
3. perform connector-specific hydration;
4. emit recovered record or classified re-deferral.

### D6. "Checking" is short-lived and evidence-backed

"Checking" may appear only when there is current evidence that PDPP is actively
checking: an active connector run, a bounded health/coverage probe, or an
active summary-projection recomputation job. Those are internal predicates, not
owner-facing taxonomy. The owner-facing meaning is only: "PDPP is doing bounded
work now and expects to replace this temporary state with a concrete result."
It must carry a start time and expire into a concrete state if no new evidence
arrives.

Definitions:

- Active connector run: a current active-run lease exists for the connection, so
  provider collection or recovery is in progress.
- Bounded health/coverage probe: a short non-collecting check is in progress,
  such as credential/session readiness, freshness evaluation, or coverage
  rollup refresh.
- Active summary-projection recomputation: the server is rebuilding the
  connection summary from already-stored evidence after a write, deploy, or
  projection invalidation. It is not provider collection and must not be shown
  unless there is a real tracked recomputation in progress.

All other cases get typed copy:

- queued recovery: "Catching up when it is safe to retry."
- provider cooldown: "Waiting until <time> before retrying."
- manual source stale: "Refresh available."
- unknown coverage with no active check: "Coverage has not been measured yet."
- projection read failure: "Status could not be refreshed; showing last known."
- connector defect: "Connector needs a fix before this can collect."

The owner should not have to learn a taxonomy. The product answer is simply:
what is happening, whether the owner can act, and what happens next.

### D7. Proving path

The first implementation should use Amazon order-item gaps as the live proof:
pending gaps recover in paced batches, ordinary retries cannot bypass cooldown,
the UI shows queued/catching-up state with remaining floor counts, and repeated
no-progress item failures are captured as connector evidence rather than owner
busywork.

## Risks / Trade-offs

- **Risk: Browser recovery policy is under-specified.** Mitigation: use a
  conservative serial browser policy in this change and defer richer
  human-envelope calibration. Do not pretend API AIMD applies to browser DOM
  work.
- **Risk: Too much owner UI taxonomy.** Mitigation: keep internal states in the
  projection detail; summary copy answers only owner action and next step.
- **Risk: Manual force remains tempting.** Mitigation: normal CTAs use the
  governor; force requires a distinct route/flag and audit evidence.
- **Risk: A bounded count looks exact.** Mitigation: carry and render floor
  markers consistently for recovery backlog counts.
- **Risk: Classification mistakes hide defects as transient.** Mitigation: add
  no-progress thresholds and fixture capture for repeated deterministic failures.
- **Risk: Starvation coupling regresses.** The scheduler/cooldown seam has
  already produced one live starvation bug. Mitigation: a standing invariant
  test — "a source-pressure cooldown must not block recovery of non-pressure
  gaps" — validated against the live 942-gap residue as the regression fixture,
  plus the stall watchdog so any future coupling surfaces as a system condition
  instead of silent queue rot.
- **Risk: Liveness machinery spams envelopes.** Mitigation: the bounded-share
  rule and normal cadence still govern admission; the watchdog only observes
  and reports, it never force-admits.

## Migration Plan

1. Add pure recovery decision functions and tests over synthetic detail-gap
   rows before changing live connectors.
2. Wire manual run admission to respect provider pressure and recovery floors.
3. Move Amazon order-item gap recovery through the governor as the proof
   connector.
4. Update rendered verdict/actionability copy and tests for active check,
   queued recovery, cooldown, and unknown-without-active-check cases.
5. Deploy and run one supervised Amazon recovery batch to prove continuation
   without repeated owner clicks.
6. Verify the live ChatGPT residue (942 non-pressure gaps held by 51 stale
   pressure rows) begins draining under the new eligibility rule without manual
   data cleanup — the data stays as the regression proof.

Rollback is safe because the durable substrate remains `connector_detail_gaps`.
If the new admission layer misbehaves, disable recovery scheduling and leave
manual connector runs on the pre-change path while retaining the gap rows.
