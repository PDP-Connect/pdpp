# Open question: gap-recovery execution — who runs the retries, and what does the connector owe them?

**Status:** open
**Raised:** 2026-04-20
**Trigger:** ChatGPT has 4,188 conversations that 429-skipped during a "successful" run; USAA has 2 unknown-template PDFs and a list of credit-card-export diagnostics from earlier runs; Slack has a handful of slackdump-unsupported-stream skips. All persist in `spine_events` as `run.stream_skipped` events with enough information to identify what was missed. **Nothing reads them back.** Designing how the read-back should work surfaces that "recovery" isn't one mechanism — it's at least four, each with a different owner, and the current protocol conflates all four into the same `SKIP_RESULT` signal.

## Why this is a peer concern to the other two notes

This note completes the triptych:

- `partial-run-semantics-open-question.md` — **production side.** How does a run declare what it couldn't do? (SKIP_RESULT shape, reason taxonomy, DONE histogram.)
- `cursor-finality-and-gap-awareness-open-question.md` — **memory side.** How does STATE remember gaps across runs so they stay retriable? (`known_gaps` promotion, coverage intervals.)
- **This note — execution side.** Who invokes the retry? What shape does the retry take? What contract does the connector owe the retry-invoker?

All three must compose. If only one or two ship, the mechanism is incomplete: declarations without memory evaporate, memory without execution rots, execution without declarations has nothing to drive.

## Skip categories are not a single taxonomy

Looking at actual skips accumulated in this reference implementation, SKIP_RESULT events fall into **four distinct categories with different retry owners**:

### Category 1 — Transient upstream failure
Rate limits (HTTP 429), server errors (HTTP 5xx), network timeouts, credential expiry recoverable by refresh.

- ChatGPT: 4,188 × `http_error: conversation {id} http 429`
- Slack: `eng_github` channel's Slack 500 errors (now mitigated by raising slackdump retry budget 3 → 20)
- Gmail: would hit this if IMAP disconnects mid-fetch

**Retriable:** yes, no code change required. Just needs time + re-invocation.
**Owner of the retry decision:** scheduler / orchestrator. Connector doesn't know when to wait.

### Category 2 — Connector capability gap
Connector reached data but couldn't extract it with current code.

- USAA: 2 × `pdf_template_unknown` (statement PDF era the parser doesn't recognize)
- USAA (historical): `credit_card_export_unverified` (CC export UI not wired — fixed 2026-04-20)
- Hypothetical: a new Gmail header format the parser doesn't handle

**Retriable:** only after a connector version with fixed extraction ships. Same inputs + same code = same skip.
**Owner of the retry decision:** release process. A new connector version should flag "re-run gaps whose `connector_version_required` ≤ this version."

### Category 3 — Upstream structural gap
Data the connector has declared it can't retrieve via the chosen mechanism.

- Slack: `stars`, `user_groups`, `reminders` — slackdump archive mode doesn't call the APIs that populate them
- Gmail: `drafts` (not yet modeled)
- USAA: any stream the manifest declares but the scraper can't currently surface

**Retriable:** no — this is a permanent gap for the lifetime of the current mechanism. Retrying won't produce anything.
**Owner of the declaration:** manifest, not runtime. These shouldn't be SKIP_RESULTs at all; they should be manifest-level "declared but not populated by this connector version" markers so dashboards know to render them differently from transient gaps.

### Category 4 — Scope-filter miss
The connector fetched a record but dropped it because it didn't match `START.scope.streams[].resources`.

Today's emitRecord implementations (`if (resSet && !resSet.has(id)) return;`) silently drop without emitting SKIP_RESULT — which is correct. Mentioned here for completeness because an early version of the recovery mechanism might accidentally surface these as retriable.

**Retriable:** not a failure at all. This category shouldn't produce SKIP_RESULT events.

## The real problem: today SKIP_RESULT conflates all four

Every SKIP_RESULT in `spine_events.run.stream_skipped` today looks like:

```json
{
  "source": { "connector_id": "..." },
  "stream": "conversations",
  "reason": "http_error",
  "message": "conversation 69d71fbf-... http 429"
}
```

No machine-readable distinction between Category 1 (retry soon), Category 2 (retry after code change), Category 3 (never retry, declare upstream), Category 4 (not-a-skip). A naive "retry everything in spine_events" recovery pass would hammer Category 2 and 3 gaps forever.

**Without the four-way distinction, recovery mechanisms have to embed connector-specific knowledge of each skip's nature** ("ChatGPT 429s are transient, USAA pdf_template_unknown is capability, Slack user_groups is structural"), which defeats the point of a protocol-level mechanism.

## What the spec could require

### Option A — Four-valued `recovery_kind` on every SKIP_RESULT
Mandate `recovery_kind: "retry_by_runtime" | "retry_on_connector_upgrade" | "permanent_structural" | "filter_applied"`. The runtime's retry logic becomes connector-agnostic:
- Retry `retry_by_runtime` after `retry_after` hint.
- Retry `retry_on_connector_upgrade` when connector version ≥ `connector_version_required`.
- Drop `permanent_structural` into manifest declarations, not runtime events.
- Never emit `filter_applied` at all.

**Pro:** connector-owned classification; runtime stays generic. **Con:** new taxonomy; connectors must classify correctly (which pushes the spec surface into connector code review).

### Option B — Runtime-owned retry policy by reason code
Centralize the retry decisions in the runtime: "reasons matching `http_(429|5xx)` are retried by runtime with exponential backoff; reasons matching `template_unknown|parser_version_*` are deferred until connector upgrade; reasons matching `not_supported_in_*` are silently ignored."

**Pro:** single policy point; connectors don't need to classify. **Con:** runtime has to maintain a growing table of reason-code → policy mappings; new connector reasons require runtime updates.

### Option C — Two-phase: connector declares retriability; scheduler decides timing
Connector emits `retriable: true/false` + `retry_preconditions: { after: "2026-04-21T10:00Z", requires_connector_version: null }`. Scheduler (or `orchestrate run --recover`) queries gaps, filters by preconditions met, invokes.

**Pro:** minimal change to connector; scheduler does policy. **Con:** doesn't solve Category 3 (structural gaps) — they need a different mechanism (manifest).

### Option D — Manifest absorbs Category 3; SKIP_RESULT covers 1 & 2 only
Each stream in the manifest declares `supported_resources` (what it CAN fetch) vs just advertising its schema. Structural gaps never emit SKIP_RESULT; they're just absent. Runtime SKIP_RESULT mechanism handles only transient + capability.

**Pro:** right separation — structural gaps are a design claim, not a runtime event. **Con:** requires manifest evolution; existing structural-gap SKIP_RESULTs (Slack's stars/user_groups/reminders) need migration.

### Option E — Don't build runtime retry; publish spine_events and let operators write scripts
Keep SKIP_RESULT as informational. Ship a query helper (`pdpp-connectors gaps <connector>`) that dumps spine_events in machine-readable form. Operators can write one-off scripts (like the ChatGPT catch-up script we sketched) per connector as needed. Document the pattern in CONNECTORS.md.

**Pro:** zero protocol change; implementation freedom. **Con:** workarounds proliferate; "pristine data" remains a per-operator project instead of a protocol property.

## Recovery execution contract (what any chosen option needs to answer)

Whatever mechanism lands, there are concrete questions that must be pinned down:

1. **Resource ID precision.** Does `scope.resource_ids` name individual records (ChatGPT conversation_id) or coarse batches (USAA account_id + date range)? Both exist; the contract has to support both.
2. **Pre-filter vs post-filter.** If a recovery run passes `scope.streams[].resources = [ids]`, does the connector fetch only those IDs, or fetch everything and drop non-matches? For 4,188 ChatGPT IDs out of 14k, the difference is one re-hit of the rate limit vs three. Connector MUST support pre-filter for recovery to be economically viable — but that's a connector capability, not all connectors can do it (USAA can't fetch individual transactions by ID).
3. **State isolation.** Does a recovery run update the main cursor? If yes, it conflates normal progress with gap-closing. If no, `known_gaps` needs its own cursor state. This interacts with the cursor-finality note's decision.
4. **Partial recovery.** If a recovery run succeeds on 3,000 of 4,188 ChatGPT gaps and fails on 1,188, what happens? `known_gaps` shrinks to 1,188 (partial credit) or stays at 4,188 (atomic)? Intuitively partial, but needs to be specified.
5. **Cost-bounded recovery.** A recovery run retrying 4,188 items at 2/sec is 35 minutes. A recovery run retrying 500,000 items at the same rate is 70 hours. Does the contract include a per-run budget? If so, whose — connector's declaration, scheduler's config, or START parameter?

## Manifest impact

Connectors that want to participate in runtime recovery must advertise capability. Minimum manifest additions:

```json
{
  "recovery": {
    "supports_targeted_resource_fetch": true,    // can pre-filter on scope.resources
    "supports_version_bumped_retry": true,       // re-reads past gaps on new version
    "targeted_fetch_rate_hint": "2/sec"          // for scheduler cost-bounding
  }
}
```

A connector lacking these capabilities is opt-out — its SKIP_RESULTs are informational only, the runtime doesn't try to retry them.

## Cross-cutting

- `partial-run-semantics-open-question.md` — the SKIP_RESULT shape is defined there; this note's four categories need the Option C taxonomy expansion there to carry `recovery_kind`.
- `cursor-finality-and-gap-awareness-open-question.md` — `known_gaps` is the durable substrate this note's execution mechanism operates on. If cursor-finality goes with Option B (three-field cursor) or D (compose with partial-run), this note's execution has a natural home. If cursor-finality lands differently, this note's execution layer has to synthesize its own substrate from spine_events.
- `connector-configuration-open-question.md` — manifest additions for recovery capability are a specific case of the broader configuration surface.
- `owner-self-export-open-question.md` — "here's what we know we don't have, here's when we'll try again" is the execution layer's contribution to the self-export completeness claim.
- `chatgpt.md` — concrete locus of 4,188 Category 1 gaps awaiting recovery.
- `usaa.md` — concrete locus of Category 2 (PDF template) gaps awaiting parser upgrade.

## Action items

- [ ] Decide A/B/C/D/E, or a combination, in conjunction with partial-run-semantics and cursor-finality. These three form a single mechanism — decide them together or not at all.
- [ ] For whichever option: specify resource-ID precision rules (individual vs batch), pre-filter contract (MUST or SHOULD), partial-recovery semantics.
- [ ] Enumerate Category 3 skips currently in the codebase (Slack stars/user_groups/reminders, any USAA "can't be scraped" streams) and migrate to manifest declarations under whichever manifest-evolution option lands.
- [ ] Audit all existing SKIP_RESULT emission sites for which category they belong to; the classification is the spec-writing work even if the taxonomy isn't formalized yet.

## What we are explicitly not doing in the reference implementation

- Not building a runtime retry loop until the mechanism is decided in spec. Implementing retry now would prejudice the decision and make Options A/B/C/D/E each harder to adopt.
- Not writing per-connector one-off recovery scripts for the ChatGPT 4,188 case. The one-shot script would become a workaround that's hard to remove once it exists. The data in `spine_events` is durable; recovery can happen once the mechanism is specified.
- Not extending SKIP_RESULT's schema in code. Today's loose `reason + message` shape is documented as the baseline; any schema evolution is part of the spec change, not a unilateral runtime update.

## Why "just run retry scripts" isn't good enough

Each category needs a different trigger (time-based, version-based, never), a different invocation (connector subset of IDs, full re-run, not-at-all), and a different success criterion (all IDs ingested, specific versioned stream re-walked, permanent absence acknowledged). A protocol that claims to keep owner data "pristine" has to make these distinctions structurally, not leave them to ad-hoc scripts that rot between runs and differ per connector. The execution mechanism is where that structural clarity lives — or doesn't.
