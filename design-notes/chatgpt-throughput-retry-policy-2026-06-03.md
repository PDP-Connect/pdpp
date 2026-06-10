# ChatGPT Throughput / Retry Policy (SLVP-ideal)

Status: decided-defer
Owner: RI owner-delegate
Created: 2026-06-03
Updated: 2026-06-03
Related: openspec/changes/add-connector-adaptive-lanes (frozen maxConcurrency=1 gate); tmp/workstreams/ri-chatgpt-429-efficiency-audit-v1-report.md; tmp/workstreams/chatgpt-current-ab-probe-report-2026-06-02.md; tmp/workstreams/chatgpt-current-ab-probe-followup-2026-06-03.md; tmp/workstreams/ri-chatgpt-dataconnect-completeness-audit-v1-report.md; commit 69bc2e11

## Question

Why was PDPP orders of magnitude slower than dataconnect at collecting ChatGPT,
and what is the safest request policy PDPP should adopt to reduce sync time
without burning the account into a rate-limit cooldown — while preserving the
completeness PDPP already delivers?

## Context

### Measured request-shape comparison (both use `page.evaluate(fetch)` in-browser)

| Dimension | dataconnect (`~/.dataconnect/connectors/openai/chatgpt-playwright.js`) | PDPP (`packages/polyfill-connectors/connectors/chatgpt/index.ts`) |
|---|---|---|
| List endpoint | `/backend-api/conversations?offset&limit=100&order=updated` | `/conversations?offset&limit=100&order=updated` (same) |
| Detail endpoint | `/backend-api/conversation/{id}` per conversation | `/conversation/{id}` per conversation (same) |
| Detail concurrency | **5 concurrent** (`BATCH_SIZE=5`, `Promise.all`) | **1 (serial)**, frozen `CONVO_DETAIL_MAX_CONCURRENCY=1` |
| Inter-unit pacing | 200 ms between batches of 5 (≈40 ms/conv amortized) | **1500–3000 ms jitter between every conversation** |
| Backoff / 429 handling | **None.** 30 s abort timeout; on non-200 returns `{success:false}` and moves on | 12-attempt jittered exponential, capped at **15 min/request**, honors `Retry-After` (cap 15 min); bare-429 fast-open at 3 attempts |
| Stop semantics | none (best-effort, drops failures silently) | per-conversation exhaustion opens a defer circuit → resumable `DETAIL_GAP`; **now also a cumulative 429-density stop (this lane)** |

### Why PDPP was slower — three compounding factors, all measured

1. **Pacing dominates, not request count.** Even with *zero* throttling, the
   2026-06-03 cold-state A/B measured serial+jitter at **3.1 s/conversation** vs
   batch-3 at **0.72 s/conversation** (3.6× wall-clock, both 0% 429 on a cold
   account). dataconnect's batch-5+200 ms is ~10–20× faster per conversation
   than PDPP's serial+1.5–3 s jitter. This gap is pure policy, not data volume.
2. **Backoff tail.** dataconnect never waits on a 429 — it abandons the
   conversation. PDPP honors backoff, so a single pressured conversation could
   previously burn ~47–55 min (12 attempts, exponential capped at 15 min). The
   bare-429 fast-open (3 attempts) and the double-wait fix (commit f7970385)
   already cut this; the new density stop closes the remaining "many
   conversations each cost one honored Retry-After" grind.
3. **Account state, not connector shape.** The hot-state probe (2026-06-02)
   measured ~38% bare-429 density on *serial* PDPP; 3–4 h later the same serial
   lane and batch-3 both ran 0% 429. The throttle is per-account, time-varying,
   and returns **bare 429s with no `Retry-After`**. PDPP's March-vs-June gap is
   partly source-bucket trust degradation between the two runs.

### dataconnect's ~40 MB "in minutes" is lossy, not a fair completeness baseline

The 2026-06-02 dataconnect-completeness audit **measured** (not assumed) that
dataconnect is structurally lossy:

- It walks a **single linear path** from root to `current_node` and keeps only
  **2 content types** (`text`, `multimodal_text`) for **2 roles** (user,
  assistant). PDPP captures **12 content types** (tool, system, thoughts, code,
  reasoning_recap, execution_output, …) plus **off-branch regeneration nodes**
  dataconnect's single-path walk cannot reach.
- For the 1,094 overlap conversations already ingested, PDPP held **5.8× more
  messages**; even filtered down to dataconnect's own narrow schema, PDPP had
  **1.21× more** (3,706 nodes are off-branch, structurally unreachable by
  dataconnect). Zero overlap conversations had PDPP under-capturing.
- dataconnect emitted **20 silent-empty conversations** (0.9%) — HTTP-200 with a
  mapping that filtered to nothing, no `error` field. PDPP already holds messages
  for 15 of those 20, and now flags this class explicitly (`empty_detail`
  SKIP_RESULT).

**Conclusion:** dataconnect is fast partly *because* it does less work and drops
failures. PDPP's size and runtime reflect richer, lossless capture plus an
honest backoff. The fair lever is *pacing on a cold account*, not abandoning
completeness.

## Stakes

- Wrong-aggressive (raise concurrency while hot) → escalates the per-account
  throttle on the owner's real ChatGPT account, pushing it into a longer
  cooldown and worsening the very symptom we're fixing.
- Wrong-conservative (keep grinding serially through sustained pressure) → multi-
  hour runs that still finish degraded, with a large low-value retry tail.
- Hiding incompleteness (raise a "done" threshold over deferred details) → the
  dashboard would lie about coverage. Out of bounds for this work.

## Current Leaning (recommended policy)

1. **Initial / default concurrency: stay serial (1/1).** Do NOT raise the frozen
   default. The cold-state batch-3 win is real but is only validated on a cold
   account; shipping it as a default would fire a faster posture into whatever
   state the account is in. Keep the existing owner-only `*_PROBE` env knobs
   (capped at ceiling 5 = dataconnect's batch size) for the A/B, and the
   cold-state preflight that auto-demotes to serial if the account is hot.
2. **429-density stop (shipped, commit 69bc2e11).** Count served 429s across the
   run; once cumulative count ≥ threshold (default **8**, env
   `PDPP_CHATGPT_DETAIL_RATE_LIMIT_STOP_AFTER`, `0`=disable), open the existing
   upstream-pressure circuit and defer the remaining tail as resumable
   `upstream_pressure` `DETAIL_GAP` records. At the measured ~30–50 s/served-429
   that is ~4–7 min of honored backoff before we stop hammering — long enough to
   ride a blip, far short of the multi-hour grind. **Strictly safer: it can only
   make a pressured run defer earlier, never add requests.**
3. **Backoff caps: keep honoring `Retry-After` (cap 15 min); keep bare-429
   fast-open at 3.** Bare 429s are an account-level signal; the density stop now
   bounds how many of them a run will absorb in aggregate, which is the right
   place to cap — not by shortening individual honored server waits.
4. **Defer over in-run retry for the tail.** Once pressure is sustained, deferred
   `DETAIL_GAP` records are the correct unit of progress: the hydrated prefix's
   cursor commits, and the next run (ideally cold) recovers gaps first. This
   preserves correctness/completeness without a cooldown burn.
5. **Borrow from dataconnect only the validated, safe pieces.** Same
   `page.evaluate(fetch)` posture (already shared). The batch concurrency (≤5) is
   borrowable *only* behind the cold-state preflight + owner A/B — never as a
   blind default, and never the "one attempt then silently drop" failure
   handling (that is the lossiness, not the speed).

### Operator UI / status when the policy stops early

The connector already emits a named PROGRESS line; the density stop adds an
explicit count:

> `ChatGPT conversation-detail lane opened upstream-pressure circuit after N
> served 429s; deferring remaining conversation details as DETAIL_GAP records`

Downstream surfacing should read: state `degraded`, reason_code
`upstream_pressure`, coverage `retryable_gap`, plus a deferred-detail count
(number of pending `upstream_pressure` `DETAIL_GAP` records) and a note that the
remaining conversations are resumable on a cooler run. It must NOT present the
run as complete while deferred gaps exist.

## Promotion Trigger

Promote to an OpenSpec change if/when any of:

- The default detail concurrency is raised above 1 (changes the frozen
  `add-connector-adaptive-lanes` constraint; needs cold-state A/B evidence).
- A durable `version_disposition` / coverage-state field is added to express
  "deferred-due-to-pressure" distinctly from other gap reasons on the wire.
- The density-stop default or `DETAIL_GAP` reason contract changes in a way
  reference consumers depend on. (Current change reuses the existing
  `reason: "upstream_pressure"` contract, so no promotion was required.)

## Validation path (what still needs live source traffic — run safely)

The density stop is unit/fixture-proven. The remaining open question — whether a
cold-account batch-3 default is safe — requires a live cold-state A/B that this
lane intentionally did **not** run (account is hot/cancelled; running it is a
stop-and-report trigger). To run it safely later, owner-present, on a confirmed
cold account:

1. Confirm cold: zero pressure events for ≥1–2 h; no pending gaps touched.
2. Treatment run with `PDPP_CHATGPT_DETAIL_MAX_CONCURRENCY_PROBE=3` (ceiling 5);
   the cold-state preflight auto-demotes to serial if the account is hot.
3. Capture: detail-phase wall-clock, 429 events, gap coverage, cursor commits,
   self-demotion proof.
4. Decision: cold + raised posture clean + materially faster + cursor commits +
   no gap spike → promote a concurrency raise behind an OpenSpec brief. Any 429
   under the raised posture, or hot at start → keep serial.

The density stop is orthogonal and safe to keep on regardless of that outcome.

## Decision Log

- 2026-06-03: Shipped the cumulative 429-density early-stop (commit 69bc2e11) as
  a runtime-policy bugfix (reuses existing `upstream_pressure` `DETAIL_GAP`
  contract → no OpenSpec change). Kept default concurrency serial. Deferred the
  cold-state concurrency-raise to an owner-present live A/B. Recorded that
  dataconnect's speed is partly measured lossiness, not a completeness baseline.
