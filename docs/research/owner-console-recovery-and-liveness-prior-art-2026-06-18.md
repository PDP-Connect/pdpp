# Owner Console — Recovery and Liveness Prior Art (Lens 5)

**Date:** 2026-06-18
**Owner:** Claude (owner-console SLVP prior-art corpus)
**Status:** Research / design only — no product code, no deploy, no live-stack ops
**Why this note exists (and what existing doc it extends):** This is Lens 5 of the owner-console redesign corpus. It covers *recovery and liveness as an owner-facing experience* — what the console shows while a run is in flight, how it closes the loop after a recovery action, and how the device-local collector's recovery is reflected in the web console. It **extends** `docs/research/slvp-ideal-stuck-run-liveness-2026-06-14.md` (which solved the *server-side* "hung run wedges single-flight" correctness problem with watchdog + reaper + run-generation fencing) by asking the next question that doc explicitly does not: **once the runtime is correct, what does the owner see, and how do they know it is fixed?** It also leans on `trace-surface-patterns.md` and `control-plane-prior-art.md` for run/trace detail conventions, and on `slvp-ideal-scheduled-human-help-2026-06-12.md` for the "bounded owner help" framing of assisted refreshes. **Crucially, it does NOT define its own connection-state vocabulary: connection `tone`/`label` and the orthogonal `channel` (interrupt) axis are owned by `docs/research/slvp-connector-health-FINAL-design-2026-06-15.md` (the `RenderedVerdict` contract), and this lens expresses every recovery/liveness signal in that doc's terms — adding only `Verifying` and `No data yet` as `grey/Checking` refinements, never a competing flat state set (see §4.1).** Where stuck-run-liveness ends at "emit `run.failed run_timed_out` and clear the slot," this note picks up at "show the owner a terminal status they can trust, and a re-run affordance with parity across CLI and web."

This lens anchors hard to the owner's recovery complaints (short proof phrases): CLI recovery gives a command then **"just a blinking cursor; no progress indicator or feedback about what's happening or how long it will take"**; after recovery, health still **"checking"**, coverage **"unknown"**, **"no known source runs"**; **"Uploading 62 of 1,000 local rows"** with no expectation set; **"one cause / one action"** vs **"three things wrong"** priority confusion; **wall-of-text status copy** ("Suppressed evidence. Drain detail gap backlog").

---

## 1. Prior-art sources

Each source was fetched and indexed on **2026-06-18** (retrieval date) via context-mode; URL + the specific observed pattern below.

1. **Sentry — Issue States and Triage.** https://docs.sentry.io/product/issues/states-triage/ (retrieved 2026-06-18). One status at a time per issue; the lifecycle is an explicit state machine — `New → Ongoing → Escalating`, `Resolved`, `Archived`, and crucially `Regressed` ("a resolved issue that's come up again"). The docs ship a *diagram of how statuses update automatically vs manually*. Resolving an issue is a deliberate "I believe this is fixed" assertion that Sentry will *automatically reverse* (`Regressed`) if a matching event recurs. This is the canonical "close the loop and verify it stayed fixed" pattern.

2. **Sentry — Issues / Triage tabs.** https://docs.sentry.io/product/issues/ (retrieved 2026-06-18). Tabs are saved filtered lists: `All Unresolved (is:unresolved)`, `For Review (is:unresolved is:for_review)`, `Regressed (is:regressed)`, `Archived`, `Escalating`. The "For Review" list is the subset that *needs a human decision* — directly relevant to the owner's "1 needs review with no way to see which one."

3. **Sentry — Issue Details (sidebar / activity).** https://docs.sentry.io/product/issues/issue-details/ (retrieved 2026-06-18). The detail page shows first-seen / last-seen, first/last release, and an **activity section that is a chronological lifetime of the issue** — assignments, regressions, escalations, comments. Recovery is logged as events on the entity's own timeline, not as ephemeral toast.

4. **Linear — Issue status / Configuring workflows.** https://linear.app/docs/configuring-workflows (retrieved 2026-06-18). Statuses are grouped into fixed **categories** that define ordering and semantics: `Backlog → Unstarted → Started → Completed / Canceled`, plus reserved `Triage` and `Duplicate`. Teams may add custom statuses *within* a category but cannot reorder categories. The category is the stable, color-coded meaning; the label is the customizable detail. This is the answer to "no indication of what yellow and green mean": color maps to a *named category*, not to a vibe.

5. **Temporal — Events and Event History.** https://docs.temporal.io/workflow-execution/event (retrieved 2026-06-18). The service tracks progress by **appending Events to an append-only, ordered Event History** (e.g. `WorkflowExecutionStarted`, `ActivityTaskScheduled/Started/Completed`). This history "enables developers to know what took place" *and* powers durable recovery from a crash. The history is the single source of truth for "what happened and where are we now," and supports `Reset` to a prior point. Long-running progress = an inspectable, monotonic event log, not a spinner.

6. **Trigger.dev — Runs and attempts.** https://trigger.dev/docs/runs (retrieved 2026-06-18). A *run* is one instance of a task; it carries a unique run ID, current status, payload, output, metadata. The lifecycle is an explicit state diagram (Pending → executing → final). Final states are distinct (completed / failed / canceled). Recovery affordances are first-class SDK/console verbs: `runs.replay()` (re-run), `runs.cancel()`, `runs.reschedule()`. Re-run creates a *new* run rather than mutating the old one.

7. **Trigger.dev — Realtime.** https://trigger.dev/docs/realtime (retrieved 2026-06-18). "Realtime is the umbrella for everything live" — subscribing to a run's state changes as they happen (`subscribeToRun` / React `useRealtimeRun`). The console reflects the run *as it progresses*, pushed, not polled. This is the model for "show progress while it runs."

8. **Trigger.dev — Run usage (cost & duration).** https://trigger.dev/docs/run-usage (retrieved 2026-06-18). A run exposes its **duration and cost**; the platform records how long the run actually took. Terminal records carry "how long it took," which is the data needed to set expectations on the *next* run ("typically ~2 min").

9. **GitHub Actions — Using workflow run logs.** https://docs.github.com/en/actions/monitoring-and-troubleshooting-workflows/monitoring-workflows/using-workflow-run-logs (retrieved 2026-06-18). "You can see whether a workflow run is in progress or complete from the workflow run page." If complete, the page shows whether the result was **success, failure, canceled, or neutral**; if failed you can search the build logs to diagnose and **re-run**. Backed by the Checks API: a check suite per run, a check run per job, steps within. In-progress vs terminal *conclusion* are different fields.

10. **GitHub Actions — Re-running workflows and jobs.** https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/re-running-workflows-and-jobs (retrieved 2026-06-18). UI offers **"Re-run failed jobs"** vs **"Re-run all jobs"** as distinct buttons; re-run is available up to 30 days; optional "Enable debug logging." The exact same operation has a CLI form: `gh run rerun [<run-id>] --failed` (the CLI manual at https://cli.github.com/manual/gh_run_rerun, retrieved 2026-06-18, shows the run-id as an optional positional argument). This is the gold standard for **CLI ⇄ UI parity for the same operation**. (Note: the documented *interactive run selection* — being prompted to choose a run when none is supplied — is for `gh run watch` per https://cli.github.com/manual/gh_run_watch, retrieved 2026-06-18, whose example is `gh run watch` with no run-id; `gh run rerun`'s docs do not document a prompt.)

11. **GitHub Actions — Visualization graph.** https://docs.github.com/en/actions/monitoring-and-troubleshooting-workflows/monitoring-workflows/using-the-visualization-graph (retrieved 2026-06-18). "Every workflow run generates a **real-time graph** that illustrates the run progress." Live topology + per-node status while running.

12. **Stripe — Payment status updates (verifying status).** https://docs.stripe.com/payments/payment-intents/verifying-status (retrieved 2026-06-18). A PaymentIntent has an explicit status the client retrieves and branches on (`succeeded`, `requires_action`, `requires_payment_method`, `processing`). Stripe **explicitly recommends webhooks over polling** for async status changes ("polling … is much less reliable and might cause rate limiting") — the truth is *pushed* on `payment_intent.succeeded` / `payment_intent.payment_failed`. `requires_action` is a named state meaning "the human must do something next."

13. **Stripe — Identity Verification Sessions.** https://docs.stripe.com/identity/verification-sessions (retrieved 2026-06-18). Status machine: `requires_input` → `processing` → `verified`, plus `canceled`/`redacted`. **An event is emitted every time the session changes status** (`identity.verification_session.processing/verified/requires_input/canceled`). `requires_input` = "checks completed and at least one failed" — a precise, actionable terminal-ish state that tells the human exactly that *they* are the next actor, distinct from a system failure.

14. **Datadog — Configure Monitors (thresholds, recovery, auto-resolve).** https://docs.datadoghq.com/monitors/configuration/ (retrieved 2026-06-18). Monitors have alert + warning thresholds and **optional separate recovery thresholds** ("an additional condition for alert recovery"). Auto-resolve note: "you only want an alert to resolve after it is actually fixed … leave this as `[Never]` so alerts only resolve when the metric is above or below the set threshold," and a monitor that auto-resolves but is still bad **re-triggers at the next evaluation**. The principle: *recovery is a measured condition, not a timer*, and a healthy state must be earned by fresh evidence.

15. **Datadog — Monitor status page.** https://docs.datadoghq.com/monitors/status/ (retrieved 2026-06-18). The status page confirms `OK` as a named state and a **Transitions** graph that shows status changes over time, so "when did it recover" is answerable. It also documents that *resolving* a monitor from the header "temporarily changes the monitor status to `OK` until its next evaluation," after which "the next evaluation proceeds as normal based on current data" — i.e. a manual resolve is re-checked against fresh data, not frozen. The full named-state enumeration `No Data` / `Evaluate as zero` / `Show OK` / `Show last known status` lives on the **Configure Monitors** page (source 14, https://docs.datadoghq.com/monitors/configuration/, "Advanced alert conditions → No data," retrieved 2026-06-18), where `Show NO DATA` is offered as an explicit option distinct from the alert/warning path: "we have no signal" is a configurable, first-class outcome separate from "we have a bad signal." (`Skipped`/`Unknown` are observed product behavior in Datadog's status taxonomy, not enumerated on either fetched page.)

(Additional citation-precision fetches on 2026-06-18: the GitHub CLI manual pages `gh_run_rerun` and `gh_run_watch` — https://cli.github.com/manual/gh_run_rerun and https://cli.github.com/manual/gh_run_watch — to verify the run-id is an *optional positional* on `rerun` and that the interactive run-selection example belongs to `watch`; and the Datadog Configure Monitors page https://docs.datadoghq.com/monitors/configuration/ "Advanced alert conditions → No data" to source the `Show NO DATA` / `Evaluate as zero` / `Show OK` enumeration that is NOT on the status page.)

(Failed fetches, logged in `failures`: Linear `issue-states`/`cycles` slugs 404'd — superseded by `configuring-workflows`; one Sentry `notifications-workflow` slug 404'd; a transient host ConnectionRefused on first Datadog/Trigger attempts, all re-fetched successfully.)

---

## 2. Observed patterns (cross-source synthesis)

**P1 — A run/issue is an addressable entity with a status field that is a closed set of named states.** Every system models this as a finite state machine, not free text: Trigger.dev runs (pending/executing/final), GitHub Actions (in-progress vs conclusion: success/failure/canceled/neutral), Stripe (succeeded/processing/requires_action/...), Datadog (OK/Alert/Warn/No Data), Sentry (New/Ongoing/Resolved/Regressed/Archived), Linear (Backlog/Started/Completed/Canceled categories). The owner never reads prose to learn the state.

**P2 — Color is bound to a *named category*, not a freestanding hue.** Linear's categories are the meaning; the color and custom label hang off the category. Datadog's `OK`/`Alert`/`Warn` are words first. Nobody ships "green/yellow" without an adjacent legend word.

**P3 — "Needs a human" is its own state, separate from "failed" and from "running."** Stripe `requires_action` / Identity `requires_input`; Sentry "For Review"; Datadog `Warn` vs `Alert`. The system distinguishes *the machine is stuck* from *you are the next actor* from *we have no data*.

**P4 — Closing the loop is an explicit, reversible assertion, and "is it actually fixed?" is verified by fresh evidence.** Sentry: resolving = "I think this is fixed," auto-reversed to `Regressed` on recurrence. Datadog: recovery is a *measured* threshold crossing, not a timer; a premature auto-resolve re-triggers on the next evaluation. The system does not let you mark something healthy and then keep showing stale green — health must be re-earned by new data.

**P5 — Long-running work is shown as live, pushed progress over an append-only event log, with terminal duration recorded.** Temporal's append-only Event History; GitHub's real-time visualization graph + streaming logs; Trigger.dev Realtime subscriptions; Trigger.dev run duration/cost on the terminal record. Progress is "event N of the history" or "step 3 of 5 streaming," and the finished record says how long it took — which seeds the *next* expectation.

**P6 — Push beats poll for status truth.** Stripe explicitly: webhooks over polling. Trigger.dev: subscribe to run changes. GitHub: real-time graph. The owner UI should not make the human refresh to discover a state change.

**P7 — The same recovery operation has matched CLI and UI forms.** GitHub: "Re-run failed jobs" button ≡ `gh run rerun [<run-id>] --failed` (run-id optional positional); the *interactive run selection when no run-id is given* is GitHub's `gh run watch` affordance, not `rerun`. Trigger.dev: console action ≡ `runs.replay(runId)`. The verb, the noun (run ID), and the result are identical across surfaces.

**P8 — Re-running creates a new attempt/run linked to the prior one; it does not silently mutate the failed record.** Trigger.dev runs vs attempts; GitHub re-run creates a new run you can still see the prior one from. History is preserved; the loop is auditable.

**P9 — `No Data` is a legitimate, *named*, *configurable* outcome — but it is shown as "we have no signal yet," never as a default that masquerades as a verdict.** Datadog's "No data" advanced alert condition (configuration page, source 14) makes `Show NO DATA` an explicit option distinct from `Evaluate as zero` and `Show OK`; the operator deliberately chooses how missing data renders rather than letting it silently read as green or as alarm. It is honest about the absence of evidence rather than defaulting either way.

---

## 3. PDPP implications (tie to specific surfaces and the owner's complaints)

**3.1 The post-recovery "checking / unknown / no known source runs" trap is a P4 + P9 failure.** The owner's pain: after a recovery, health is still "checking," coverage "unknown," "no known source runs." Three different surfaces are each defaulting to an absence-state and presenting it as the verdict, with no path forward and no expectation. Per Datadog `No Data` (P9) and Sentry's verify-on-recurrence (P4): the honest model is that recovery is **not** complete until *fresh evidence* arrives — but the console must say exactly that and show the pending verification, not three flavors of "unknown." After the owner runs a recovery, the connection card should enter a named, time-bounded **`Verifying`** signal (FINAL `tone:grey / label:Checking`, `channel:calm` — "we kicked off a run; confirming it took"; the §4.1 addition) — analogous to Stripe `processing` and Datadog "recovery must be measured" — and *transition itself* to `Healthy` (`tone:green`) when a successful run lands, or to a `channel:"attention"` interrupt on the appropriate failure tone if it fails. "No known source runs" must never be the resting display immediately after the owner was told a run started; that is a closed-loop break.

**3.2 The CLI "blinking cursor" is a P5 + P6 + P7 failure on the local-collector.** The owner runs the recovery command the console hands him and gets "just a blinking cursor; no progress indicator or feedback about what's happening or how long it will take." Every prior-art system shows live progress over a structured event stream (Temporal history, GitHub graph, Trigger.dev Realtime). The local-collector CLI must emit a **structured, append-only progress stream** (P1/P5): phase lines (`Authenticating… → Fetching pages 1–N → Normalizing → Uploading rows`), counts with a known denominator, and a one-line "this usually takes ~Xm" seeded from the last run's recorded duration (Trigger.dev run-usage, P5). And per P6/P7, that same recovery is one operation with two faces: the CLI command the console suggests and a console button must be the *same* verb on the *same* connection, and the **web console must reflect the local run's progress live** (see §6).

**3.3 "Uploading 62 of 1,000 local rows" with no expectation set is a half-built P5.** The denominator exists (1,000) but no rate, no ETA, no "what happens at 1,000." Trigger.dev records duration; GitHub streams steps. The fix: pair the counter with a derived rate/ETA and a terminal commitment ("when this reaches 1,000 the run will finish and this source goes Healthy"). A progress bar without a stated terminal outcome is the same "vibe-coded" smell the owner flags.

**3.4 "One Thing Needs You" vs "three things wrong" is a P1 + P3 channel-counting failure.** This is the same defect as "1 needs review with no way to see which one." Per Sentry "For Review" (a filtered list you can open) and P3 (needs-human is its own dimension): the hero count must be a **clickable filter into the exact entities**, and the count must be of one well-defined class. In the FINAL doc's terms that class is the **`channel:"attention"`** set (owner is the sole resolution), NOT a tone. If the hero says "One Thing Needs You" it must mean exactly one connection with `channel:"attention"` — *not* a blend that hides two `channel:"advisory"` (system will retry; owner is an optional accelerant) items under a friendlier headline. This is exactly the tone⟂channel split the FINAL doc §3.2 makes: a red-tone source the system is handling is *not* a "needs you," and an amber-tone source that only the owner can re-auth *is*. Distinguish, as Stripe/Datadog do, by the *next actor*: `channel:attention` (Stripe `requires_action`), `channel:advisory` (retryable / you may accelerate), `Verifying` (Stripe `processing`; the §4.1 calm addition), `No data yet` (No Data; advisory cold-start).

**3.5 "Can't tell if I'm looking at a source or a connection" + "can't see run/sink detail from the summary" is a P1/P8 addressability gap.** Prior art treats a *run* as an addressable entity with its own detail page and lifetime timeline (Sentry activity log, GitHub run page, Trigger.dev run record). PDPP needs the run to be a first-class, linkable object: from any source/connection summary, the latest run is a link to a **run detail** page carrying the append-only event timeline (started, fetched, normalized, uploaded N, succeeded/failed at duration D) — exactly the trace-surface this corpus already designs, but reachable in one click from the summary, with the re-run affordance on it.

**3.6 Wall-of-text status ("Suppressed evidence. Drain detail gap backlog.") violates P1/P2.** Status should resolve to a named category word + color (Linear/Datadog), with the prose demoted to an expandable "why." The owner reads the FINAL `label` (e.g. `Degraded`, amber) plus, when `channel:"attention"`, the single owner action first; the diagnostic sentence is secondary detail, not the headline.

**3.7 "Collected" confusing (no change vs new records) is a P5 terminal-summary gap.** Trigger.dev's terminal record carries concrete output/duration. A finished PDPP run summary must state **new records vs unchanged** explicitly ("Run succeeded in 1m48s — 0 new records, 1,183 unchanged") so "Collected" is never ambiguous.

---

## 4. Concrete affordance / copy / IA recommendations

> **Canonical vocabulary — DO NOT fork it.** Connection *state* labels and colors in this corpus are already pinned by `docs/research/slvp-connector-health-FINAL-design-2026-06-15.md` §3 (the `RenderedVerdict` contract). That doc is the single source of truth for: the **`pill.tone`** axis (`green`/`amber`/`red`/`grey`) and its bijective **`pill.label`** (`Healthy`/`Degraded`/`Can't collect`/`Checking`), AND a **second, orthogonal** **`channel`** axis (`calm`/`advisory`/`attention`) that decides *whether to interrupt the owner*. That doc explicitly **corrected a prior design that conflated** "collection health" with "do I need to act," and split them into `tone` ⟂ `channel`. **This recovery/liveness lens does not introduce a competing flat state set; it slots the recovery-specific signals into that existing two-axis machine.** Everything below is expressed in the FINAL doc's terms.

**4.1 Recovery/liveness signals expressed in the FINAL tone⟂channel machine (no new state set).** The earlier draft of this lens invented a flat single-field set (`Healthy/Verifying/Needs you/Failed/No data yet/Scheduled-idle`); that is rejected here because folding "needs you" into the *state* field re-introduces exactly the tone↔interrupt conflation the FINAL doc rejected. Instead:

- **`Needs you` is NOT a state — it is `channel: "attention"`** on top of whatever `tone`/`label` the collection health warrants (FINAL §3.2, §5 S1: the attention channel requires an owner-self-satisfiable `required_action`). A revoked-credential source is `tone:amber / label:Degraded / channel:attention`. A timed-out system run with an automatic retry pending is `tone:amber / label:Degraded / channel:advisory` — same label, different interrupt. This keeps "one cause / one action" honest: the hero counts `channel:"attention"`, not a hand-rolled "needs you" state (see §4.2).
- **`Failed` (system error) is NOT a new tone** — it is the existing `tone:red / label:"Can't collect"` (or `amber / Degraded` when retryable), with the *run* record carrying the failure. The recovery affordance is driven by `channel` (advisory if the system will retry, attention if only the owner can fix it), exactly as the FINAL §4.4 policy table already specifies for `degraded`/`needs_attention`.

**`Verifying` and `No data yet` are the only genuinely-NEW signals this lens adds — proposed as ADDITIONS to the FINAL doc's set, both mapping cleanly onto its existing axes** (they are recovery-arc refinements of `grey/Checking`, which the FINAL doc already owns):

| New signal (proposed addition to FINAL §3) | Maps to existing FINAL axes | Why it is an addition, not a fork | Owner's next move |
|---|---|---|---|
| **`Verifying`** — a run was just kicked off (e.g. by a recovery) and we are confirming it lands | `tone: grey`, `label: "Checking"` (a *named refinement* of Checking meaning "checking-because-we-just-acted"), `channel: calm` | The FINAL doc already uses `grey/Checking` for "evidence unreliable / unknown" and already has a `syncing`→calm annotation (§4.4 row `healthy + syncing`); `Verifying` is the post-recovery flavor of that same in-flight calm. It is the Stripe `processing` / Datadog resolve→re-evaluate analog. It does **not** add a colour or an interrupt. | wait; watch live progress |
| **`No data yet`** — connected but no successful run has ever landed | `tone: grey`, `label: "Checking"`, `channel: advisory` (owner can kick the first run) | The cold-start case the FINAL doc's live audit didn't have a row for (all live sources had history). Reuses `grey/Checking` honestly ("no signal yet," P9) and rides `advisory` because the owner *can* act (run now) but nothing is broken. | run now |

So the closed label set on the dashboard remains the FINAL four — **`Healthy` / `Degraded` / `Can't collect` / `Checking`** — with `Checking` (grey) carrying the recovery sub-meanings (`Verifying`, `No data yet`) as the neutral freshness/activity annotation the FINAL §5 S2 already permits on a calm/advisory row, never as a fifth tone. The recovery-specific work is all in the **`channel`** axis (does this interrupt?) and in the **run record** (what happened, when, how long), not in a parallel state enum. Color always sits next to the word (FINAL invariant 7 / Linear-category pattern); never a bare dot. This directly answers "no indication of what yellow and green mean" while honoring the one-vocabulary rule.

<!-- superseded draft kept for traceability:
**4.1 (REJECTED draft) A single flat named connection-state vocabulary (closed set), color bound to the word.** Mirror Linear categories + Datadog states:

| State (label shown) | Color | Meaning | Owner's next move |
|---|---|---|---|
| `Healthy` | green | last run succeeded, data fresh within staleness budget | none |
| `Verifying` | blue | a run is in flight or just kicked off; confirming it took | wait; watch live progress |
| `Needs you` | amber | requires owner action (auth/OTP/credential) — system can't proceed alone | do the named action |
| `Failed` | red | system error in last run | re-run, or open detail |
| `No data yet` | gray | connected but never produced a successful run | run now |
| `Scheduled / idle` | gray-green | assisted source awaiting its next scheduled refresh (extends scheduled-human-help doc) | none |

Color must always sit next to the word; never ship a bare dot. This directly answers "no indication of what yellow and green mean."
-->

**4.2 Hero "Needs You" card = a filter over `channel:"attention"`, not a number, not a new state.** The hero counts exactly the set of connections whose `RenderedVerdict.channel === "attention"` (FINAL §5 S1 guarantees each such connection carries an owner-self-satisfiable action — so the count can never include something the owner cannot fix). The number is a link that opens the filtered list of those exact connections (Sentry "For Review" pattern). Connections that are merely `channel:"advisory"` (retryable/self-healing, owner is an optional accelerant) appear on a *separate* secondary line ("2 sources you can help — review"), and `tone:red` items the system is already handling (e.g. a maintainer `code_fix`) render as status, not a button (FINAL §4.4). "One cause / one action" and "three things wrong" never blur because the hero is bound to the single `attention` channel, not to a blend of tones or a hand-rolled "needs you" state. Never aggregate distinct channels under one friendly headline.

**4.3 Run as a first-class, linkable entity with a detail page.** A *run* status is a separate axis from a *connection*'s FINAL `tone`/`label` (a connection rolls up the evidence of its runs; the FINAL doc's `detail` carries run-level facts). Each run has an ID and a run-status from the Trigger.dev/GitHub run lifecycle (`queued / running / succeeded / failed / canceled / timed_out`) — NOT a connection `label` — plus a start time, a **recorded duration**, and an append-only **event timeline** (Temporal/GitHub model). From every source/connection summary, "Last run: succeeded 1m48s ago →" links to it. On the run detail page: the timeline, the new-vs-unchanged record counts, and the re-run button.

**4.4 CLI ⇄ console parity for recovery (the GitHub `gh run rerun` model).** When the console surfaces a recovery, it shows **both** faces of one operation: a "Run now" / "Re-run" button *and* the exact CLI command. Both target the same connection ID and produce the same new run. The console must not hand the owner a command and then be unable to show the result of running it.

**4.5 Local-collector CLI: structured live progress, never a bare cursor.** The recovery command must stream named phases with counts and an ETA seeded from last duration. Target shape:

```
$ pdpp collect chatgpt --recover
→ Connecting to ChatGPT…           ok (1.2s)
→ Fetching conversations           page 7/7   (1,183 found)
→ Normalizing records              1,183/1,183
→ Uploading to console             [██████░░░░] 620/1,183  ~40s left
✓ Run succeeded in 2m11s — 312 new records, 871 unchanged
  Console: this source is now Healthy → https://…/sources/chatgpt
```

Required elements: a phase label per line; counts with a known denominator; a derived ETA (rate × remaining) once enough samples exist; a **terminal summary line** with duration + new/unchanged counts; and a closing pointer back to the console state. No phase may sit silent — emit a heartbeat line at least every few seconds so the cursor is never "just blinking."

**4.6 "Uploading 62 of 1,000": always pair count + ETA + terminal commitment.** Replace bare `62 of 1,000` with `Uploading 62/1,000 (~2m left) — at 1,000 this source goes Healthy`. The denominator, the time, and the outcome together.

**4.7 Post-recovery: the console transitions itself; "unknown" is time-bounded.** After a recovery is initiated, the connection enters `Verifying` (FINAL `grey/Checking`, `channel:calm`), shows the live run, and **auto-transitions** to `Healthy` (`tone:green`) on success or, on failure, to the appropriate failure tone with `channel:"attention"` (only the owner can fix) or `channel:"advisory"` (system will retry). "No known source runs" / "coverage unknown" must not be the resting display after the owner was just told a run started — if no run is observed within a bounded window, show `Can't collect — recovery didn't start` with a re-run (`channel:"attention"`), not a silent "unknown."

**4.8 Recovery is verified by fresh evidence, and is reversible (Sentry Regressed / Datadog recovery-threshold).** A source goes `Healthy` (`tone:green`) only when a *successful run with fresh data* lands — not on the owner clicking a button (and per the Datadog status-page note in source 15, even a manual resolve is re-checked at the next evaluation, never frozen). If a connection that read `Healthy` later produces a failing run or goes stale past its budget, its tone degrades and — if only the owner can fix it — its `channel` rises to `attention` on its own (the PDPP analog of Sentry `Regressed`). Health is re-earned, never asserted-and-frozen.

**4.9 Terminal status copy: word first, prose second.** The FINAL `label` (e.g. `Degraded`, amber) as the headline plus the single owner action when `channel:"attention"`; "Suppressed evidence; drain detail-gap backlog" demoted into an expandable "Why?" (the FINAL §4.3 inspection layer / `detail`). Plain-language rewrite of the diagnostic, one sentence, with the owner action as a button.

---

## 5. Anti-patterns to avoid

- **A1 — Spinner / blinking cursor as the only liveness signal.** No phase, no count, no ETA. (the owner's exact CLI complaint; violated P5.) A long operation with no structured progress is a defect, not a style choice.
- **A2 — Resting "unknown / checking / no known runs" after an action the owner just took.** Absence-of-data is a *transient, named, time-bounded* state, never the verdict surface post-recovery (violates P4/P9).
- **A3 — Health asserted by a button click and then frozen.** Marking Healthy without a fresh successful run, and never reverting on later failure, is the opposite of Sentry-Regressed / Datadog recovery-threshold (violates P4).
- **A4 — One friendly headline that aggregates distinct channels.** "One Thing Needs You" hiding two system failures conflates `channel:"attention"` (P3; only-owner-can-fix) with `channel:"advisory"` / system-handled failures. Count one channel (`attention`); link to the exact entities. (Equivalently: never re-fold the interrupt signal back into a flat "needs you" *state* — that is the precise tone↔channel conflation the connector-health FINAL doc rejected.)
- **A5 — Bare color with no adjacent word.** Green/yellow dots with no legend (the owner's "no indication of what yellow and green mean"; violates P2).
- **A6 — A recovery command the console can't follow up on.** Handing a CLI command with no console reflection of its progress or result breaks CLI⇄UI parity (P6/P7).
- **A7 — A run that isn't an addressable entity.** Status only visible inline on a summary, no run detail page, no timeline, no link — owner can't answer "what happened in that run" (violates P1/P8; the owner's "can't see run/sink detail from the summary").
- **A8 — Progress bar with a denominator but no terminal commitment.** "62 of 1,000" with no ETA and no statement of what 1,000 means.
- **A9 — Polling-only status that requires the owner to refresh to learn a state change** (violates P6).
- **A10 — Wall-of-text status as the headline** (violates P1/P2; the owner's "Suppressed evidence…").

---

## 6. Closing the loop for a device-local recovery (what the WEB console must reflect)

This is the crux of the assignment: a recovery that physically runs on the owner's device via the local-collector CLI, but whose *truth must appear in the web console*. The append-only-event-history model (Temporal, P5) plus push-not-poll (Stripe/Trigger.dev, P6) plus the named state machine (P1/P3) define the loop:

1. **Initiate (parity).** The console's recovery affordance shows both the "Run now" button and the exact CLI command (`pdpp collect <source> --recover`) for the same connection ID (P7).
2. **CLI streams structured progress locally** (§4.5) — phases, counts, ETA, never a bare cursor.
3. **CLI emits run events to the console as it goes**, so the console connection card moves to `Verifying` (FINAL `grey/Checking`, `channel:calm`) and shows live phase/count/ETA mirrored from the device (Temporal append-only history + Trigger.dev Realtime subscribe; P5/P6). If the device cannot reach the console mid-run, the console shows `Verifying — waiting for the local run to report` rather than "unknown."
4. **Terminal reconciliation.** When the local run finishes, both surfaces converge on the *same* terminal record: a run with an ID, recorded **duration**, and **new-vs-unchanged record counts** (P5/P8; fixes "Collected" ambiguity). The CLI prints the terminal summary; the console run detail page shows the identical timeline.
5. **State transition is earned, not asserted** (P4). The connection becomes `Healthy` (`tone:green`) only because a successful local run delivered fresh data — and its tone degrades / its `channel` rises to `attention` later if a subsequent run fails or staleness exceeds budget (Sentry-Regressed analog). "No known source runs" is impossible immediately after this loop, because the run that just completed is now the latest addressable run.
6. **The owner can re-run from either surface** (GitHub re-run / Trigger.dev replay; P7/P8), and the re-run is a *new linked run*, preserving the prior run's record.

The single sentence: **A device-local recovery closes the loop when the same run becomes an addressable, terminal record visible identically in CLI and web, the web connection's FINAL verdict auto-transitions to an earned `Healthy`/`tone:green` (or degrades its tone and raises `channel:"attention"` when only the owner can fix it) on the basis of that run's fresh evidence, and at no point between "command issued" and "state earned" does any surface rest on a bare cursor or an "unknown."**

---

## 7. Acceptance checks (owner-walkable, testable)

1. **No bare-cursor recovery.** Run the console-suggested recovery command for a real source; within 3 seconds the CLI prints a named phase line, and thereafter never goes >5s without a progress/heartbeat line. It ends with a terminal summary line containing a duration and `N new / M unchanged`. (Fails the owner's "blinking cursor" complaint if absent.)
2. **Progress has count + ETA + terminal commitment.** During upload, the CLI (and the console card) show `X/Y` with a derived "~Zs left" and a stated terminal outcome. No `X of Y` appears without all three.
3. **Console reflects the local run live.** While the CLI run is in flight, the web connection card reads `Verifying` (FINAL `grey/Checking`, `channel:calm`, word + color) and shows mirrored phase/count without a manual refresh.
4. **Loop closes to an earned state, never to "unknown."** Within the bounded window after a successful local recovery run completes, the web card reads `Healthy` (`tone:green`) and the source's latest run is a clickable run-detail link. At no point after the command is issued does the card rest on a resting "checking," "unknown," or "no known source runs."
5. **Run is addressable.** From the source summary, "Last run …" links to a run detail page showing an append-only event timeline, recorded duration, and `new vs unchanged` counts, with a re-run button.
6. **CLI⇄UI parity.** The console's "Run now" button and the displayed CLI command target the same connection and produce runs that appear in the same run list; re-running from either creates a new run linked to (not overwriting) the prior one.
7. **State vocabulary is closed, worded, and matches the FINAL doc.** Every connection `label` on the console is one of the FINAL four (`Healthy`/`Degraded`/`Can't collect`/`Checking`) with its bound `tone` color always adjacent to the word; the interrupt signal is the orthogonal `channel` (`calm`/`advisory`/`attention`), never a fifth state. The §4.1 recovery additions (`Verifying`, `No data yet`) render as `grey/Checking` annotations, not new tones. No bare dot, no wall-of-text headline; searching the rendered owner pages finds no headline equal to a multi-sentence diagnostic string, and no connection label outside the FINAL set.
8. **Hero count is a precise filter over `channel:"attention"`.** The "Needs You" hero counts exactly the `channel:"attention"` set; clicking it lists those exact connections; `channel:"advisory"` (system-handled / accelerable) items appear on a separate line and are not folded into the friendly headline. The hero never counts a tone.
9. **Health is re-earned (regression).** Mark a source `Healthy` via a successful run, then force its next run to fail (or let it exceed staleness): the card's tone degrades and `channel` rises to `attention` (when only the owner can fix it) on its own without the owner re-checking — proving health is evidence-bound, not asserted-and-frozen.
10. **Push, not poll.** With the console open and idle (no manual refresh), a state change produced by a CLI run appears in the console within the realtime/subscription window.
