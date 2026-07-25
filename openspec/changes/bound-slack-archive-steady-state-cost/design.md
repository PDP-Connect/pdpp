# Design

## Context

Investigation base SHA `a85873732`. Two claims from the task brief were
verified against source before designing:

1. **The connector never ingests attachment bytes.** `buildFileRecord`
   (`connectors/slack/parsers.ts`) and the `files`/`message_attachments`
   streams emit metadata + Slack URLs only; `manifests/slack.json`'s `files`
   stream has no `blob_ref`; no call to `reference-implementation/operations/
   rs-blobs-upload/` exists in the connector. `grep` for `__uploads`,
   `readFile`, `base64`, `/v1/blobs` in `connectors/slack/*.ts` → zero hits.
   `SLACK_SKIP_FILES` defaults `true` (`index.ts` `readSlackOptions`) →
   slackdump gets `-files=false` (`buildArchiveArgs`). PDPP holds no Slack
   attachment bytes.

2. **The run-time growth is a re-scan, not a disk walk.** `buildMessageRowsQuery`
   builds `WITH latest AS (SELECT CHANNEL_ID, TS, MAX(CHUNK_ID) FROM MESSAGE
   GROUP BY CHANNEL_ID, TS)` and only then joins + filters `TS > threshold`.
   The slackdump schema has no `(CHANNEL_ID, TS)` index, so the CTE is a full
   scan+aggregate of all 574k rows every run. The five fingerprinted streams
   (`channels`, `users`, `files`, `channel_memberships`, `workspace`) plus
   `canvases` re-read + re-parse + re-hash their whole (much smaller) tables
   every run, but the `MESSAGE` CTE is the dominant term because `MESSAGE` is
   the table that grows unbounded. `__uploads/` is never touched by connector
   code.

slackdump upstream (rusq/slackdump, verified at tag `v4.4.2`): resume reads
`V_LATEST_MESSAGE`/`V_LATEST_THREAD`/`SESSION` from `slackdump.sqlite` and does
not depend on `__uploads/` existing; file re-download dedup is DB-only
(`GetByIDAndSize`), so a `FILE` row suppresses re-download even when the byte
file is gone; there is no native prune/compact/rotate/VACUUM for legitimate
data.

## Decisions

### D1 — Fix run time by making the message dedup incremental (predicate pushdown)

Move the committed-cursor threshold **into** the `latest` CTE:

```sql
WITH latest AS (
  SELECT CHANNEL_ID, TS, MAX(CHUNK_ID) AS mx
  FROM MESSAGE m
  [LEFT JOIN thresholds t ON t.channel_id = m.CHANNEL_ID]
  WHERE <same threshold predicate as today's outer WHERE>
  GROUP BY CHANNEL_ID, TS
)
SELECT ... FROM MESSAGE m JOIN latest ON ...
```

Today the identical predicate lives in the outer `WHERE`; the aggregation runs
first over everything, then the filter discards. Pushing it down means SQLite
aggregates only the rows that can survive the filter.

**Behavior preservation (the gate).** Output RECORDs are identical:

- A `(CHANNEL_ID, TS)` pair that the current query emits satisfies `TS >
  threshold`. Every `MESSAGE` row with that exact `(CHANNEL_ID, TS)` shares the
  same `TS`, so it also satisfies `TS > threshold` and survives the pushed-down
  filter — the `MAX(CHUNK_ID)` over the surviving rows equals the
  `MAX(CHUNK_ID)` over all rows for that pair. Same winning chunk, same `DATA`.
- A pair with `TS <= threshold` is discarded by both queries (the current one
  in the outer `WHERE`, the new one in the CTE) — never emitted either way.
- The three threshold shapes are all preserved verbatim: per-channel
  `thresholds` CTE + `TS > t.last_ts`; per-channel + legacy fallback
  (`TS > COALESCE(t.last_ts, legacyLastTs)`); legacy-only (`TS > legacyLastTs`);
  and the no-cursor first run (no predicate → full aggregation, unchanged).

This is a query rewrite that preserves the emitted set exactly; it is not a
semantic change. It is proven by a deterministic fixture test that runs the
old and new query shapes over the same seeded archive and asserts identical
emitted rows, plus a mutation test that a new message past the cursor is
emitted and an old one is not (see tasks).

Rejected sub-alternative — **add a `(CHANNEL_ID, TS)` index**: we do not own
slackdump's schema and must open the archive read-only (resume integrity;
concurrent slackdump writers). Creating an index in someone else's DB from a
read-only consumer is unsafe and would fight slackdump's migrations. Predicate
pushdown gets the win with zero schema change.

### D2 — Phase timing + size observability via `progress`

Bracket the existing phases in `collect()` and report deltas through the
`progress` channel already threaded everywhere:

- slackdump subprocess (`ensureArchiveOnDisk`),
- sqlite open (`new DatabaseSync`),
- per-stream read+emit (inside `runRequestedStreams`),
- total collect.

Plus a size snapshot: `slackdump.sqlite` bytes (`statSync`, already imported)
and `__uploads/` presence + byte size (bounded: a single directory-size probe
guarded behind a cheap existence check, not a per-run walk of the whole tree —
it runs once at end of collect, and only when the dir exists). This makes the
"scales with new data, not archive size" invariant a measured number, which is
required to confirm the D1 fix live and to keep future regressions visible.

### D3 — `__uploads/` reclaim is opt-in, commit-gated, loudly lossy

The archive residue is real (29 GB) and reclaiming it is legitimate, but only
under explicit operator intent because it is unrecoverable and disables
re-download. Design:

- New `SLACK_RECLAIM_UPLOADS` option, default `false`.
- When `true`: after the connector's records are durably accepted — gated on
  the same runtime-EOF ack the connector already waits for before exit
  (`connector-exit.ts` `flushAndExitAfterRuntimeAck`), i.e. the reclaim runs
  only once the host has consumed `DONE` and closed stdin — remove the
  workspace's `__uploads/` directory and report reclaimed bytes.
- Never touches `slackdump.sqlite`, `-wal`, `-shm`, or any table (resume state
  untouched).
- Documented as one-way: PDPP has no copy; slackdump will not re-download
  (`FILE`-row dedup); `url_private` needs live auth and rots.

Steady-state: with `SLACK_SKIP_FILES=true` (default) `__uploads/` never
regrows, so a single opt-in reclaim bounds disk to the SQLite going forward. We
do **not** make reclaim automatic even under `SKIP_FILES=true`, because an
operator may have intentionally set `SKIP_FILES=false` to retain bytes locally,
and a connector must not silently destroy operator data.

### D4 — Live-closure follow-up: reclaim must cover every archive read, and
`scoped-archive-reconcile` must state an actual finite bound, not just elapsed
time (2026-07-25)

Live UAT surfaced two gaps D2/D3 did not cover, closed here without expanding
D1–D3's scope.

**D4.1 — Reclaim coverage.** `reconcileMessageSourceCache` (source-cache
healing for a channel that disappeared from the main archive but was
previously observed) can create/read a *scoped* archive
(`archive-scoped/<digest>/`) distinct from the base archive D3 already
covered — including a repair attempt that succeeds (the archive genuinely
exists on disk, `__uploads/` and all) but recovers zero matching channels. The
reclaim plan must include every archive path this run actually created or
read, not only the base archive and not only archives that turned out to
contain a useful channel. `repairMissingScopedArchive` now reports its
archive path unconditionally on success, independent of whether it recovered
a channel; the reclaim plan is the deduplicated union of the base archive,
every scoped archive folded into the message pass, and every repair archive
path touched this run.

**D4.2 — What "bounded" actually means for `scoped-archive-reconcile`.**
Wrapping the phase in a wall-clock timer (D2's `timedPhase`) makes its
*duration* visible but is not itself a bound — it says nothing about how much
work the phase *could* do. The real bound was already present in the existing
design, just not stated or observable:

- The set of channels this run will try to heal
  (`baseMissingChannelIds` = `priorObservedChannelIds` minus this run's own
  `baseChannelIds`) is computed once, up front, from two already-fixed inputs
  — a committed STATE array and this run's own archive scan. It cannot grow
  mid-run; there is no re-query of Slack for "more missing channels" within a
  single `collect()` call.
- `selectScopedArchivesForChannels` greedily covers that fixed set with
  existing scoped archives (one `resume` per selected archive, iterated
  exactly once, no re-selection). Whatever channels remain uncovered trigger
  **at most one** additional repair attempt (`repairMissingScopedArchive`),
  never a loop.
- So the number of Slack-API-touching subprocess calls this phase can make —
  the "repair-unit count" — is knowable and finite *before any subprocess
  runs*, from data already in memory.
- Each unit's own Slack-side scope is independently bounded by
  `SLACK_LOOKBACK_DAYS` (`-lookback p<N>d`, default `p7d`, already existing
  before this closure) — slackdump's `resume` will not walk further back than
  that window per channel.

The fix is making this existing, already-finite structure legible: report the
repair-unit count and the lookback window before any subprocess starts, a
completed/remaining cursor as each unit finishes, and an explicit
`0 remaining` at the end. No wall-clock deadline or arbitrary kill switch was
added — none is needed, since the work-unit count and per-unit lookback are
already authoritative bounds; a deadline would only add an unmotivated
failure mode on top of a bound that already exists.

**What this does NOT claim:** the wall-clock duration of a single repair unit
(the ~58 minutes observed live) is not itself bounded by this fix — it is
genuine Slack-API-side backlog catch-up within the fixed `p7d` window, subject
to Slack's own rate limits, and can legitimately vary run to run. The
guarantee is narrower and precise: the *number of repair units and their
lookback scope* are finite, known before execution, and observable — not that
any specific elapsed-time figure is capped.

### D5 — Live-closure follow-up: D4.2's per-unit lookback bound is necessary
but not sufficient — a retained scoped archive still resumed every run
forever (2026-07-25, live UAT of D4)

Live deploy (`aa038775d`, run `run_1784962644222`) proved D4.2's claim
incomplete. Ground truth: the run succeeded (D4.1's protocol fix held), and
`scoped-archive-reconcile` reported `selected 1 repair unit(s) (1 existing
scoped archive refresh(es) + 0 new-repair attempt(s) for 0 uncovered
channel(s)), each bounded to lookback=p7d` — the bound D4.2 promised was
correctly stated. But that single "bounded" unit still took 3,291,850ms
(54m52s), because it was a `resume` against a scoped archive
(`archive-scoped/62fd13bace2a/`) that had accumulated ~4.9GB / ~1.95M
messages / ~137k `CHANNEL` rows, and `messages`/`channels`/`max_chunk` grew
continuously throughout the entire run (confirmed via the connector's own
per-minute progress snapshots) — genuine, ongoing Slack-side traffic, not a
stalled or inaccessible channel.

**Root cause.** D4.2's bound counted *repair units*, correctly, but treated
"this archive is selected because it covers a currently-missing channel" as
sufficient reason to invoke `resume` against it — every run, forever — with
no check for whether a resume could discover anything the *previous* run's
resume hadn't already found. Two facts made this a permanent, not transient,
cost:

1. `SLACK_MEMBER_ONLY=true` (default) permanently excludes a channel from the
   unscoped base archive's own scan once the bot/user is no longer a member —
   so `baseMissingChannelIds` for that channel is not a temporary blip; it is
   a structural, non-resolving condition for the life of the connection.
   `reconcileMessageSourceCache`'s own doc comment already calls this
   mechanism a fix for "historical holes" (see `c18662d83`/`41a47885d`), i.e.
   rare, one-time backfills — not a per-run, permanent maintenance operation.
2. Verified against slackdump v4.4.2 source
   (`cmd/slackdump/internal/resume/resume.go:298`, `internal/chunk/backend/
   dbase/source.go:369-405`): `resume <path>`'s channel/entity scope is
   *always* re-derived from every channel **already recorded in that
   archive's own DB** (`src.Latest(ctx)`), never filtered by the specific
   channel ID(s) the connector's `positionalChannels` targets in a `resume`
   call (unlike `archive`, which does respect them — `buildArchiveArgs`
   pushes `positionalChannels`, `resume`'s built args never do). So once a
   scoped archive's on-disk channel set drifts wider than the one channel it
   was created to isolate (however that happened historically), every future
   `resume` against that path re-syncs the ENTIRE recorded set, with cost
   scaling with the archive's total accumulated size — exactly the class of
   bug D1 fixed for the main archive, reintroduced here for scoped archives.

**Fix — lifecycle/owed-work throttle, not a wall-clock timeout.**
`slackdump resume -lookback pNd` cannot discover a message older than
`now - N days` no matter how often it is invoked — the window is fixed by the
flag, not by call frequency. So invoking it more often than once per lookback
period cannot recover data a less-frequent invocation would miss; whatever
backlog accumulated during the throttled interval is caught in a single call
once the throttle elapses. This is a direct, provable consequence of
slackdump's own `-lookback` semantics — not a heuristic guess, and not a
wall-clock kill switch on the connector's own patience.

Added `scoped_archive_resumed_at: Record<archivePath, isoTimestamp>` to the
`messages` STATE cursor, recording when each scoped archive last had `resume`
actually invoked. `reconcileMessageSourceCache` now checks, per selected
scoped archive, whether it is due (`scopedArchiveDueForResume`: no prior
timestamp, or elapsed time since the prior timestamp ≥
`SLACK_LOOKBACK_DAYS`). If not due, `refreshScopedArchive` returns
immediately — `ensureArchiveOnDisk` (and therefore the slackdump subprocess)
is never invoked for that archive this run — and reports the decision as
progress. If due, it resumes as before and the timestamp advances to this
run's `emittedAt`. A repair attempt (`repairMissingScopedArchive`) also
stamps a fresh timestamp on success, since it necessarily just resumed/
archived that path.

This directly satisfies the requirement: an ordinary run where the only
selected scoped archive is not yet due for resume now skips the expensive
subprocess entirely (bounded to a cheap existence check + one progress line),
while a scoped archive whose throttle window has genuinely elapsed still
resumes exactly as before — no coverage is lost, only deferred to at most
`SLACK_LOOKBACK_DAYS`, within the same window the connector already commits
to for backlog visibility.

**Is it safe to retire (delete) the bloated scoped archive's on-disk state
and reclaim its bytes?** Determined: **no, not the `slackdump.sqlite`.** It is
still this connector's only durable resume state for a channel structurally
excluded from the base scan (per fact 1 above); deleting it would force a
future repair to fall back to a from-scratch `archive` invocation, an even
more expensive operation than a single throttled `resume`, and the same
class of unsafe deletion D3/D4 already reject for the main archive's SQLite.
Its `__uploads/` residue, however, **is** already safely reclaimable — it
remains in `scopedArchives` (throttling changes only whether `resume` runs,
not whether the archive is selected/read), so it was already covered by
D4.1's reclaim-plan fix; no additional reclaim change was needed here.

**What this does NOT claim:** the throttle bounds *call frequency*, not the
absolute cost of a single genuinely-due resume against a large accumulated
archive — a due resume against a multi-GB scoped archive can still take
tens of minutes, exactly as D4.2 already disclosed. The new guarantee is that
this cost recurs **at most once per `SLACK_LOOKBACK_DAYS`** per scoped
archive, not every run.

## Rejected alternatives

- **Drain `slackdump.sqlite` (or old rows) after PDPP accepts records.**
  Rejected. The SQLite *is* the resume state and the connector's only source;
  draining it forces a full multi-hour re-dump and risks resume gaps (deleting
  the per-channel `MAX(TS)` row shifts resume's computed start point). PDPP
  durably has the *records* it emitted, but the archive is not redundant with
  PDPP — it is the connector's working set. No durable-commit receipt makes DB
  deletion safe.

- **Automatic `__uploads/` drain gated on PDPP acceptance.** Rejected as
  unsafe/misleading. PDPP never accepted the bytes (metadata only), so "drain
  the corresponding accepted material" has no referent. Automatic deletion
  destroys the only local byte copy and permanently disables slackdump
  re-download (DB-only dedup), with no PDPP fallback. Made opt-in instead (D3).

- **Bounded/rotating archive (e.g. `-time-from` recent window, drop old).**
  Rejected. slackdump `archive`/`resume` treat the DB as cumulative; `-time-from`
  bounds a *fresh* archive but does not trim an existing one, and `resume`
  computes its own per-channel start point (lookback), so a rotating window
  would either re-dump history or create coverage gaps — violating "no skipped
  new/edited/deleted items within declared coverage." No native rotation
  exists.

- **Rebuild from a PDPP-owned checkpoint/window.** Rejected as premature. PDPP
  stores records, not slackdump's chunk/session structure, so it cannot
  reconstruct a resumable slackdump archive; a rebuild would be a fresh
  full dump. Worth revisiting only if/when Slack becomes source-backed and PDPP
  owns the bytes.

- **Upstream-native prune/compact.** Rejected: does not exist for legitimate
  data (verified at v4.4.2). `tools cleanup` = crashed-session debris only;
  `tools dedupe` = redundant lookback copies only.

- **Delete/retire a bloated scoped archive's `slackdump.sqlite` and rebuild it
  narrowly.** Rejected (D5). It is still the connector's only durable resume
  state for a channel structurally excluded from the base scan; deleting it
  forces a from-scratch `archive` invocation next time that channel needs
  healing — strictly more expensive than a single throttled `resume`, and the
  same class of unsafe DB deletion already rejected above for the main
  archive. A wall-clock or call-count kill switch on the resume subprocess
  itself was also considered and rejected in favor of the lookback-throttle:
  a timeout would abort mid-fetch with no guarantee of a clean stopping
  point and no principled way to pick a threshold, whereas throttling by
  `SLACK_LOOKBACK_DAYS` is provably lossless (see D5) and reuses a bound the
  connector already commits to.

## Invariant coverage

- No historical PDPP record loss — nothing deletes PDPP data; D1 is
  emit-identical; D3 touches only local slackdump upload bytes PDPP never held.
- No skipped new/edited/deleted items in coverage — D1 preserves the emitted
  set exactly; cursor semantics unchanged.
- Crash-safe checkpointing — STATE emission unchanged; D3 runs only after the
  commit ack, so a crash before ack leaves `__uploads/` intact.
- Never delete slackdump material before durable commit — D3 gated on
  runtime-EOF ack; D1 deletes nothing.
- Safe rollback/rebuild — D1 is a pure query rewrite (revert = revert); D3 is
  off by default; if `__uploads/` is reclaimed and bytes are later needed, the
  documented recovery is a fresh `archive` run with `SKIP_FILES=false` (not
  `resume`, which would skip via DB dedup).
- Bounded steady-state disk + run time — D1 bounds the message-read query to
  new data; D3 + default `SKIP_FILES=true` bounds disk to the SQLite; D4
  bounds `scoped-archive-reconcile`'s repair-unit *count* and per-unit
  lookback scope; D5 additionally bounds how often a given unit's `resume`
  subprocess actually runs (at most once per `SLACK_LOOKBACK_DAYS`) — an
  ordinary run whose only selected units are not yet due skips the subprocess
  entirely. NOT bounded: the wall-clock duration of a single genuinely-due
  resume against a large accumulated archive, which is real Slack-API-side
  backlog catch-up and can still take tens of minutes when it does run.
- No dependence on private live payloads in tests — all tests seed synthetic
  in-memory SQLite archives (existing harness pattern).
- Existing connection upgrades safely — no manifest-breaking change; new option
  defaults preserve today's behavior; the incremental query falls back to full
  aggregation whenever no cursor exists (i.e. first run after upgrade behaves
  exactly as today).

## Residual risks (owner-only)

- **Live UAT.** Confirm on the real 31 GB archive that (a) run time drops
  toward the ~50s floor once the message CTE stops full-scanning, and (b) the
  phase-timing output attributes the remaining time correctly (slackdump vs.
  connector). Cannot be verified here without the live archive/credentials.
- **One-time reclaim decision.** Whether to run `SLACK_RECLAIM_UPLOADS=1` once
  on the live host to reclaim the 29 GB is an operator judgment (accepts the
  documented byte loss). Not performed by this change.
- **D4 live UAT — DONE, and it found a real gap (D5).** Deploy `aa038775d`,
  run `run_1784962644222` (2026-07-25) confirmed D4.1 (protocol safety, no
  `connector_protocol_violation`) but disproved D4.2's implicit assumption
  that repair-unit-count bounding alone was sufficient: a single "bounded"
  unit still took 54m52s every run, forever, because nothing throttled how
  often that specific unit's `resume` was invoked. Fixed in D5. This item is
  resolved by D5's fix, not by further observation — the residual UAT need is
  now D5's own, below.
- **D5 live UAT.** Confirm on the real workspace, over multiple scheduled
  runs spanning more than `SLACK_LOOKBACK_DAYS`, that: (a) the first run after
  this deploy still resumes `archive-scoped/62fd13bace2a/` (or whichever
  archive covers the permanently-missing channel) since it has no prior
  `scoped_archive_resumed_at` entry yet; (b) subsequent runs within the
  lookback window report `... due for resume` = 0 and `not due for resume
  yet` in progress evidence, with `scoped-archive-reconcile`
  completing in seconds, not tens of minutes; (c) once the lookback window
  elapses, a resume fires again and finds the accumulated backlog with no
  gap. Cannot be verified here without the live host/credentials and without
  waiting out a real multi-day window — synthetic subprocess tests
  (`archive-reclaim.test.ts`) prove the throttle/resume-again mechanism
  deterministically via injected `scoped_archive_resumed_at` timestamps, not
  the real multi-day elapsed-time behavior.
