# Open question: partial-run semantics — what does it mean for a run to "succeed" when not every record made it?

Status: sprint-needed
Owner: project owner
Created: 2026-04-20
Updated: 2026-04-24
Related: `openspec/changes/add-polyfill-connector-system/design-notes/cursor-finality-and-gap-awareness-open-question.md`, `openspec/changes/add-polyfill-connector-system/design-notes/gap-recovery-execution-open-question.md`, `pdpp-trust-model-framing.md`

**Status:** open
**Raised:** 2026-04-20
**Trigger:** A single session surfaced five independent variants of the same shape: "the connector produced some records but not all, and there is no protocol-level way to express that." Each variant forced a workaround. Listing them together makes the pattern legible.
**Framing:** Decisions in this note look different depending on whether the primary consumer of partial-run signals is the owner's own agent or a third-party client. See `pdpp-trust-model-framing.md`.

## Five concrete cases

### Case A — Gmail BigInt crash mid-stream (2026-04-20T00:53)
Connector emitted 50,396 records. Runtime flushed 49,509. The 887 in buffer were lost when `JSON.stringify` threw on a BigInt `highest_modseq` value in the final STATE message. Spine event:

```
records_emitted: 50396
records_flushed: 49509
buffered_records_dropped: 887
state_streams_staged: 1
state_streams_committed: 0
checkpoint_commit_status: not_committed
reason: connector_protocol_violation
```

Outcome: `run.failed`. Next run starts from scratch. 49,509 committed records are still in the RS, but the spine records the run as a total failure. An analyst looking at the audit log has no idea that 49,509 records of this run are actually good.

### Case B — claude-code 413 PayloadTooLargeError on state (2026-04-20T00:13)
Connector emitted 350,563 records; runtime flushed all 350,563. 3 of 4 STATE cursors committed. The fourth (`messages.file_mtimes`) exceeded Express' default 100kb body-parser limit (cursor is ~50kb of file paths + float mtimes).

```
records_flushed: 350563
state_streams_staged: 4
state_streams_committed: 3
checkpoint_commit_status: partially_committed
reason: runtime_error
error_message: 413 PayloadTooLargeError
```

Outcome: `run.failed`. Next run re-processes the `messages` stream from scratch despite 227,249 messages already in the RS and identical in content. A quarter-billion wasted reads if this becomes a loop.

### Case C — Slack slackdump channel-level error (2026-04-20T05:09)
slackdump ran for 5+ hours, dumped 24 GB to disk (574,274 messages, 3,240 channels, 1,460 users), then hit Slack's 500 Internal Server Error on channel `C017NG64T24` after exhausting retries. Exit 6. PDPP connector fails out.

Outcome: `run.failed` with 0 records emitted. The entire 24 GB on-disk SQLite archive is real, parseable, and never reaches PDPP. Had to add `PDPP_SLACK_SKIP_SLACKDUMP=1` as an env-var escape hatch to tell the connector "skip the refresh attempt, just ingest what's on disk." That's a workaround masquerading as a feature — there's no principled framework handle for it.

### Case D — USAA CSV date-range retry ladder
CSV export UI hard-caps at ~17 months. If the initial date range fails, the connector walks a retry ladder (5y → 2y → 1y → 90d) accepting progressively less data. If the 90d range works but the 5y doesn't, we silently ship the 90d slice. The "succeeded" run's emission covers materially less than the manifest promised.

Outcome: `run.completed, succeeded`. The shortfall is invisible to downstream consumers who are relying on the manifest's claim. A SKIP_RESULT exists in the emit stream but is only surfaced if the export dialog *never* cooperated — not if the range was shortened.

### Case E — ChatGPT 4,188 conversations 429-skipped
Backend API rate-limited. 4,188 individual conversation-fetch calls returned 429. The connector recorded SKIP_RESULT for each and moved on. Run completed successfully with 10,596 records, but 4,188 conversations are simply missing and will stay missing until manual intervention.

Outcome: `run.completed, succeeded`. Dashboard consumers see "chatgpt: ok" and have no idea 28% of conversations (4,188 / (4,188 + 10,596)) are gone.

## What these cases have in common

Every one of them produced **useful data** and **lost some** and **has nowhere in the protocol to express that honestly.** The existing `run.completed / run.failed` binary forces each case into a lie:

- Case A: says `failed`, but 49,509 real records landed and are queryable now.
- Case B: says `failed`, but 350,563 records landed; state for 3/4 streams did commit.
- Case C: says `failed` with 0 records, but 574k messages sit on disk ready to ingest.
- Cases D, E: say `succeeded`, but material coverage is missing.

The RS is consistent (records are durable, committed with unique keys). The *narrative* about the run — what a dashboard or auditor or owner self-export is supposed to render — is dishonest. And because the narrative is dishonest, downstream tools don't know when to retry, when to alert, when to surface "missing data" to the owner.

## Adjacent notes

This note is one of three that together describe how partial-data honesty should work across the protocol. **The three MUST be decided together** — each alone is incomplete:

- This note — **production side:** how does a run *declare* what it couldn't do?
- `cursor-finality-and-gap-awareness-open-question.md` — **memory side:** how does STATE *remember* gaps across runs?
- `gap-recovery-execution-open-question.md` — **execution side:** who *retries* the gaps, with what contract?

Other adjacent notes:

- `layer-2-completeness-open-question.md` — "manifest claims X streams; what does completeness mean?" This is the **temporal slice** of that question: completeness within a single run, over time.
- `raw-provenance-capture-open-question.md` — raw capture lets us re-extract later; partial-run semantics tells us *which records need re-extraction*.
- `usaa-historical-coverage-gap.md` — the specific Case D instance, already documented.
- `blob-hydration-open-question.md` — sibling problem for per-record hydration (record present, attachment missing).

## What the spec could require

### Option A — Introduce `run.partially_completed` status
Third explicit value. Run carries `records_emitted`, `records_flushed`, `records_missing_estimate`, `state_streams_committed / state_streams_staged`, and a list of `skip_result_summary` counts by reason. Dashboards treat `partially_completed` like a first-class state with its own color/treatment.

- Pro: honest, matches reality of all five cases above.
- Con: taxonomy explosion — how is a dashboard supposed to show this? What does "green check" mean?

### Option B — Separate record-level durability from run-level status
Explicitly: "records flushed to RS are durable regardless of run status." Add a spine field `records_durable: true` even on `run.failed`. Dashboards query RS for what's there, spine for what was attempted.

- Pro: matches what's already true of the RS; small spec change.
- Con: doesn't help the "silent partial" cases (D, E) where the run says succeeded.

### Option C — Promote SKIP_RESULT to a first-class observability signal
Every SKIP_RESULT must name (a) a `reason` taxonomy entry and (b) a `scope` (which records would have been emitted if this hadn't happened). The run's DONE carries a histogram: `skipped_by_reason: {rate_limit_429: 4188, credit_card_export_unverified: 2, pdf_template_unknown: 2}`. Dashboards can render "chatgpt: 10,596 records, 4,188 skipped (rate limit)".

- Pro: makes silent partial-completeness loud. Orthogonal to run-level status.
- Con: requires every connector to agree on reason taxonomy.

### Option D — Explicit retry/resume contract
A connector can end a run with `status: needs_retry` + a `retry_hint` describing what to retry. Scheduler/orchestrator picks this up and re-queues. For Case C, the hint is "retry after 10 minutes excluding C017NG64T24". For Case E, "retry after 24h for the 4,188 conversations in this skip list."

- Pro: turns the binary into a graph — runs can chain into completion.
- Con: needs orchestrator changes; who is responsible for honoring retry hints when the orchestrator is "cron" or "the user"?

### Option E — Do nothing; document workarounds
Keep binary run status. Require connectors to document their own partial-data behavior and env-var escape hatches.

- Pro: zero spec change.
- Con: workarounds proliferate (`PDPP_SLACK_SKIP_SLACKDUMP` style), no cross-connector consistency, silent data loss remains undetectable.

## Trade-offs to weigh

- **Downstream complexity** — a `partially_completed` state forces every consumer to think about partial. Some consumers want binary.
- **Audit rigor** — regulators / Linux Foundation review will ask "how do you know a run didn't drop data on the floor?" A protocol-level answer is worth more than per-connector answers.
- **Retry economics** — some retries are free (idempotent APIs), some cost money (rate-limited APIs with tight 429 budgets). A retry_hint mechanism needs cost-awareness.
- **Owner clarity in self-export** — an owner self-exporting their data wants to know "am I missing anything?" The current protocol can't answer that question at all.

## Action items

- [ ] Decide A–E. Several of the options compose (B + C, B + D, C + D) and the decision is about which combination, not which single option.
- [ ] If B: add `records_durable_in_rs` field to `run.failed` spine events; document that RS contents are authoritative, spine status is about the *attempt*.
- [ ] If C: define skip-reason taxonomy (start with the five cases above); mandate histogram in DONE.
- [ ] If D: define `retry_hint` schema + scheduler contract.
- [ ] Revisit all five design notes that document existing per-connector workarounds — they become "examples" under the unified semantics rather than standalone gaps.

## Why this is a spec-level question, not a connector bug

Each of the five cases can be "fixed" at the connector level by making it not fail (retry forever, swallow errors, etc.). But that fix makes partial-data *less* visible, not more. A protocol that cares about owner agency and audit integrity needs to make partial-data explicit. The question is what shape that explicitness takes — not whether to have it.
