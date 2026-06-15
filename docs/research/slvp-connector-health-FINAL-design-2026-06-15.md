# The SLVP-Ideal Connector-Health Design — FINAL (honest AND useful)

**Date:** 2026-06-15
**Author:** ink-carbon-polish lane (RI worker) — re-convergence pass
**Status:** FINAL design. Folds the agency + silence research INTO the honesty-complete ideal-design. Design + OpenSpec artifacts only; no implementation code, no DB mutations.

**Builds on (do NOT re-research — these are the inputs):**
- `docs/research/slvp-connector-health-legibility-reflection-2026-06-15.md` — the verified diagnosis (model is honest; render seams drop the axes; recovery was never typed).
- `docs/research/slvp-connector-health-priorart-2026-06-15.md` — Plaid / Stripe / Datadog / GitHub / Nango status + recovery prior art.
- `docs/research/slvp-connector-health-ideal-design-2026-06-15.md` — the honesty-complete converged design + contracts (`RenderedVerdict`, derived terminality, self-heal loop, refresh-contract invariant). **Everything that survived there survives here.**
- `docs/research/slvp-connector-agency-and-silence-2026-06-15.md` — the usefulness/agency/silence correction (the NEW layer this pass folds in).
- `reference-implementation/runtime/connection-health.ts` — the existing **2679-line** `ConnectionHealthSnapshot` projection. Additive only. It already carries `isHealthRelevant`, info-severity `stale_assisted_refresh`, `pushPayload` null-on-`owner_action:"none"`, `interaction_posture`, `forward_disposition`. We synthesize on top; we rewrite nothing.

---

## 0. One-paragraph thesis (what changed in this pass)

The prior ideal-design was **honesty-complete but usefulness-partial**: it optimized *telling the truth* (one synthesized verdict, every off-fresh pill carries its freshness annotation, terminal disposition can never claim "resumes collection") over *doing the work and staying quiet*. Honesty is table stakes; **usefulness is the product.** This pass folds in three things the ideal-design under-weighted, all of which the live code already half-implements: (1) **the agency frontier** — the system ACTS silently where it holds the means (retry, refresh-token, gap-drain) and interrupts the owner ONLY when the owner is genuinely the sole resolution; (2) **the silence discipline** — an honest-but-actionless signal (ChatGPT's 2,532 gaps that have already *drained on their own*) belongs in the inspection layer, NOT alarming the dashboard row; (3) **calm tech** — the dashboard defaults to periphery and earns the right to be ignored, so when it does speak the owner trusts it. The single structural change is: **`RenderedVerdict` gains a `channel` (the attention-vs-inspection routing decision) computed by the same worst-wins synthesizer, and the synthesizer applies a silence predicate that suppresses self-handled signals from the attention channel without ever deleting them from the inspection channel.** Nothing here weakens an honesty invariant — silence is the routing of true information to its correct layer, never the withholding of actionable truth.

---

## 1. Ground truth — re-verified against live Postgres (2026-06-15)

`docker exec pdpp-postgres-1 psql -U pdpp -d pdpp`. Every claim that moves the design is flagged. These confirm the ideal-design's findings AND the agency doc's central example.

| connector | sched | pending gaps | recovered gaps | terminal gaps | reads as |
|---|---|---|---|---|---|
| **chatgpt** | 1 | **0** | **2,532** | 0 | scheduled, all gaps **already drained**, fresh today → the SILENCE case |
| **chase** | 0 | **1** | 0 | 0 | manual, one retryable `transactions` gap frozen ~2 months → the one real unhealthy case |
| **amazon** | 0 | 0 | 0 | 0 | manual-refresh, 31-day stale, nothing scheduled |
| **reddit** | 0 | 0 | 0 | 0 | manual-refresh, 31-day stale |
| **usaa** | 0 | 0 | 0 | 0 | manual-refresh, stale |

**Findings that shape this pass:**

1. **ChatGPT's 2,532 gaps are 100% `recovered`, 0 pending** (confirmed live). This is the decisive silence fact: the prior honesty-design would (correctly, honestly) want to surface "2,532 gaps" as coverage evidence; the agency doc proves it must NOT alarm the dashboard, because **the system already handled it and the owner cannot accelerate a drain that is finished.** The number is true and belongs one click down. On the dashboard, ChatGPT is simply "Healthy · collecting · fresh today."
2. **Zero terminal gaps exist anywhere live** (gap status enum yields only `pending` / `recovered`). The terminal / `code_fix` UX remains designed-but-unexercised, as the ideal-design said. We keep the taxonomy (the enum supports `terminal`) but anchor the demonstrated journeys on the cases that exist.
3. **The one genuinely-owner-actionable live state is Chase** (1 pending retryable gap, frozen because nothing is scheduled to retry it). Even this is *mostly* the system's job (it is retryable); the owner's only role is an optional accelerant. This sharpens the agency frontier: almost nothing the owner sees today is genuinely owner-blocked.
4. **The existing silence primitives are already in the code** (verified): `isHealthRelevant` (attention.ts:518) filters non-blocking notices out of the headline; `pushPayload` (attention.ts:454) returns null when `owner_action === "none"`; `stale_assisted_refresh` is info-severity; `interaction_posture` (controller.ts:155) distinguishes assisted from unattended. **The agency layer is not new machinery — it is the formalization of routing decisions the code already makes ad hoc, lifted into the synthesizer so every surface inherits them.**

---

## 2. The corrected bar: honest AND useful

**SLVP-ideal (Stripe / Linear / Vercel / Plaid), with the calm-tech correction:**

> A non-technical owner glances and *instantly* knows whether they need to do anything — and the honest answer is usually **no**. The dashboard is mostly calm. A break surfaces the *one* clear action only when the owner is genuinely the resolution; doing it makes it *just work*. Everything the system is handling itself stays quiet on the surface and stays fully inspectable one layer down. An engineer respects the model underneath.

The acid test is now two-dimensional, not one:
- **Honesty axis (table stakes):** the verdict never lies, never hides actionable truth, never shows a contradictory chip pair, never claims a future run will fix a terminal gap.
- **Usefulness axis (the product):** the verdict only *interrupts* for what the owner can act on; self-handled work is silent on the attention layer and full-fidelity on the inspection layer; the system earns the right to be ignored.

The three live journeys, re-told with the agency lens:
- **ChatGPT (scheduled, fresh, 2,532 gaps all drained):** dashboard says **"Healthy · collecting · fresh today."** No gap count, no alarm, no badge demanding attention. The 2,532 is in the detail panel. *The system handled it; the owner does nothing; the row is calm.* This is the case the prior honesty-design would have over-surfaced.
- **Amazon (manual-refresh, 31-day stale, nothing scheduled):** dashboard says **"Needs you · last refreshed 31 days ago"** with one **Refresh now** button. The owner IS the resolution (manual-refresh connector won't self-schedule). Surfaced — correctly — because the silence predicate fails: the system is *not* handling it and the owner *can* improve the outcome now.
- **Chase (one retryable gap frozen 2 months):** dashboard says **"Needs you · transactions stuck since Apr 22"** with a **Retry now** escape hatch, and the per-stream row truthfully says *the next run will retry*. Surfaced as a dashboard pill (Tier 2 — "you may want to act"), NOT a push notification, because the gap is retryable and partly the system's job; the owner is an accelerant, not the sole fix.

---

## 3. The RenderedVerdict contract (FINAL — honesty-complete fields KEPT, agency fields ADDED)

One server-owned pure function next to the projection, forwarded verbatim exactly like `connection_health` is today (`ref-control.ts` → `ref-client.ts`). It is the **only** thing any owner-facing console surface renders. Fields marked **[KEPT]** survive verbatim from the ideal-design; **[NEW]** are the agency/silence additions.

```ts
// reference-implementation/runtime/rendered-verdict.ts
// Pure. No I/O, no clock reads. Input = the existing ConnectionHealthSnapshot
// (already on the wire) + per-stream rollups the projection already computes
// + the refresh evidence. Output = the single object every owner surface renders.
export function synthesizeRenderedVerdict(
  snapshot: ConnectionHealthSnapshot,
  streams: readonly StreamHealth[],
  refresh: ConnectionRefreshEvidence | null
): RenderedVerdict;

export interface RenderedVerdict {
  // (A) [KEPT] THE PILL — worst-wins rollup, computed ONCE. tone NEVER read straight from state.
  readonly pill: {
    readonly tone: "green" | "amber" | "red" | "grey";
    readonly label: "Healthy" | "Needs you" | "Can't collect" | "Checking";
  };

  // (B) [NEW] THE CHANNEL — the attention-vs-inspection routing decision, computed
  //     by the SAME synthesizer. This is the silence layer made structural.
  //       "calm"      → row is quiet; system is handling it; owner does nothing.
  //                     (default — the dashboard earns the right to be ignored)
  //       "advisory"  → persistent dashboard pill, "you may want to act", NO push.
  //                     (Tier 2: retryable/self-healing but owner can accelerate)
  //       "attention" → center stage + CTA + (optionally) push. Owner is the
  //                     sole resolution. (Tier 3: needs_attention / owner-blocked)
  //     INVARIANT (silence): channel === "attention" ⟹ at least one required_action
  //     has audience "owner" AND satisfied_when.kind !== "none". An actionless
  //     signal can NEVER reach the attention channel. (See §5, invariant S1.)
  readonly channel: "calm" | "advisory" | "attention";

  // (C) [KEPT] MANDATORY ANNOTATIONS — co-required with the pill. INVARIANT: when
  //     axes.freshness !== "fresh", annotations MUST contain a "freshness" kind.
  //     NOTE the agency refinement (§4.3): a freshness annotation on a CALM row is
  //     toned "neutral" (ambient periphery, e.g. "fresh today" / "collecting"),
  //     and is the ONLY annotation a calm row may carry. Mechanistic annotations
  //     (backlog counts, gap counts, retry counts) are FORBIDDEN on calm/advisory
  //     rows — they live in `detail` only. (See §5, invariant S2.)
  readonly annotations: readonly RenderedAnnotation[];

  // (D) [KEPT] RECONCILED FORWARD STATEMENT — one sentence, DERIVED FROM
  //     required_actions + forward_disposition; can never contradict them.
  readonly forward_statement: string;

  // (E) [KEPT] ZERO-OR-MANY required actions, ordered by urgency. The UI shows the
  //     first as primary, the rest behind "+N more". Empty when calm.
  //     A required_action with audience "maintainer" or "none" renders as a STATUS
  //     line, never an owner button, and never raises channel to "attention".
  readonly required_actions: readonly RequiredAction[];

  // (F) [KEPT] per-stream rows for drill-down; each a mini-verdict that passed the
  //     SAME invariant gate. action_ref indexes into required_actions (NOT a bool).
  readonly streams: readonly RenderedStreamRow[];

  // (G) [KEPT] productivity signal — collection-model-aware (NOT records_emitted).
  readonly progress: RenderedProgress;

  // (H) [KEPT] engineer/inspection layer — the FULL fidelity, demoted behind a
  //     disclosure. THIS is where suppressed-from-attention truth lives: gap
  //     counts, drain rate, retry state, scheduler next_attempt_at, conditions,
  //     raw disposition. Verbatim passthrough. The silence layer routes here;
  //     it never routes to /dev/null. (See §5, invariant S3.)
  readonly detail: {
    readonly state: ConnectionHealthState;
    readonly reason_code: string | null;
    readonly dominant_condition_id: string | null;
    readonly forward_disposition: ForwardDisposition;
    readonly conditions: readonly ConnectionHealthCondition[];
    readonly detail_gap_backlog: DetailGapBacklog | null;   // the 2,532 lives HERE
    readonly next_attempt_at: string | null;
    readonly collection_rate: CollectionRateSnapshot | null;
  };
}

export interface RenderedAnnotation {
  readonly kind: "freshness" | "schedule" | "coverage" | "activity";  // NOTE: no "backlog" on owner surfaces — moved to detail
  readonly tone: "neutral" | "info" | "warning";
  readonly text: string;                  // "Fresh today", "Last refreshed 31 days ago", "Nothing scheduled"
}
// RenderedStreamRow, RenderedProgress: KEPT verbatim from ideal-design §2.
```

### 3.1 How tone reconciles with state and axes — [KEPT verbatim from ideal-design §2.1]

`pill.tone` is a pure **worst-wins** rollup, never a straight read of `state`. This is unchanged and remains the honesty backbone (kills green-while-stale, "3/2 collected", "coverage·unknown · resumes collection"):

```
base   = greenIf(state ∈ {healthy, idle})
tone   = worstOf(base, freshnessTone, coverageTone(worst stream),
                 dispositionTone, attentionTone, outboxTone)
label  = labelFor(tone, dominant)   // green↔Healthy amber↔Needs-you red↔Can't-collect grey↔Checking
```

### 3.2 How channel reconciles — [NEW: the silence layer made structural]

`channel` is computed in the SAME pass, AFTER `tone`, by applying the silence predicate (§5 S1). It is the agency frontier as a pure function of the same evidence:

```
channel = "calm"                                    // default — earn the right to be ignored
if any required_action has audience "owner" AND
   satisfied_when.kind !== "none" AND urgency != "verifying":
    channel = "advisory"                            // owner CAN help → at least surface a pill
if any such owner action ALSO has progress_posture "blocked"
   OR is response_required OR is reauth/add_info that the
   system cannot self-satisfy with held credentials:
    channel = "attention"                           // owner is the SOLE resolution → center stage
```

The crucial interaction with `tone`: **tone and channel are orthogonal.** ChatGPT-fresh is `tone:green / channel:calm`. Amazon-stale is `tone:amber / channel:advisory` (owner can refresh, but it's not urgent and partly the connector's manual nature). A revoked-credential ChatGPT would be `tone:amber / channel:attention` (only the owner's re-auth fixes it). This split is exactly the calm-tech "periphery vs center" decision: **tone says how worried to be; channel says whether to interrupt.** The prior design conflated them (any non-green raised visible alarm); the agency correction separates them.

---

## 4. The agency + silence policy (the NEW layer, per-state)

### 4.1 The agency decision rule (from Plaid + Nango + Google OAuth convergence)

> **A human is required if and only if** the condition cannot be resolved by any operation the system can perform with credentials and access it currently holds, AND inaction will permanently harm data completeness or collection capability.

Corollary (the act-silently mandate): if the system can retry, wait, rotate a token, back off, drain a gap, or fire a confirming run — it **does so silently**, and the owner is not surfaced. This is sourced from the manifest fields the projection already reads (`interaction_posture`, `background_safe`, `recommended_mode`), NOT runtime heuristics.

### 4.2 The silence rule (from Google SRE five-question test + alert-fatigue research)

> **Suppress any honest signal from the attention channel if** (a) the system is actively handling it, AND (b) the owner cannot accelerate or improve the outcome by acting now.

Routed, never deleted: the suppressed signal lands in `detail` (the inspection layer), remaining truthful and one click away. This is progressive disclosure, not concealment.

### 4.3 The dashboard (attention layer) vs detail-panel (inspection layer) split

This is the load-bearing structural decision the agency doc demands and that this pass adds:

| Layer | Surface | Contents | Audience |
|---|---|---|---|
| **Attention layer** | owner dashboard list + connection header | `pill`, `channel`, `forward_statement`, the ONE freshness annotation, `required_actions[0]` IFF owner-actionable | non-technical owner answering "do I need to do anything?" |
| **Inspection layer** | connection detail panel `<details>` + operator console | `detail` (gap counts, drain rate, retry state, `next_attempt_at`, conditions, raw disposition, `collection_rate`, `detail_gap_backlog`) | engineer / reviewer / power user answering "what exactly is happening?" |

The dashboard NEVER shows mechanistic numbers (2,532 gaps, retry count, scheduler tick). It shows "collecting · fresh today." The 2,532 is in the panel. **The number `2532` must not appear on the dashboard; "Healthy · fresh today" must.**

### 4.4 The per-state policy table (the deliverable)

For each health state, the agency decision (decide-rule), the channel, and what reaches the owner. This folds the agency doc's Tier-1/2/3 tables onto the existing 7-state machine.

| State / axis condition | decide-rule | channel | Dashboard shows | Push? | System action |
|---|---|---|---|---|---|
| `healthy`, fresh | act-silently | **calm** | nothing / quiet "Healthy" | no | routine collection |
| `healthy` + `syncing` | act-silently | **calm** | ambient "Collecting" (neutral) | no | run in progress |
| `healthy`/`idle` + **assisted-stale** (`stale_assisted_refresh`, `interaction_posture`∈{credentials,otp,manual}, `next_attempt_at` set) — **the ChatGPT case** | act-silently | **calm** | "Collecting · fresh today" — **no gap count** | no | scheduler draining gaps; 2,532 in `detail` only |
| `cooling_off` (source pressure, scheduled resume) | act-silently | **calm** | quiet, resume time in `detail` | no | scheduler managing cooldown |
| `idle` (manual-only, **stale, owner-refreshable**) — **the Amazon case** | interrupt-the-owner (soft) | **advisory** | "Needs you · 31 days stale" + **Refresh now** | no | none auto; owner is the resolution |
| `degraded` (coverage gap, **retryable**) — **the Chase case** | act-silently + show-quiet | **advisory** | "Needs you · transactions stuck since Apr 22" + **Retry now** | no | system retries; owner optional accelerant |
| `degraded` (outbox **stalled**, no progress) | interrupt-the-owner | **advisory→attention** if device-only fix | "Check the collector" CTA | no (one-time optional) | system cannot self-heal; awaits device |
| `needs_attention` (OTP / CAPTCHA / response_required) | interrupt-the-owner | **attention** | CENTER: CTA + attention card | **yes** | exhausted automatic paths; owner is sole fix |
| `needs_attention` (credential rejected / session expired) | interrupt-the-owner | **attention** | CENTER: Reconnect CTA | **yes** | re-auth needed; held credential rejected |
| `blocked` (give-up streak exceeded) | interrupt-the-owner | **attention** | persistent blocked pill + guidance | optional (one-time) | reconfigure / re-auth |
| terminal gap (`code_fix`, `audience:maintainer`) — **no live instance** | act-silently (toward owner) | **advisory** (status, not action) | "We're updating the connector — nothing for you to do" | no | maintainer code change; owner shown a status, not a button |
| `unknown` (evidence unreliable) | act-silently | **calm/advisory** | "Checking" grey (NEVER red) | no | retry / re-read evidence |

**The inversion this table encodes:** the default is `calm` (silence); `advisory`/`attention` is the exception that must be *earned* by a failed silence predicate. The prior honesty-design's default was effectively "surface the honest axis"; this pass's default is "stay quiet unless the owner is genuinely needed."

### 4.5 Runtime-vs-connection (the Temporal lesson)

A runtime failure (scheduler loop dead, browser surface down, collector device offline) must NOT cascade as N per-connection alarms — that is the worst silence violation (one fault → 12 false attention pulls). The synthesizer takes a `runtime_ok: boolean` input; when false it **caps every per-connection channel at `calm`** and emits ONE global runtime indicator above the list. Per-connection pills stay honest (the connections aren't broken; the runtime serving them is) but they do not individually alarm. This is invariant S4 (§5).

---

## 5. The invariants (gate + test, enforced before paint)

The seven honesty invariants from the ideal-design §4 are **KEPT verbatim** (1 freshness-mandatory, 2 collected≤considered, 3 forward_statement reconciles, 4 terminal===disposition-terminal, 5 no-raw-state-read, 6 tone-worst-wins, 7 label↔tone bijection). The agency layer adds four **silence invariants** (S1–S4), enforced the same way — inside `synthesizeRenderedVerdict` (throw in dev / safe grey verdict in prod) AND pinned by a test that renders the whole verdict and asserts it.

- **S1 — no actionless signal in the attention channel.** `channel === "attention"` ⟹ ∃ a `required_action` with `audience === "owner"` AND `satisfied_when.kind !== "none"` AND it is owner-self-satisfiable (not a maintainer code_fix). An attention pull the owner cannot resolve is a synthesis error. (This is the SRE "an alert you can't act on is a design defect" rule, made a type law.)
- **S2 — mechanistic detail may not appear on calm/advisory annotations.** Annotation `kind` on a `calm` or `advisory` row ∈ {`freshness`, `schedule`, `activity`} with no raw counts in `text`; gap counts / retry counts / backlog scale appear ONLY in `detail`. A `calm` row carries at most ONE annotation (the neutral freshness/activity one). (Kills "2,532 gaps" on the dashboard.)
- **S3 — silence routes, never deletes.** Anything suppressed from `annotations`/`required_actions` by the silence predicate MUST be present in `detail`. The synthesizer asserts `detail` is a strict superset of the evidence the attention layer dropped. (Truth is one click down, never gone.)
- **S4 — runtime faults don't cascade.** `runtime_ok === false` ⟹ every verdict's `channel === "calm"` and a single global runtime indicator is emitted separately. No per-connection verdict may be `attention` while the runtime is the actual fault.

**The braid these untangle:** S1–S4 are not new policy scattered across surfaces — they are the formalization of `isHealthRelevant`, `pushPayload(owner_action:none)→null`, and `stale_assisted_refresh:info` into ONE predicate the synthesizer owns, so every surface inherits identical silence behavior instead of each re-deciding.

---

## 6. The RequiredAction taxonomy + self-heal contract — [KEPT from ideal-design §3, with one agency refinement]

`next_action` is promoted to typed `RequiredAction[]` exactly as the ideal-design specified; `terminal` is **DERIVED** from `forward_disposition` (single source of truth), `satisfied_when` is the **ONE unified machine-checkable predicate mechanism**, and the self-heal loop is unchanged. The agency refinement: each action additionally carries `audience` and an implicit channel contribution (owner+self-satisfiable → can raise `attention`; maintainer/none → caps at `advisory`).

```ts
export interface RequiredAction {
  readonly kind:
    | "reauth" | "refresh_now" | "reattach_schedule" | "add_info"
    | "retry_gap" | "backfill" | "wait" | "code_fix" | "contact_support";
  readonly audience: "owner" | "maintainer" | "none";   // [agency] gates channel: only owner+self-satisfiable → attention
  readonly urgency: "now" | "soon" | "verifying" | "overdue";
  readonly terminal: boolean;            // === (derived_disposition === "terminal"); NOT independent
  readonly affects: readonly string[];
  readonly satisfied_when: SatisfactionContract;   // the ONE unified predicate mechanism
  readonly cta: { label: string; target: "dashboard" | "external_app" | "local_device" | "none";
                  attention_id: string | null };
}

export type SatisfactionContract =
  | { kind: "credential_present_and_unrejected" }
  | { kind: "schedule_attached_and_enabled" }
  | { kind: "attention_resolved"; attention_id: string }
  | { kind: "confirming_run_succeeded"; since: string }
  | { kind: "gap_recovered"; gap_identity: string }
  | { kind: "backfill_window_covered"; window: CoverageWindow }
  | { kind: "none" };                    // wait / code_fix / contact_support — not owner-satisfiable
```

**The self-heal / auto-resume loop is KEPT verbatim** (ideal-design §3.2): satisfy → `satisfied_when` watcher detects the flip → auto re-attach schedule + ONE confirming run + drain → re-synthesize → green, with no "now go run it" step; re-rejection re-opens the SAME action; partial recovery keeps the terminal/owner-blocked stream's own action. **Agency addition:** the `wait` kind (`satisfied_when:{kind:"none"}`, `audience:none`) is the formal home for the ChatGPT-drain and `cooling_off` cases — it carries channel `calm` by construction, so a "wait" action never alarms. This is how "2,532 gaps draining" becomes a calm, silent fact rather than a surfaced one: it is a `wait` action, audience `none`, channel `calm`, detail-only.

---

## 7. The render-time + creation/lifecycle + silence invariants together

### 7.1 Render-time consistency (KEPT + extended)
`collected ≤ considered`; green pill carries its freshness annotation; no contradictory chips; `forward_statement` derived from disposition+actions. **Extended with the silence invariants S1–S4** so the composite is checked for *usefulness* (no actionless attention, no mechanistic dashboard noise, silence-routes-not-deletes, no runtime cascade) as well as honesty.

### 7.2 Creation / lifecycle (KEPT — refresh-contract, NOT account⇒credential)
The refresh-contract invariant survives unchanged and is reaffirmed by live data: ChatGPT is `source_kind=account` + scheduled + **0 credentials** (assisted browser sessions), so "account ⇒ credential" would brand the flagship impossible. The real invariant: an active `account` connection MUST resolve a refresh contract from its manifest (`recommended_mode` + `background_safe`); `automatic` ⟹ schedule attached at activation; `manual` ⟹ schedule-absence is NOT a defect but the connection is typed manual so the projection routes stale → `owner_refresh_due`. **Impossible configs become un-constructable; a stale manual connection can never render green.**

### 7.3 The silence invariant (NEW)
**No actionless signal in the attention channel** (S1), restated as a creation-time + render-time law: the synthesizer cannot construct a verdict whose `channel:"attention"` lacks an owner-self-satisfiable action. Combined with S2 (no mechanistic dashboard noise) and S3 (silence routes to detail), the attention channel is structurally incapable of crying wolf.

---

## 8. The felt UX journey — glance → break → fix → just-works

**Glance (list, calm).** The owner opens the dashboard. Most rows are quiet: ChatGPT "Healthy · fresh today" (green dot, neutral annotation, no gap count, no badge demanding anything). GitHub/Slack/YNAB similar. The list does not buzz. *This is the calm-tech win the prior design lacked: the owner can ignore it, because it's mostly green-and-silent, and they trust that because S1 guarantees nothing alarms unless they're the fix.* Legible to a non-technical owner at a glance; the engineer expands any row for the full `detail`.

**Break (the ONE clear action).** Amazon's row is the exception: amber dot, "Needs you · last refreshed 31 days ago", a single **Refresh now** button. Channel `advisory` — it's a persistent pill, not a push at 2am, because the owner can act but it's not an emergency. Chase shows "Needs you · transactions stuck since Apr 22" + **Retry now**, and its detail panel honestly says the next scheduled retry will also try. There is exactly one primary action per broken connection; `+N more` hides the rest. A maintainer-only terminal gap (no live instance, but designed) would show "We're updating the connector — nothing for you to do" as a *status*, never a dead button.

**Fix.** The owner clicks **Refresh now**. It lands on the EXISTING connection (schedule + tokens survive — no setup wizard). They re-run the assisted session / re-enter the OTP. The pill flips to grey "Checking" while the confirming run fires.

**Just-works (auto-resume).** The `satisfied_when` watcher detects the credential/schedule flip, auto-fires ONE confirming run, drains recoverable gaps, re-synthesizes. The pill goes green, the freshness annotation updates to "Refreshed just now", the row returns to `calm`. **No "now go run it" button ever appears.** If the confirming run fails identically, the action re-presents with the failure reason — the loop never paints a false green.

**The "rarely need to look, earns the right to be ignored" property:** because the default channel is `calm` and S1 forbids actionless attention pulls, the owner learns that when the dashboard *does* surface something, it is real and theirs to fix. Trust is built by being right when it speaks, not by speaking often. That is the calm-tech ideal the honesty-only design could not reach — it was honest enough to show everything, and showing everything trains the owner to ignore everything.

---

## 9. Resolved forks

The ideal-design's seven forks (F1 many-actions, F2 derived-terminal, F3 anchor-on-real-recoverable, F4 refresh-contract-not-credential, F5 no-new-pill-for-deferred, F6 verb-selects-by-kind, F7 server-side-synthesis) are **all KEPT** and unchanged. This pass introduces and resolves five NEW forks the agency layer creates:

| Fork | Verdict |
|---|---|
| **A1 — Is `channel` a separate field or a function of `tone`?** | **SEPARATE field, computed in the same pass.** tone says "how worried"; channel says "whether to interrupt." Conflating them is the prior design's bug (any non-green visibly alarmed). ChatGPT-fresh proves they're orthogonal only at the trivial end; revoked-credential vs manual-stale proves it at the load-bearing end (same amber tone, different channels: attention vs advisory). |
| **A2 — When does `syncing` show vs stay silent?** | **`syncing` shows as a neutral CALM annotation ("Collecting"), never raises channel.** An in-flight run is the system doing its job; it informs (periphery) without demanding (center). It is a `wait`-class state. It never pushes, never ambers the pill on its own. |
| **A3 — Worst-wins priority when multiple issues collide.** | **tone is worst-wins over axes (KEPT); channel is worst-wins over actions' audiences.** A connection with one calm drain + one owner-stale stream rolls tone to the worst axis AND channel to `advisory` (the owner-actionable one wins the channel), while the drain stays detail-only. The two rollups are independent: a red tone with only maintainer actions is `tone:red / channel:advisory` (honest alarm, no false owner interrupt). |
| **A4 — Does ChatGPT's 2,532 drained gaps surface anywhere on the owner dashboard?** | **NO. Detail panel only.** They are `recovered` (live-confirmed 0 pending), the system handled them, the owner cannot accelerate a finished drain. Surfacing them is the exact honesty-myopia this pass corrects. They are a `wait`/`none` action, channel `calm`, present in `detail.detail_gap_backlog`. |
| **A5 — Runtime fault: per-connection alarms or one global?** | **ONE global indicator; per-connection channels capped at `calm` (S4).** A dead scheduler making 12 connections alarm simultaneously is the worst silence violation. The connections aren't broken; the runtime is. Honest pills, no cascade. |

---

## 10. The Hickey simplicity check (de-braiding, not over-engineering)

**What incidental complexity is REMOVED:**
1. **N formatters → 1 verdict.** Every surface re-deriving from `health.state` (the live diagnosis's root cause) collapses to one `synthesizeRenderedVerdict`. (KEPT from ideal-design.)
2. **Terminal is DERIVED, not a new flag.** `RequiredAction.terminal === (forward_disposition === "terminal")`. No second source of truth for "will a future run fix this." (KEPT.)
3. **ONE `satisfied_when` mechanism**, not per-kind ad-hoc satisfaction logic scattered through the controller. (KEPT.)
4. **[NEW] ONE silence predicate, not per-surface routing.** The biggest de-braid this pass adds: `isHealthRelevant`, `pushPayload(owner_action:none)→null`, and `stale_assisted_refresh:info` are today three *separate* ad-hoc silence decisions in different files, each re-deciding "should this reach the owner?". This pass lifts them into a SINGLE `channel` computation inside the synthesizer (S1–S4). Every surface — list, header, push, operator console — inherits the same routing instead of each re-implementing it. **The agency layer is a deletion of divergence, exactly like the honesty layer was.**
5. **[NEW] `wait` action-kind subsumes drain/cooldown/syncing.** Instead of special-casing ChatGPT's deferred-collection, source-pressure cooldown, and in-flight syncing as three separate "don't alarm" exceptions, they are ONE thing: a `wait` action with `audience:none`, `satisfied_when:{kind:"none"}`, channel `calm`. One concept, not three exceptions.

**Confirm it is de-braiding, not over-engineering:** `channel` is not a new state machine — it is a pure projection of evidence the snapshot already carries (`interaction_posture`, `owner_action`, `forward_disposition`, `runtime_ok`), computed by the function that already exists to compute `tone`. It adds one enum field and four invariants; it removes three scattered silence decisions and three drain/cooldown/sync special-cases. Net complexity goes DOWN.

**The ONE simplicity constraint to hold during build (the line to not cross):**

> **There is exactly ONE place that decides whether a connection's state reaches the owner: the `channel` computation inside `synthesizeRenderedVerdict`, applying the unified silence predicate (S1–S4). No surface, no push transport, no list view, no operator console may re-decide "should this alarm?" — they read `verdict.channel` and obey it.**

If during build any surface starts re-deriving "is this actionable / should I show this badge / should I push" from raw axes again, the braid is back and both the honesty AND usefulness guarantees rot one PR at a time — exactly how the original divergence happened. The honesty constraint (no raw `health.state` read, invariant 5) and this usefulness constraint (no raw silence decision, the unified `channel`) are the *same shape of discipline*: one synthesizer owns the verdict, including its routing.

---

## 11. Build plan — strictly additive (KEPT from ideal-design §8, + agency steps)

| # | Step | Size | Gate |
|---|---|---|---|
| 1 | `collected = min(collected, considered)` + caveat reconciliation in `buildCountsLine`/chip composer; composite test. | S | invariant 2 |
| 2 | `case "healthy"` header renders disposition-aware statement (reuse `staleFreshnessGuidance`) not hardcoded "current and complete". | S | invariants 1,3 |
| 3 | `deriveSourceStatus` appends mandatory freshness annotation; fix its doc comment. | S | invariant 1 |
| 4 | **Extract `synthesizeRenderedVerdict` server-side** (incl. `tone` AND `channel`); forward via `ref-control`/`ref-client`; route list+detail+passport through it; grep/lint gate forbidding raw `health.state` reads AND raw silence decisions in `apps/console/**`. | M | invariants 1–7, S1–S4 |
| 5 | Promote `next_action` → `RequiredAction[]` with `terminal` derived, `audience`, `wait`-kind, `satisfied_when`; reconcile `forward_statement` and `channel`. | M | invariants 4, S1 |
| 6 | Refresh-contract creation/lifecycle invariant; verify manual-refresh evidence reaches the projection for amazon/chase/reddit/usaa (the highest-leverage unverified link — Risk 1). | M | F4 |
| 7 | Self-heal loop: `satisfied_when` watcher → auto re-attach + confirming run + drain → re-synthesize; Reconnect lands on existing connection. | L | §6 |
| 8 | `RenderedProgress` mode-aware signal replaces `records_emitted`; dashboard/detail split (S2/S3) wired so mechanistic counts render only in `detail`. | S | S2, S3 |
| 9 | **[NEW] Runtime-vs-connection global indicator** (`runtime_ok` input; cap channels at calm on runtime fault). | S | S4 |

Sequencing: 1–3 stop active lies today; 4 consolidates honesty AND silence into the one synthesizer; 5–7 the recovery arc; 8 the dashboard/detail split (the usefulness payoff); 9 the runtime-cascade guard. 1–4 deliver the calm, correct **glance**; 5–7 the **break→fix→works** loop; 8–9 the **silence/agency** correction.

---

## 12. Honest confidence assessment — is this the SLVP-ideal USEFUL-AND-HONEST design?

**FOR (≥95% the useful-and-honest ideal):**
- It is **grounded, re-verified live.** ChatGPT's 2,532 gaps are confirmed 100% drained / 0 pending — the silence case is real, not hypothetical; zero terminal gaps confirm the terminal UX is the only unexercised path.
- It **folds usefulness in without weakening honesty.** Every honesty invariant (1–7) and every honesty fork (F1–F7) survives verbatim; silence is *routing* (S3 forbids deletion), never withholding.
- The **silence layer is a de-braid, not new machinery** — it lifts three existing ad-hoc silence decisions (`isHealthRelevant`, `pushPayload`, `stale_assisted_refresh`) into one predicate the synthesizer owns. Net complexity DOWN (Hickey-clean).
- **tone⊥channel** is the precise correction to the prior design's conflation of "how worried" with "whether to interrupt" — the load-bearing insight that makes ChatGPT calm while Amazon surfaces.
- It is **instantly familiar** (Plaid silent-retry + LOGIN_REPAIRED auto-dismiss; Stripe pending_verification "no action"; SRE five-question test; calm-tech periphery-default) AND **engineer-respected** (single synthesizer, derived terminality, one satisfaction mechanism, one silence predicate).
- The **felt UX earns the right to be ignored** — the property the honesty-only design structurally could not reach.

**AGAINST (the named 4–6%):**
- **Risk 1 (KEPT from ideal-design) is still the highest-leverage unverified link:** if manual-refresh evidence isn't wired to the projection for amazon/chase/reddit/usaa at runtime, step 6 is inert and Amazon stays green AND mis-channelled. Asserted from manifests, not traced end-to-end. Gates the glance-correctness claim to ~92% until step 6 verifies.
- **The terminal / `code_fix` channel-as-status path has zero live data** (0 terminal gaps). The "we're updating the connector, nothing for you" status is designed, not exercised; first real stale-selector failure is its acceptance test.
- **The advisory-vs-attention threshold (Chase, outbox-stalled) is principled SRE judgment, not proof** — whether `degraded`-retryable should ever escalate to a deferred push after N hours is an owner-mental-model question only live iteration settles.
- **S4 runtime-cascade guard depends on a reliable `runtime_ok` signal** that the projection does not yet take as input; a flaky liveness probe could itself become a noise source.

**Verdict: ~92–94% the useful-and-honest ideal *as a design*, gated to ≥95% the moment step 6 verifies refresh-evidence wiring and a first live terminal case exercises the maintainer-status channel.** The shape is right and earned twice over — honest (table stakes, fully preserved) AND useful (the product, now structural). The named residual is one unverified runtime link, one undemonstrated terminal path, one judgment-call threshold, and one new liveness dependency — all honest, none hidden. This is the design to build on: not greenfield, not the honesty-only ideal as written, but its surviving honest shape with the agency/silence correction folded in as one more de-braiding synthesizer responsibility.

---

*Corpus artifact for the connector-health re-convergence. Folds `slvp-connector-agency-and-silence-2026-06-15.md` INTO `slvp-connector-health-ideal-design-2026-06-15.md`; preserves every honesty invariant and fork; adds the `channel` field, the silence predicate (S1–S4), the dashboard/detail split, the `wait` action-kind, and the runtime-cascade guard. Builds on `connection-health.ts` at HEAD. Honesty is table stakes; usefulness is the product.*
