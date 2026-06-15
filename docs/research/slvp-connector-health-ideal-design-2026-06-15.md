# The SLVP-Ideal Connector-Health Design — definitive, buildable-from spec

**Date:** 2026-06-15
**Author:** ink-carbon-polish lane (RI worker) — convergence pass
**Status:** definitive design. Synthesizes 3 proposals + 9 adversarial pressure-tests, re-grounded against the live `pdpp` Postgres. Design only; no code/DB changes were made.
**Builds on (do NOT re-research):**
- `docs/research/slvp-connector-health-legibility-reflection-2026-06-15.md` — the verified diagnosis (the 6 never-formed goals, the render/recovery seams).
- `reference-implementation/runtime/connection-health.ts` — the **existing 2679-line** `ConnectionHealthSnapshot` projection. **This design adds a synthesis layer, one promoted field, and a recovery contract on top of it. It rewrites nothing.**
- `docs/research/sources-slvp-redesign-and-data-health-2026-06-11.md` — Plaid update-mode shape, the "single-voice synthesis layer".

> **One-paragraph thesis.** The model is right and honest; the **render seams** drop its axes and the **recovery seam** was never typed. The fix is a single server-owned `synthesizeRenderedVerdict(snapshot) → RenderedVerdict` that every surface renders verbatim, a `RequiredAction` whose terminality is **derived from the disposition the projection already computes** (not a second source of truth), a **satisfy→auto-resume** loop that lands on the *existing* connection, and a **refresh-contract** creation invariant — NOT the "account ⇒ credential" invariant, which the live DB proves would break the system's best connection.

---

## 0. Ground truth — re-verified against live Postgres at convergence time

Every disputed claim in the source proposals was re-run against `docker exec pdpp-postgres-1 psql -U pdpp -d pdpp`. Findings that **change the design** are flagged.

### 0.1 The instance census (`connector_instances` ⋈ schedules/credentials/records)

| connector | source_kind | status | sched | cred | records | manifest `recommended_mode` / `background_safe` / `interaction_posture` |
|---|---|---|---|---|---|---|
| **chatgpt** | account | active | **1** | **0** | 126,653 | automatic / true / manual_action_likely |
| **amazon** | account | active | **0** | **0** | 2,868 | **manual / false** / otp_likely |
| **chase** | account | active | **0** | **0** | 1,169 | **manual / false** / otp_likely |
| **reddit** | account | active | **0** | **0** | 1,770 | **manual / false** / credentials |
| **usaa** | account | active | **0** | **0** | 1,924 | **manual / false** / manual_action_likely |
| github | account | active | 1 | 1 | 10,158 | — |
| slack | account | active | 1 | 1 | 362,601 | — |
| ynab | account | active | 1 | 1 | 22,631 | — |
| gmail (active) | account | active | 1 | 1 | 97,000 | — |
| claude-code ×3, codex | local_device | active | 0 | 0 | 1.0M / 0.7M / … | — |
| whatsapp | manual | active | 0 | 0 | 89,310 | — |

### 0.2 Findings that **kill or reshape** a source claim

1. **The "account ⇒ credential" creation invariant is FALSE at the wire and would break the flagship.** ChatGPT — the proposals' OWN "healthy" exemplar — is `source_kind=account`, scheduled (3600s, enabled, updated today), 126k records, and **has zero credential rows** because it collects via owner-assisted browser sessions (`interaction_posture: manual_action_likely`, `recommended_mode: automatic`). The proposal-1 invariant "an active account connection MUST have a schedule + credential" would brand ChatGPT impossible. **Verdict: the invariant must key on a *refresh contract*, never on credential presence.** (See §6, fork F4.)

2. **The "impossible config" is the norm, not 2 edge cases.** Amazon, Chase, Reddit, USAA are ALL active account sources with records, **zero schedule, zero credential**. But the manifests say `recommended_mode: manual, background_safe: false` for all four — they are **legitimately schedule-less manual-refresh connectors**, not corrupt rows. The defect is not their existence; it's that **a stale manual-refresh connection renders a green "current and complete" headline and surfaces no "run this now" affordance.**

3. **The Chase `current_activity` "terminal_gap needing a code_fix" example does NOT exist in the live DB.** `connector_detail_gaps` for Chase has exactly **one** pending gap: `transactions / temporary_unavailable` (retryable). `current_activity` has 15 records, latest 2026-06-11 (4 days old), **zero gaps**. There are **zero `terminal`-status gaps anywhere** in the live DB. **Verdict: do not design the UI against a Chase terminal example that isn't present.** The taxonomy must still *support* terminality (the `connector_detail_gaps.status` enum includes `terminal`; `CoverageAxis` includes `terminal_gap`; `ForwardDisposition` includes `terminal`), but the canonical *live* unhealthy case is Chase's **frozen-2-months recoverable** transactions gap, not a terminal one.

4. **Terminal-vs-recoverable ALREADY exists in the projection.** `deriveForwardDisposition` (connection-health.ts:2111) is a first-match-wins pure function returning `awaiting_owner | resumable | terminal | owner_refresh_due | complete`. `terminal_gap`/`unsupported`/`unavailable` → `terminal`; manual-refresh-stale → `owner_refresh_due`; attention-blocked → `awaiting_owner`. **Verdict: `RequiredAction.terminal` MUST be derived FROM `forward_disposition`, never a parallel boolean — a second source of truth re-creates the exact fragmentation we are deleting.** This is the single most important architectural correction to proposal-1.

5. **The freshness staleness IS real and run-anchored.** `scheduler_last_run_times`: Amazon last run **2026-05-15** (31 days), Reddit **2026-05-15** (31 days); Chase has no scheduled-run row at all. ChatGPT last run **today 13:57**. Record `emitted_at` is *source event time*, not collection time — so the reflection's "freshness rides a one-off June run" mechanism is slightly off (Amazon has no June `acquisition_batches` row; its June `emitted_at` values are event dates from the 05-15 collection), but the **conclusion holds**: Amazon/Reddit are run-stale by a month, nothing is scheduled, and the headline is green.

6. **ChatGPT `records_emitted=0` is structural, confirmed.** 46 succeeded + 82 skipped + 24 failed runs, **every one `records_emitted=0`, `reported_records_emitted=NULL`**; all 2,532 detail-gaps are `recovered` (drained). 126k records arrived entirely via deferred gap materialization. The "records this run = 0" footgun is real.

**Net effect on the design:** two of proposal-1's load-bearing premises (account⇒credential; Chase terminal current_activity) are factually wrong; one (terminal model is missing) is wrong because the model already exists. The *shape* proposal-1 advocates — one synthesized verdict + one typed action + a self-heal loop — survives and is correct. The design below keeps the shape and replaces the wrong premises with the verified ones.

---

## 1. The bar and the journey we are designing for

**SLVP-ideal (Stripe / Linear / Vercel / Plaid):** a non-technical owner glances and *instantly* knows each connector's state; a break shows the *one* clear fix; doing the fix makes it *just work* — and an engineer respects the model underneath. The acid test is the **break → fix → works** journey, instantiated on the two live cases that actually exist:

- **Amazon (manual-refresh, month-stale, no scheduled run):** owner sees amber "Needs you · last refreshed 31 days ago", one button **Refresh now** (or Reconnect if the assisted session has expired); clicking it runs the connection in place, drains nothing terminal, and flips to green — no separate "now go run it" step.
- **Chase (one stream frozen 2 months on a retryable gap):** owner sees amber "Needs you · transactions stuck since Apr 22", the per-stream row says *this resumes on the next run* (truthful — it is `temporary_unavailable`/retryable), and the recovery is **automatic retry** with a manual **Retry now** escape hatch.

---

## 2. The RenderedVerdict contract (buildable-from)

One server-owned function lives next to the projection and is forwarded verbatim exactly like `connection_health` already is (`ref-control.ts` → `ref-client.ts`). It is the **only** thing any console surface renders.

```ts
// reference-implementation/runtime/rendered-verdict.ts
//
// Pure. No I/O, no clock reads. Input is the existing ConnectionHealthSnapshot
// (already forwarded over the wire) plus the per-stream rollups the projection
// already computes. Output is the single object every surface renders verbatim.
export function synthesizeRenderedVerdict(
  snapshot: ConnectionHealthSnapshot,
  streams: readonly StreamHealth[],        // per-stream coverage+disposition the projection already has
  refresh: ConnectionRefreshEvidence | null
): RenderedVerdict;

export interface RenderedVerdict {
  // (A) THE PILL — worst-wins rollup, computed ONCE. tone is NEVER read straight from state.
  readonly pill: {
    readonly tone: "green" | "amber" | "red" | "grey";
    readonly label: "Healthy" | "Needs you" | "Can't collect" | "Checking";
  };

  // (B) MANDATORY ANNOTATIONS — co-required with the pill. INVARIANT: when
  //     axes.freshness !== "fresh", annotations MUST contain a "freshness" kind,
  //     or synthesize() throws (gate, see §4). Empty array is legal ONLY when fresh.
  readonly annotations: readonly RenderedAnnotation[];

  // (C) RECONCILED FORWARD STATEMENT — one sentence, DERIVED FROM required_action
  //     and forward_disposition; can never contradict them (§4 invariant 3).
  readonly forward_statement: string;

  // (D) ZERO-OR-MANY required actions. NOTE: NOT zero-or-one — see fork F1.
  //     Ordered by urgency; the UI shows the first as primary, the rest as a
  //     "+N more" disclosure. Empty when healthy/fresh.
  readonly required_actions: readonly RequiredAction[];

  // (E) per-stream rows for drill-down; each is a mini-verdict that passed the
  //     SAME invariant gate. action_ref points into required_actions (NOT a bool),
  //     so a row can say "terminally lost" while a sibling says "resumes".
  readonly streams: readonly RenderedStreamRow[];

  // (F) productivity signal — collection-model-aware (NOT records_emitted). §5.
  readonly progress: RenderedProgress;

  // (G) engineer layer, demoted behind a disclosure. Verbatim passthrough.
  readonly detail: {
    readonly state: ConnectionHealthState;
    readonly reason_code: string | null;
    readonly dominant_condition_id: string | null;
    readonly forward_disposition: ForwardDisposition;
    readonly conditions: readonly ConnectionHealthCondition[];
  };
}

export interface RenderedAnnotation {
  readonly kind: "freshness" | "schedule" | "coverage" | "backlog" | "activity";
  readonly tone: "neutral" | "info" | "warning";
  readonly text: string;                  // "Last refreshed 31 days ago", "Nothing scheduled"
}

export interface RenderedStreamRow {
  readonly stream_id: string;
  readonly tone: "green" | "amber" | "red" | "grey";
  readonly line: string;                  // already passed collected<=considered + caveat gates
  readonly disposition: ForwardDisposition;
  readonly action_ref: number | null;     // index into required_actions, or null
}

export interface RenderedProgress {
  readonly mode: "scheduled" | "manual" | "deferred" | "local_device";
  readonly records_committed_last_run: number | null;  // null when not applicable
  readonly gaps_drained_last_run: number | null;       // the ChatGPT-true signal
  readonly retained_records: number;
  readonly label: string;                 // "Collecting · 126,653 retained · last refresh 12m ago"
}
```

### 2.1 How tone reconciles with state and axes (the core fix)

`pill.tone` is a pure **worst-wins** rollup, never a straight read of `state`:

```
base   = greenIf(state ∈ {healthy, idle})           // healthy/idle start green
tone   = worstOf(
           base,
           freshnessTone(axes.freshness),            // stale → amber (unless already red)
           coverageTone(worst stream coverage),      // terminal_gap → red; gaps/partial → amber
           dispositionTone(forward_disposition),     // terminal → red; awaiting_owner → amber
           attentionTone(axes.attention),            // open → amber
           outboxTone(axes.outbox)                    // stalled → amber/red
         )
label  = labelFor(tone, dominant)                    // green→Healthy, amber→Needs you,
                                                      // red→Can't collect, grey→Checking
```

This makes the three live lies **structurally impossible**:
- *green-while-stale*: a `state:healthy` + `axes.freshness:stale` snapshot rolls to `tone:amber`, and the freshness annotation is **mandatory** (invariant B), so green + hidden-stale-badge cannot be emitted.
- *"3/2 collected"*: dies in the stream-row builder — `collected = min(collected, considered)` is enforced before formatting and the gate rejects any row where `collected > considered` (§4).
- *"coverage·unknown · resumes collection"*: `forward_statement` and each row's `line` are derived FROM `disposition`. The projection already returns `resumable` for `unknown` coverage (a later run is *expected* to establish coverage), so the truthful copy is **"Coverage not yet measured — the next run will establish it,"** never a bare "resumes collection" implying we already know what's missing.

### 2.2 Plaid / Stripe mapping (so it is instantly familiar)

| RenderedVerdict | Plaid Item | Stripe Account |
|---|---|---|
| `pill` | Item status (`HEALTHY`/`ITEM_LOGIN_REQUIRED`) | `charges_enabled` glance |
| `forward_statement` + primary `required_action` | error envelope `display_message` + update-mode | most-urgent `requirements.errors[]` row |
| `required_actions[1..]` | — | the rest of `currently_due` |
| `streams[].action_ref` | — | "capabilities this requirement affects" |
| `detail` | `error_code`/`error_message` | full `requirements` object |

---

## 3. The RequiredAction taxonomy + self-heal contract

`next_action` (today a non-secret CTA) is **promoted** to a typed `RequiredAction`. The terminality and the disposition reconciliation are **derived from the projection's existing `forward_disposition`**, so there is exactly one source of truth for "will a future run fix this."

```ts
export interface RequiredAction {
  readonly kind:
    | "reauth"             // assisted session expired / credential rejected
    | "refresh_now"        // manual-refresh connection is stale; owner-initiated run is due
    | "reattach_schedule"  // an automatic connection lost its schedule row
    | "add_info"           // structured attention needs a value (OTP, re-consent)
    | "retry_gap"          // a retryable detail gap; auto-retries, manual escape hatch
    | "backfill"           // historical window requested
    | "wait"               // cooling-off / in-progress; owner does nothing
    | "code_fix"           // terminal: connector/source change required (owner can't help)
    | "contact_support";   // terminal, non-self-serviceable
  readonly audience: "owner" | "maintainer" | "none";   // GitHub "fix it the way it broke"
  readonly urgency: "now" | "soon" | "verifying" | "overdue";
  readonly terminal: boolean;            // === (derived_disposition === "terminal"); NOT independent
  readonly affects: readonly string[];   // stream ids this action unblocks
  readonly satisfied_when: SatisfactionContract;
  readonly cta: { label: string; target: "dashboard" | "external_app" | "local_device" | "none";
                  attention_id: string | null };
}
```

### 3.1 The satisfaction contract (the part that makes self-heal *provable*)

Every non-terminal action carries a **machine-checkable** condition the runtime can evaluate without the owner telling it "done":

```ts
export type SatisfactionContract =
  | { kind: "credential_present_and_unrejected" }      // reauth: a non-rejected credential row exists
  | { kind: "schedule_attached_and_enabled" }          // reattach_schedule
  | { kind: "attention_resolved"; attention_id: string } // add_info: structured attention lifecycle = resolved
  | { kind: "confirming_run_succeeded"; since: string } // refresh_now / retry_gap: a run after `since` succeeded
  | { kind: "gap_recovered"; gap_identity: string }     // retry_gap on a specific gap
  | { kind: "backfill_window_covered"; window: CoverageWindow }
  | { kind: "none" };                                   // wait / code_fix / contact_support: not owner-satisfiable
```

**`satisfied_when` for terminal kinds (`code_fix`, `contact_support`) is `{ kind: "none" }`** — and the forward_statement for these reads **"We need to update the connector — there's nothing you can do here,"** never "resumes collection." This is the GitHub "audience" rule: a `code_fix` is `audience: "maintainer"`, so the owner UI shows it as a *status*, not an actionable button.

### 3.2 The self-heal / auto-resume loop (Plaid update-mode)

This is the second half of the owner's ask — *"then it should just work."* The loop is driven entirely by `satisfied_when`, with **no separate "now run it" step**:

```
1. Owner clicks the action's CTA. It lands on the EXISTING connection
   (schedule + tokens survive — never a fresh setup wizard).
2. Owner satisfies the action (re-runs the assisted session / re-enters OTP /
   triggers refresh). The credential row / schedule row / attention lifecycle flips.
3. A `satisfied_when` watcher (in the connection controller, polling the durable
   evidence the projection already reads) detects the flip.
4. The runtime AUTOMATICALLY:
     a. re-attaches the schedule if reattach_schedule was the action,
     b. fires ONE confirming run,
     c. lets recoverable detail-gaps drain on that run,
     d. re-synthesizes the verdict.
5. The verdict transitions to green when `confirming_run_succeeded` (or
   `gap_recovered`) holds. If the confirming run fails the SAME way, the action
   does NOT clear — it re-presents with the failure reason (no false green).
```

Idempotency / anti-storm guards (carried over from existing scheduler discipline): the confirming run respects the existing backoff/cooldown machinery; a `satisfied_when` that flips back to false (credential re-rejected) re-opens the SAME action rather than queueing a second one.

---

## 4. The invariants (gate + test, enforced before paint)

These are the typed composite-consistency rules. Each is enforced inside `synthesizeRenderedVerdict` (throws in dev / returns a `grey "Checking"` safe verdict in prod) **and** pinned by a test that *renders the whole verdict and asserts it* — not N independently-tested formatters.

1. **Freshness annotation is mandatory off-fresh.** `axes.freshness !== "fresh"` ⟹ `annotations` contains a `freshness` kind. (Kills green-while-stale.)
2. **`collected ≤ considered` on every stream row.** `collected = min(collected, considered)` enforced; a raw `collected > considered` is a synthesis error. (Kills "3/2".)
3. **forward_statement reconciles with disposition + actions.** It is *derived* from `(forward_disposition, primary required_action)`; it may not say "resumes collection" when disposition ∈ {`terminal`, `awaiting_owner`} or when the primary action is terminal. `coverage:unknown` ⟹ statement names *measurement* ("the next run will establish coverage"), never asserts a known-missing set. (Kills the contradictory chip pair.)
4. **`required_action.terminal === (derived_disposition === "terminal")`.** Single source of truth — the action cannot disagree with the projection. (Kills the dual-terminality fork.)
5. **No raw `health.state` read outside `synthesizeRenderedVerdict`.** Enforced by a grep/lint gate over `apps/console/**`. (Kills future re-divergence.)
6. **tone is worst-wins, never `labelFor(state)` directly.** Asserted by a property test over a matrix of `(state × freshness × coverage × disposition × attention)`.
7. **Pill label ↔ tone bijection.** `green↔Healthy, amber↔Needs you, red↔Can't collect, grey↔Checking`; no other pairing is constructible.

---

## 5. The collection-model-aware progress signal

`records_emitted` is structurally 0 for deferred connectors (ChatGPT: 46 succeeded runs, all 0). `RenderedProgress` replaces "records this run" with a **mode-aware** signal computed from evidence the projection already holds:

- `mode: "scheduled"` (slack, ynab, github) → `records_committed_last_run` is meaningful; label "Collecting · committed N last run".
- `mode: "deferred"` (chatgpt) → privilege `gaps_drained_last_run` and `retained_records`; label "Collecting via background drain · 126,653 retained · last refresh 12m ago". **Never** show a lone `0`.
- `mode: "manual"` (amazon, chase, reddit, usaa) → label centers `retained_records` + "last refreshed Nd ago" + the `refresh_now` affordance.
- `mode: "local_device"` (claude-code, codex) → trust the device's outbox-drained verdict; label "Synced from device · N retained".

The "did it work?" eye never lands on a structurally-zero number.

---

## 6. Resolved forks (every open fork earns a verdict)

**F1 — zero-or-one vs zero-or-many RequiredActions. → MANY (ordered).**
The pressure-test is decisive: Amazon needs BOTH `refresh_now` AND (if the assisted session expired) `reauth`; a connection can mix a recoverable stream and a terminal stream of *opposite* terminality. A single-action envelope must lie about one of them. Resolution: `required_actions: RequiredAction[]` ordered by urgency; UI shows the first as the primary button and the rest behind "+N more"; `streams[].action_ref` points at the specific action so a terminally-lost stream and a resuming stream render correctly *in the same verdict*. This keeps Stripe's "single most-urgent row" *presentation* while preserving the truth Stripe also preserves via `requirements.errors[]` being a list.

**F2 — is `RequiredAction.terminal` a new field or derived? → DERIVED.**
`terminal` MUST equal `(derived_disposition === "terminal")`. Invariant 4 enforces it. A parallel boolean re-creates the fragmentation. The projection's `deriveForwardDisposition` is the sole terminality oracle.

**F3 — design around Chase terminal `current_activity`? → NO; support terminality, anchor the live UX on Chase's REAL recoverable gap.**
Live DB has zero terminal gaps. The taxonomy keeps `code_fix`/`terminal` (the enum exists; a future stale-selector failure will land there), but the canonical *demonstrated* unhealthy journey is Chase's `transactions / temporary_unavailable` retryable-but-frozen-2-months case. The honest copy there is "stuck since Apr 22 · the next run will retry," with a **Retry now** escape hatch — NOT "your action won't help."

**F4 — the creation invariant: "account ⇒ schedule + credential"? → REFRAME to "account ⇒ declared refresh contract; manual-stale ⇒ owner_refresh_due, never green."**
Live DB kills the credential premise (ChatGPT). The real invariant is two-part:
- *Creation/lifecycle (write-boundary):* an active `account` connection MUST resolve a refresh contract from its manifest (`recommended_mode ∈ {automatic, manual, paused}` + `background_safe`). `automatic` ⟹ a schedule row is attached at activation (Amazon-shaped "automatic but no schedule" becomes un-constructable). `manual` ⟹ **no schedule is required and its absence is not a defect** — but the connection MUST be typed manual so the projection routes it to `owner_refresh_due` when stale.
- *Render-time (the actual legibility fix):* a `manual` connection whose `axes.freshness === stale` MUST render `forward_statement = "Last refreshed Nd ago — refresh to update"` + a `refresh_now` action, **never** green "current and complete." `deriveForwardDisposition` already returns `owner_refresh_due` for exactly this (`freshness === "stale" && isManualRefreshOnly(refresh)`) — the bug is that the **refresh evidence must actually reach the projection** for Amazon/Chase/Reddit/USAA (their manifest says `manual/false`; confirm the projection input is wired so `isManualRefreshOnly` returns true), and the **headline display must consult the disposition** instead of returning a hardcoded "current and complete."

**F5 — does ChatGPT need a new pill for "productive via deferred materialization"? → NO new pill; `RenderedProgress.mode` carries it.**
A new pill violates the orthogonal-axes principle the model was built on. `mode: "deferred"` + `gaps_drained_last_run` distinguishes a healthy ChatGPT (draining) from an idle-never-collected connection (retained=0) without a binary pill ambiguity.

**F6 — `forward_statement` for no-credential-ever scrape sources promising a "reconnect" that doesn't exist? → action `kind` selects the verb; `refresh_now` ≠ `reauth`.**
For a manual scrape source that never had a credential capture flow, the action is `refresh_now` (re-run the assisted session), and the statement is "Refresh to update," not "Reconnect." `reauth` (the Plaid-Link-style verb) is reserved for connections that DO have a credential/session that was rejected. The CTA verb is a function of `kind`, so the statement never promises a flow the source lacks.

**F7 — where does synthesis live, server or console? → SERVER (forwarded verbatim), like the snapshot.**
`reference-implementation/runtime/rendered-verdict.ts`, forwarded through `ref-control.ts`/`ref-client.ts` exactly as `connection_health` is today. The console renders it; it never re-synthesizes. This is what makes invariant 5 (no raw `state` reads) enforceable.

---

## 7. UI spec for the break → fix → works journey

**Glance (list — `records/page.tsx` via `sources-view-model.ts`):** each connector shows `pill.tone` dot + `pill.label` + the **first mandatory annotation** (freshness). Amazon: amber dot, "Needs you", "31 days stale". No bare green dots — invariant B forbids it. `deriveSourceStatus` is rewritten to consume `RenderedVerdict.pill` + `annotations[0]`, and its doc comment (which currently enshrines "state is the whole contract") is corrected.

**Detail (connection page — `connection-evidence.ts`):**
- Header = `pill` + `forward_statement` + all `annotations`. The `case "healthy"` branch that hardcodes "Required coverage is current and complete." is replaced by rendering `forward_statement` (which is stale-aware via the disposition).
- Primary CTA = `required_actions[0].cta` shown only to its `audience` (owner sees `refresh_now`; a `code_fix`'s maintainer-audience action renders as a status line, not a button).
- Per-stream table = `streams[]` rows; each `line` already passed the `collected ≤ considered` + caveat gates; terminal rows render distinctly from resuming rows via `action_ref`.
- Engineer disclosure = `detail` (state, reason_code, conditions, raw disposition) behind a `<details>`.

**Fix (the action):** clicking `refresh_now`/`reauth` lands on the **existing** connection (schedule + tokens survive). The owner satisfies it; the `satisfied_when` watcher fires the confirming run automatically. The pill shows `grey "Checking"` (syncing) during the confirming run, then green. **No "now go run it" button ever appears.**

**Works:** verdict flips to green; the freshness annotation updates to "Refreshed just now"; `RenderedProgress` shows the committed/drained count. If the confirming run fails identically, the action re-presents with the failure reason — the loop never paints a false green.

---

## 8. Build plan — strictly additive on the existing model

Each step is shippable, test-gated, and *reduces* divergence. Nothing rewrites the 2679-line projection.

| # | Step | Files | Size | Gate |
|---|---|---|---|---|
| 1 | `collected = min(collected, considered)` + caveat reconciliation in `buildCountsLine` and the chip composer; test renders the composite. | `apps/console/.../lib/collection-report.ts` (+test) | S | invariant 2 |
| 2 | `case "healthy"` headline renders the disposition-aware statement (reuse the existing `staleFreshnessGuidance`/`axes.freshness` path already in the file at ~L1415) instead of hardcoded "current and complete." | `apps/console/.../lib/connection-evidence.ts` | S | invariant 1,3 |
| 3 | `deriveSourceStatus` appends mandatory freshness annotation; fix its doc comment. | `apps/console/.../records/sources-view-model.ts` | S | invariant 1 |
| 4 | **Extract `synthesizeRenderedVerdict` server-side**; forward `RenderedVerdict` via `ref-control.ts`/`ref-client.ts`; route list+detail+passport through it; add the grep/lint gate forbidding raw `health.state` reads in `apps/console/**`. | new `reference-implementation/runtime/rendered-verdict.ts` (+test) + console consumers | M | invariants 1–7 |
| 5 | Promote `next_action` → `RequiredAction[]` with `terminal` **derived from** `forward_disposition` and `satisfied_when` contracts; reconcile `forward_statement`. | `connection-health.ts`, `ref-control.ts`, `ref-client.ts` | M | invariant 4 |
| 6 | Refresh-contract creation/lifecycle invariant: `automatic` ⟹ schedule attached at activation; `manual` ⟹ typed manual + wired refresh evidence so `isManualRefreshOnly` returns true (Amazon/Chase/Reddit/USAA) → projection routes stale to `owner_refresh_due`. NO credential invariant. | connection-create + schedule-detach write paths; verify projection refresh-evidence wiring | M | F4 |
| 7 | Self-heal loop: `satisfied_when` watcher in the connection controller → auto re-attach schedule + one confirming run + drain → re-synthesize; "Reconnect lands on existing connection" path; anti-storm via existing backoff. | scheduler + connection controller + console Reconnect/Refresh flow | L | §3.2 |
| 8 | `RenderedProgress` mode-aware signal replaces `records_emitted` in the run readout. | run-summary projection + console run readout | S | §5 |

**Sequencing:** 1–3 stop active lies today and seed the composite-invariant test pattern; 4 consolidates so they can't re-diverge; 5–7 are the recovery arc (type the action → enforce valid configs → close the loop); 8 is orthogonal. 1–4 deliver the **glance** correctness; 5–7 deliver the **break→fix→works** loop.

---

## 9. Residual risks

1. **Refresh-evidence wiring for manual connectors is assumed, not verified end-to-end.** `deriveForwardDisposition` returns `owner_refresh_due` only when `isManualRefreshOnly(refresh)` is true AND `freshness === stale`. The manifests say `manual/false`, but I did not trace that the *projection input* (`ConnectionRefreshEvidence`) is actually populated from the manifest for Amazon/Chase at runtime. **Step 6 must verify this; if it's null, Amazon falls through to `complete` and stays green.** This is the single highest-leverage unverified link.
2. **The self-heal confirming run can mask a partial recovery.** `confirming_run_succeeded` is run-level; a run can succeed while one stream stays gapped. Mitigation: terminal/owner-blocked streams keep their own `required_action` even after a green run; the verdict is green only when no non-terminal action remains AND the confirming run succeeded.
3. **No live terminal case to validate the terminal UX against.** The `code_fix`/`terminal` path is designed but unexercised by real data. First real stale-selector failure is the true acceptance test; until then it's covered only by synthetic fixtures.
4. **`emitted_at` ≠ collection time.** Freshness must be anchored on `scheduler_last_run_times` / run evidence (as the projection already does), not on `records.emitted_at`. Any future surface that derives "last updated" from `emitted_at` will mislead (Amazon shows June event dates from a May run).
5. **Worst-wins can over-amber.** A connection with one trivially-stale low-priority stream rolls the whole pill amber. Mitigation: coverage rollup should weight by manifest stream priority (the projection already distinguishes required vs accepted-absence streams); tune so accepted-absence/optional staleness annotates without downgrading the pill.

---

## 10. Honest confidence assessment — is this >95% the ideal?

**The case FOR (why I believe it's ≥95% of the SLVP-ideal):**
- It is **grounded, not asserted.** Every load-bearing claim was re-run against the live DB; two of the source proposals' premises were falsified and replaced, and the replacement (refresh-contract, derived terminality) is *simpler* and matches the existing model.
- It **builds on the proven-honest projection** rather than replacing it. `deriveForwardDisposition` already computes terminality; `CoverageAxis`/`ForwardDisposition`/`ConnectionRefreshEvidence` already carry the needed distinctions. The design is a synthesis layer + one promoted field + a loop — exactly the "add, don't rewrite" the constraint demands.
- The **three live lies become structurally impossible** via typed invariants enforced as a gate, not convention.
- It is **instantly familiar** (Plaid update-mode, Stripe requirements row, GitHub audience rule) AND **respected by an engineer** (single source of truth for terminality; no second flag; pure synthesis).
- The **break→fix→works loop is airtight for the cases that actually exist** (Amazon manual-stale, Chase retryable-frozen) and has a sound, if unexercised, path for terminal.

**The case AGAINST (why it might fall short of 95%):**
- **Risk 1 is a real gap, not a quibble.** If manual-refresh evidence isn't wired to the projection for Amazon/Chase at runtime, the headline fix (step 6) is inert and Amazon stays green. I asserted the manifest values but did NOT trace the runtime input population. That's a single point that could deflate the whole glance-correctness claim — call it 90%, not 95%, until step 6 verifies it.
- **The terminal UX is designed against zero live data.** The most-cited "your action won't help" experience has no live instance; it could be subtly wrong in ways only a real stale-selector failure reveals.
- **Worst-wins tuning (risk 5) is judgment, not proof.** Whether the priority-weighting feels right to a non-technical owner is a live-iteration question this design can't fully settle from prior art.
- **Step 7 (self-heal) is large and the part most likely to harbor edge cases** (re-rejection races, partial-recovery masking) that only burn-in surfaces.

**Verdict: ~92–94% the ideal *as a design*, gated up to ≥95% the moment step 6 verifies refresh-evidence wiring.** The shape is right and earned; the named 6–8% is honest residual: one unverified runtime link (the highest-leverage one), one undemonstrated terminal path, and the usual self-heal edge-case tail. This is the convergent design to build on — not a greenfield, and not the source proposals as written, but their surviving shape re-grounded in what the live system actually is.

---

*Corpus artifact for the connector-health convergence. Supersedes the source proposals' wrong premises (account⇒credential; Chase terminal current_activity); preserves their correct shape (one synthesized verdict, one typed action family, a self-heal loop). Builds on `connection-health.ts` and the reflection of 2026-06-15.*
