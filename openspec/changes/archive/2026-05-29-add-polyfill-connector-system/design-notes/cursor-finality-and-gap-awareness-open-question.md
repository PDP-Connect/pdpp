# Open question: cursor finality & gap-awareness — what does a connector mean when it says "I have up to X"?

Status: sprint-needed
Owner: project owner
Created: 2026-04-20
Updated: 2026-04-24
Related: `openspec/changes/add-polyfill-connector-system/design-notes/partial-run-semantics-open-question.md`, `openspec/changes/add-polyfill-connector-system/design-notes/gap-recovery-execution-open-question.md`, `pdpp-trust-model-framing.md`

**Status:** open
**Raised:** 2026-04-20
**Framing:** Cursor semantics look different when the cursor is for the owner's own agent vs. a third-party client auditing completeness. See `pdpp-trust-model-framing.md`.
**Trigger:** Designing a PDPP-side delta mechanism for Slack (so the connector can say "just pull me anything newer than what's in my RS") surfaced a deeper question: **what finality does a cursor actually claim?** The implicit model — `MAX(sent_at) per channel` means "I have everything ≤ that timestamp" — is true for some connectors and silently false for others. Building incremental-fetch on top of an uncalibrated cursor produces invisible data loss.

## Two failure modes of naive cursors

### Failure A — Gaps *within* the cursor range

We have records from 2015-01-15 through 2026-04-17 on a stream. A naive cursor says "I have 2015-01-15 to 2026-04-17." But the stream has specific gaps from past partial runs:
- ChatGPT: 4,188 conversations 429-skipped on a "succeeded" run — holes scattered through the date range
- USAA CSV: retry ladder shortened a date range when the 5y attempt timed out, emitted the 90d slice silently — the 4y→90d window has no records we didn't already have, but we don't *know* we don't have them
- Slack: the dump stopped at channel `eng_github` with retry exhaustion; other channels in the same session have `MAX(sent_at)` numbers that look healthy, even though 372 channels are in `V_UNFINISHED_CHANNELS`

A delta-fetch built on `MAX(sent_at)` never re-asks for these holes. They stay invisible forever.

### Failure B — Expansion of the authoritative range

Upstream reveals older data than we previously had access to:
- GitHub: a private repo is made public — old issues retroactively become queryable
- Slack: a thread on a 2021 parent message gets a new reply in 2026 — slackdump handles this via `-lookback p7d` re-walking active threads, but a PDPP-side `MAX(sent_at)` cursor doesn't
- USAA: a new statement PDF for 2019 appears in Documents & Records because the UI cap changed
- IMAP: `UIDVALIDITY` changes (rare, but the protocol says re-fetch everything)

A delta-fetch built on `MAX(ts) > cursor` misses all of these. The records are newly visible to us, but their *intrinsic* timestamps fall before our cursor, so we skip them.

## Why this is a spec-level question

Every connector today uses some form of cursor in `STATE`, but the cursors' semantic meaning is not spec'd:
- What does `{"last_date": "2024-11-25"}` *claim*? That I have everything before that date? Only the latest date I've seen? A watermark I can safely resume from?
- Is a cursor a **high-water mark** ("anything after this is new") or a **completeness certificate** ("everything up to this is fully ingested")?

Without that distinction, consumers (dashboards, self-export, downstream analyses) can't answer the basic question: **"am I looking at complete data or a sample?"**

### The meta-question: whose call is this?

The Collection Profile gives connectors an opaque `STATE.cursor: {...}` field and hands it back on the next START. The shape, granularity, and semantics of what goes in that blob are entirely the connector author's decision today — five judgment calls per connector (granularity, shape, mutable-data policy, forward compatibility, failure semantics), with no spec vocabulary to coordinate across connectors.

Result: every connector in the polyfill suite chooses differently, and the differences aren't principled — they're artifacts of what seemed reasonable to the author at the time. YNAB gets `server_knowledge` for free because its upstream API dictates it. Gmail inherits IMAP's `UIDVALIDITY + HIGHESTMODSEQ`. Claude-code uses `file_mtimes` because it's reading a filesystem. ChatGPT, USAA, and Amazon use wallclock timestamps because nothing forced them to do anything smarter. Slack uses nothing at all (full re-emit every run, RS dedup saves correctness at the cost of ingest efficiency).

This is the question the note is trying to surface: **is cursor shape a connector-author concern forever, or does the spec eventually publish a taxonomy and vocabulary connectors must adopt?** The options below are answers to that meta-question as much as to the narrow "what shape should a cursor be" question.

## Which connectors have real finality and which don't

| Connector | Cursor type | Gap-free within range? | Expansion-aware? |
|---|---|---|---|
| **YNAB** | server_knowledge (monotonic) | ✅ server-authoritative | ✅ server returns all changes since cursor |
| **Gmail (IMAP)** | UIDVALIDITY + UIDNEXT + HIGHESTMODSEQ | ✅ by protocol (CONDSTORE) | ✅ UIDVALIDITY break forces re-fetch |
| **File-import (claude-code, codex, takeout)** | per-file mtimes | ✅ by filesystem semantics | ✅ new files detected |
| **GitHub (issues, PRs)** | updated_at of newest | ⚠ no — skipped items on 422/403 become invisible | ⚠ no — visibility changes retroactive |
| **ChatGPT** | last_update_time per conversation | 🚫 4,188 429-skips are silent holes | 🚫 no mechanism for rate-limited retries |
| **Slack (slackdump)** | archive session + V_UNFINISHED_CHANNELS | ⚠ only if slackdump.sqlite intact | ⚠ `-lookback p7d` is a coarse heuristic for thread replies |
| **USAA CSV** | per-account last_date | 🚫 shortened-range retries are silent | 🚫 no mechanism to discover older data |
| **Amazon** | per-year state | 🚫 UI 90-day cap hides older data | 🚫 no |

The first three rows are the model. Rows 4-8 ship a `STATE` cursor that *looks* like the first three but doesn't mean the same thing.

## What the spec could require

### Option A — Tiered cursor semantics (typed by connector)
Manifest declares `cursor_semantic: "complete" | "high_water" | "session_local"`.
- `complete`: every record with ts ≤ cursor IS in the RS. Dashboards can show "you have everything through X."
- `high_water`: records newer than cursor haven't been ingested; older-than-cursor coverage is unspecified.
- `session_local`: cursor is meaningful only to the connector's own resume logic (e.g., slackdump's archive state); consumers shouldn't interpret it.

**Pro:** forces explicit declaration. **Con:** requires enumerating the taxonomy; `high_water` fits many connectors' actual behavior but is harder for consumers to work with than `complete`.

### Option B — Three-field cursor: `max_seen + coverage_intervals + known_gaps`
Replace the single cursor field with a triplet:
- `max_seen`: the high-water mark (what's commonly called "cursor" today).
- `coverage_intervals`: list of `[from, to]` windows the connector has actually observed records in. Not always contiguous.
- `known_gaps`: list of `[from, to]` (or resource-scoped) windows where the connector expected data but hit SKIP_RESULT / partial-run failure.

The delta-fetch builder then asks upstream for: `(newer than max_seen) UNION (anything inside known_gaps)`.

**Pro:** honest, composable, solves Failure A. **Con:** more state surface; `coverage_intervals` grows without bound without compaction.

### Option C — Separate mutable-window from cursor
Manifest declares `mutable_window: "p7d"` for streams where data can change after initial ingest (Slack thread replies, GitHub issue updates, file revisions). Delta-fetch always re-walks the mutable window regardless of cursor.

**Pro:** solves Failure B's thread-reply case cleanly. **Con:** per-connector tuning; a "p7d" window on YNAB is wasteful, on Slack threads it's essential.

### Option D — Cursor composability with partial-run-semantics
This note's `known_gaps` IS what `partial-run-semantics-open-question.md`'s Option C (first-class SKIP_RESULT histogram) produces. The two notes describe complementary halves of the same honesty mechanism:
- `partial-run-semantics` says: declare what you couldn't fetch during the run.
- `cursor-finality` says: remember what you couldn't fetch, across runs, and re-try it.

Option D is "adopt both together" — SKIP_RESULT entries with scope promoted to `known_gaps` in STATE, automatically.

### Option E — Do nothing
Each connector has its own cursor convention; consumers are on their own. This is the status quo and it's what produces silently-incomplete dashboards.

## Trade-offs to weigh

- **State size** — `coverage_intervals` on a 10-year Slack workspace could have thousands of fragments. Need compaction: merge adjacent/overlapping intervals on emit.
- **Owner self-export completeness claim** — an owner self-exporting wants to know "is this every tweet I ever sent?" The answer requires knowing coverage AND gaps, not just max_seen.
- **Scheduler cost** — re-walking known_gaps on every run could retry 429-rate-limited endpoints indefinitely. Needs a backoff (exponential retry-after, or TTL on gaps).
- **Dashboard UX** — `complete` is easy to render, `high_water` needs a "you may be missing data" badge, `session_local` needs to hide the cursor entirely.
- **Spec prior art** — ActivityPub/AT Protocol use opaque cursor strings. SQL CDC uses (LSN, oldest_uncommitted). Neither matches the gap-awareness need here.

## Interaction with existing notes

This note is one of three that together describe how partial-data honesty should work across the protocol. **The three MUST be decided together**:

- `partial-run-semantics-open-question.md` — **production side:** how runs *declare* partial outcomes. SKIP_RESULT is the *production* of known_gaps; this note is the *consumption* side.
- This note — **memory side:** how STATE persists gaps so they're retriable.
- `gap-recovery-execution-open-question.md` — **execution side:** who retries gaps, what contract the connector owes the retrier, how to distinguish the four SKIP_RESULT categories (transient / capability gap / structural / filter).

Other adjacent notes:

- `layer-2-completeness-open-question.md` — "is this stream complete?" is the static manifest claim; cursor-finality is the *temporal* companion ("am I complete *as of now*?").
- `raw-provenance-capture-open-question.md` — when a gap is re-ingested later, raw capture lets us re-derive records without re-hitting upstream. Makes gap-closing cheap.
- `usaa-historical-coverage-gap.md` — concrete instance of Failure B: USAA retains 7 years but CSV UI shows 17 months. The `MAX(date)` cursor can't tell the owner what they're missing.
- `owner-self-export-open-question.md` — self-export is where cursor-finality matters most. "Here is everything you have" vs. "here is everything we know we don't have" are both first-class answers the protocol should support.

## Action items

- [ ] Decide A/B/C/D/E with owner self-export as the primary use case — this is where "trust me bro" cursors break down hardest
- [ ] If B: define `coverage_intervals` compaction rules + bound on state size
- [ ] If B + D: design the SKIP_RESULT → known_gaps promotion rule (scope must be machine-readable enough to re-query)
- [ ] If C: catalog each connector's natural mutable window (Slack threads, GitHub issue updates, etc.) and document in manifests
- [ ] Audit the 30 connectors' current cursor semantics against the table above — which ones *claim* completeness they don't have?

## Why "just use MAX(sent_at) and trust it" is not the answer

Because it isn't actually incremental — it's *pretend* incremental. The records past the cursor get fetched; the holes inside the cursor never do. After years of delta-runs, the dataset converges on "approximately-complete, with invisible gaps that compound as the connector drifts from the upstream API." That's worse than a connector that says "I can't do delta, re-run me fully" because at least the full-refresh connector is honest about its failure mode.

A protocol that promises owner agency over *their* data cannot ship invisible gaps as a feature.
