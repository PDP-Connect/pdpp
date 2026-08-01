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

A live deploy and a subsequent live run proved D4.2's claim incomplete.
Ground truth: the run succeeded (D4.1's protocol fix held), and
`scoped-archive-reconcile` reported `selected 1 repair unit(s) (1 existing
scoped archive refresh(es) + 0 new-repair attempt(s) for 0 uncovered
channel(s)), each bounded to lookback=p7d` — the bound D4.2 promised was
correctly stated. But that single "bounded" unit still took ~55 minutes,
because it was a `resume` against a retained scoped archive that had
accumulated several GB / millions of messages / hundreds of thousands of
`CHANNEL` rows, and `messages`/`channels`/`max_chunk` grew continuously
throughout the entire run (confirmed via the connector's own per-minute
progress snapshots) — genuine, ongoing Slack-side traffic, not a stalled or
inaccessible channel.

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
**successfully complete**. `reconcileMessageSourceCache` now checks, per
selected scoped archive, whether it is due (`archiveDueForResume`: no
prior timestamp, or elapsed time since the prior timestamp ≥
`SLACK_LOOKBACK_DAYS`). If not due, `refreshScopedArchive` returns
immediately — `ensureArchiveOnDisk` (and therefore the slackdump subprocess)
is never invoked for that archive this run — and reports the decision as
progress. If due, it attempts to resume; **only a genuinely completed resume
advances the timestamp to this run's `emittedAt` — see D6, which closes the
gap this description originally left (a failed attempt was, on first cut,
also treated as advancing it).**

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

### D6 — RI-owner REVISE on D5: a failed resume silently counted as success,
suppressing retries for a full lookback window; routed to the existing
typed gap/recovery-governor path instead (2026-07-25, same day)

**Blocker found:** D5's `refreshScopedArchive` caught `ensureArchiveOnDisk`'s
failure and returned `resumed: true` anyway (its own comment said "record
the attempt" but the field's declared meaning — read by the caller as "this
completed, advance the throttle" — said success). This meant a resume that
threw for any reason (network failure, slackdump crash, malformed archive)
was durably recorded as `scoped_archive_resumed_at = now`, exactly the same
outcome as a real success — silently suppressing retries for a full
`SLACK_LOOKBACK_DAYS` (default 7 days) despite nothing having actually
completed. A recoverable gap could hide for up to a week with no evidence
anywhere that anything had gone wrong.

**Fix — concept-correct outcome typing, not a wall-clock timeout, not a
parallel retry taxonomy.** `refreshScopedArchive` now returns a
`RefreshScopedArchiveOutcome` discriminated union — `"resumed" |
"throttled" | "failed"` — making "genuinely completed" and "attempted but
did not complete" structurally distinct facts the caller cannot conflate.
Only `"resumed"` may ever advance `scoped_archive_resumed_at`. A `"failed"`
outcome leaves the timestamp exactly as it was — the archive remains due
(or becomes due once its existing timestamp's window elapses) for the very
next run, not suppressed for a week.

A failed resume's retry pacing is not reinvented locally. It is routed
through the connector-runtime protocol's existing typed recoverable-work
vehicle: **`DETAIL_GAP`** (`packages/polyfill-connectors/src/connector-
runtime.ts` `buildDetailGap`/`emitDetailGap`, the same mechanism Gmail uses
for failed attachment hydration and Amazon/HEB/ChatGPT use for detail-hydration
recovery). `record_key` is the scoped archive's path — stable across runs
(so repeated failures upsert the SAME durable row per the runtime's
`(connector_instance_id, stream, record_key)` conflict key, never spamming
one row per run) and unique to the archive the resume subprocess actually
operates on. `reason: "temporary_unavailable"` mirrors Gmail's attachment
gap: the failure bucket mixes transient network/subprocess errors with no
exhaustion signal, so it does **not** arm the cross-run source-pressure
cooldown (only `rate_limited`/`upstream_pressure` do) — an unrelated
recoverable stream's pacing is never affected by a stuck scoped archive.
On a later run where that same archive's resume succeeds, the connector
reads `ctx.detailGaps` (the currently-pending gaps replayed on `START`,
already available to every connector via the existing protocol) to find any
gap matching `(stream: "messages", record_key: archivePath)` and emits
`DETAIL_GAP_RECOVERED` for it — closing the durable row instead of leaving
it `pending` forever after the underlying problem has cleared.

**Why not a connector-local suppression window for the failure case, and why
not extend it to `repairMissingScopedArchive`'s own failure path too?** The
recovery governor (`add-connector-neutral-recovery-governor`) already exists
precisely to own retry pacing for durable recoverable work cross-run — a
connector-local N-day suppression on top of it would be exactly the
duplicate, untyped, ungoverned mechanism that governor was built to replace
(its own proposal states a connector-local cap "SHALL NOT be the mechanism
by which an owner drains a backlog"). `repairMissingScopedArchive`'s
existing failure path was not touched in this pass: it already correctly
withholds `archivePath`/`scoped_archive_resumed_at` on failure (verified
by reading the code — that path was not part of the blocker found), and
extending typed-gap emission there was judged out of scope for this specific
fix to avoid unrelated surface-area growth; it remains a candidate for a
future, separately-scoped pass if the RI owner wants full parity.

**Mutation-tested twice:** reverting the `"failed"` branch to return
`{ kind: "resumed" }` (the exact original bug) fails the new regression test
with `the completed cursor honestly reports this unit as failed, not
resumed`; suppressing the `DETAIL_GAP` emission fails it with `emits a
DETAIL_GAP keyed by the archive path`. Both confirmed live, then reverted.

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
  entirely; D6 makes that bound honest under failure — only a genuinely
  completed resume advances the throttle timestamp, a failed attempt leaves
  the archive owed and surfaces a typed `DETAIL_GAP` instead of silently
  suppressing retries. NOT bounded: the wall-clock duration of a single
  genuinely-due resume against a large accumulated archive, which is real
  Slack-API-side backlog catch-up and can still take tens of minutes when it
  does run.
- No dependence on private live payloads in tests — all tests seed synthetic
  in-memory SQLite archives (existing harness pattern).
- Existing connection upgrades safely — no manifest-breaking change; new option
  defaults preserve today's behavior; the incremental query falls back to full
  aggregation whenever no cursor exists (i.e. first run after upgrade behaves
  exactly as today). D8 closes the one throttle-specific upgrade gap this
  general statement did not cover: a connection whose base archive already
  proved success under pre-D7 STATE now derives the throttle fact instead of
  replaying the archive once more on the first post-upgrade run.

### D7 — Base archive resumes need the same success throttle without sharing scoped state (2026-07-25)

The base `/archive` path is the normal scheduled collection path, not a scoped
repair unit. `pickResumeTarget` chooses it before source-cache reconciliation,
so `scoped_archive_resumed_at` cannot suppress its `resume -lookback p7d`.
When a committed `archive_dir` or discovered on-disk archive exists, that
meant every 90-minute scheduled run re-ran the expensive base resume.

The connector now persists `base_archive_resumed_at: Record<archivePath,
isoTimestamp>` independently from `scoped_archive_resumed_at`. Its key is the
resolved base archive path — the stable identity of the slackdump database the
subprocess targets. An unscoped existing archive is due when the field is
absent, invalid, or at least `SLACK_LOOKBACK_DAYS` old. Otherwise collection
opens and reads its existing SQLite archive without invoking slackdump.

The success fact is assigned only after `ensureArchiveOnDisk` completes, then
travels through the ordinary messages STATE checkpoint. A failed resume throws
before assignment; a later failure prevents STATE commit. Thus failures remain
retryable and neither scoped nor base state can suppress the other. First-run
`archive` creation and explicitly scoped archive/repair behavior are unchanged.

### D8 — Live REVISE on D7: no compatibility path from pre-upgrade successful
state permitted one more full base-archive replay (2026-07-25, live canary)

**Blocker found.** Live canary on deployed `b7a6485f5`/`674eccb6e`: the first
post-upgrade scheduled run (`run_1784994300807`) logged "Resuming slackdump at
`/root/.pdpp/slackdump/vana-org/archive`" — a fresh multi-GB replay on a
connection whose base archive had already completed real, successful resumes
under the OLD code for months. Root cause: `base_archive_resumed_at` did not
exist before D7 shipped, so no prior run had ever written it; D7's own
`archiveDueForResume` treats an absent entry as unconditionally due
(`if (!lastResumedAtIso) return true;`), and D7's design explicitly assumed
"the field is absent, invalid, or at least `SLACK_LOOKBACK_DAYS` old" all mean
the same thing — due — without asking whether prior STATE already proves the
work was done. Every existing test seeded `base_archive_resumed_at` directly
(including its absence for "first run"), so none reproduced the actual
upgrade transition: durably-proven prior success with no entry for the new
field.

**Fix — a narrow, one-time derivation, not a relaxed due-check.**
`deriveMigratedBaseArchiveResumedAt` (`index.ts`) fires only when ALL of:
the current run is on the unscoped base boundary (scoped archives are
untouched — base/scoped throttle remain fully independent, per the original
requirement); `priorBaseArchiveResumedAt[archivePath]` is absent (never
overrides a real fact, migrated or otherwise); the resolved prior-archive
identity (`pickResumeTarget`'s `priorArchive`) equals this run's own
`archivePath` (ties the proof to the base archive's own identity, not a
stale/differently-scoped path); and prior STATE carries `messages.last_ts` or
a non-empty `messages.channel_last_ts` — fields `emitStateCheckpoints` (and
its pre-D7 predecessor) writes ONLY after a run reaches its normal
durable-commit path. An interrupted or failed run commits no STATE at all
(proven by the existing "a failed base archive resume remains owed" test),
so this is durable proof of a genuinely **completed** prior run, not mere
archive existence on disk (which an interrupted/crashed run leaves behind
too, and which the migration deliberately does NOT treat as proof — see the
negative test below). The derived timestamp is `ctx.emittedAt` (this run,
not a backdated guess), so the very next scheduled run is immediately
throttled and a genuine resume becomes due again after one full
`SLACK_LOOKBACK_DAYS` from here — the same lossless cadence D5 already
established for scoped archives, applied one run later than an
already-migrated connection would see it. The derived fact only reaches
durable STATE if this run itself commits, preserving the same crash-safety
invariant as every other throttle fact in this change.

**Mutation-tested:** a new regression
(`upgrade compatibility: a pre-upgrade successful base archive is throttled
on the first post-upgrade run, not replayed`) reproduces the exact live
pre-upgrade STATE shape (`archive_dir` + `channel_last_ts` + `last_ts`, no
`base_archive_resumed_at` key) and asserts zero `slackdump resume`
invocations on both the migration run and the immediate 90-minute follow-up.
Run against `b7a6485f5` unmodified (via `git stash`), it fails with the
live symptom exactly reproduced — a `resume` subprocess launches — confirming
the test would have caught this before deploy. A paired negative test
(`upgrade compatibility does NOT seed the throttle from archive existence
alone`) proves an archive with no committed success proof still resumes
normally, so the migration cannot mask a genuinely interrupted/failed prior
run as done.

### D9 — RI revision on D7/D8: the base-archive throttle was itself the defect — cost bounding and freshness cadence are different concerns (2026-07-31, live incident fleet-slack-message-freshness-0731)

**Supersedes D7 and D8's premise, not their evidence.** D7 shipped a
`SLACK_LOOKBACK_DAYS`-gated throttle on the *base/unscoped* archive's own
`resume` subprocess, reusing the same lookback-window mechanism D5 built for
*scoped repair* archives. D8 then had to build one-time migration machinery
(`deriveMigratedBaseArchiveResumedAt`) to stop that throttle from replaying
an already-successful base archive on the first post-upgrade run. Both were
internally consistent with the design as stated — but the design itself
conflated two different things under one knob:

1. **Base archive freshness cadence** — how often the main/unscoped archive
   re-syncs to pick up new Slack messages. This should be driven by the
   *scheduler's* run cadence (it already decides when a run happens at all),
   not a separate connector-local multi-day throttle.
2. **Scoped repair archive cost** — the genuinely expensive (~55–58 minutes
   live, per D5) historical-backfill work for specific channels/date ranges
   that D4/D5/D6 correctly bound and throttle.

**Live evidence (2026-07-31 incident investigation) proved these are not the
same cost.** Connection `cin_f565a96cb0a114b0a27e9606`'s last real BASE
archive resume (2026-07-25T16:04:06.919Z) completed in **~1.6 minutes** —
not the ~58 minutes D5's own text attributes to "a `resume` against a
**retained scoped archive**" (D5, above). D7's throttle, applied to the base
archive on the strength of "the base `/archive` path... has the same
`resume -lookback pNd` frequency property as scoped repair archives"
(original proposal.md), silently froze this connection's `messages` stream
at its 2026-07-25 state for 6+ days and dozens of scheduled runs — with
`channel_stats` (unconditional, uncursored) staying non-zero every run, so
`run_history.status = succeeded` never signalled anything was wrong. Commit
`5c7ff8c7e` made that freeze honestly *reported* (a `retryable_gap`
`SKIP_RESULT` instead of silent `collected: 0`), but RI review correctly
rejected it as incomplete: making a wrong cadence honest is not the same as
fixing the cadence.

**The fix.** The base-archive throttle (`refreshBaseArchiveIfDue`'s
`archiveDueForResume` gate, the `base_archive_resumed_at` STATE field, and
D8's `deriveMigratedBaseArchiveResumedAt` migration) is removed entirely.
`refreshBaseArchive` now unconditionally invokes `resume` on every run that
reaches the unscoped/main-archive boundary — the same behavior the connector
had before D7 ever shipped, restored deliberately rather than accidentally.
The 5c7ff8c7e "deferred honesty" machinery
(`BASE_ARCHIVE_RESUME_DEFERRED_REASON`,
`reportDeferredMessagesIfThrottledEmpty`, the `BaseArchiveResumeOutcome`
struct) is deleted as unreachable dead code: there is no longer a throttled
base-archive path for it to report on. `archiveDueForResume` itself is
**retained** — it still gates scoped repair archives in
`reconcileMessageSourceCache` exactly as D4/D5/D6 designed, which remains
correct and untouched.

**Why unthrottled base resume is safe (not a replay/duplicate-work risk).**
- **No replay.** `resume` (as opposed to `archive`) is `slackdump`'s own
  incremental primitive — it advances the archive's on-disk cursor via its
  own `SESSION`/`V_LATEST_MESSAGE` bookkeeping, never re-fetching data it has
  already durably recorded. Running it every scheduled/manual run is exactly
  what a connector with no persistent archive at all does implicitly on
  every run; persisting an archive only makes that resume cheaper than a
  fresh archive, never more expensive than not persisting one.
- **No duplicate/overlap emission.** The connector's own `messages` cursor
  (`last_ts`/`channel_last_ts`, pushed into the incremental CTE by D1) is
  the actual de-dup boundary for what PDPP ingests — it is independent of
  whether `resume` ran zero or one extra time this run. Two base resumes in
  immediate succession cannot double-emit a message, because the second
  resume's read is filtered by the same committed cursor as the first.
- **Cost is bounded by the scheduler, not by this connector.** A connector
  cannot control how often it is invoked; it can only control what it does
  once invoked. Making the base resume free-running (bounded only by
  whatever cadence the scheduler already enforces) is the same posture every
  other first-party connector without a persistent archive already has.
- **Genuinely cheap.** ~1.6 minutes live, matching a `resume` against an
  archive that is already current — the cost this throttle was built to
  bound (~58 minutes) was never the base archive's cost to begin with.

**Tests.** `archive-reclaim.test.ts`'s six base-archive-throttle tests
(90-minute-follow-up throttle, throttled-zero-new-rows honesty ×2, failed
base resume retry, seven-day lookback expiry, ×2 upgrade-migration tests)
are replaced with three tests matching the corrected behavior: (1) a
90-minute scheduled follow-up invokes `resume` exactly once (was: zero,
proving the old throttle is gone); (2) a base resume that discovers new
content advances the committed `messages` cursor past a previously stuck
point (proves the live bug — 6+ days frozen at 2026-07-25 — is fixed, not
merely reported honestly); (3) a failed base resume fails the run and
retries on the very next attempt, with no throttle-suppression state to
navigate around. Old-code-fails/new-code-passes proven against `5c7ff8c7e`
(see report). All pre-existing scoped-archive-throttle tests (D4/D5/D6's
own suite) are untouched and still pass, confirming the scoped-repair bound
this change correctly preserved is unaffected.

## Residual risks (owner-only)

- **Live UAT.** Confirm on the real 31 GB archive that (a) run time drops
  toward the ~50s floor once the message CTE stops full-scanning, and (b) the
  phase-timing output attributes the remaining time correctly (slackdump vs.
  connector). Cannot be verified here without the live archive/credentials.
- **One-time reclaim decision.** Whether to run `SLACK_RECLAIM_UPLOADS=1` once
  on the live host to reclaim the 29 GB is an operator judgment (accepts the
  documented byte loss). Not performed by this change.
- **D4 live UAT — DONE, and it found a real gap (D5).** A live deploy and
  subsequent live run confirmed D4.1 (protocol safety, no
  `connector_protocol_violation`) but disproved D4.2's implicit assumption
  that repair-unit-count bounding alone was sufficient: a single "bounded"
  unit still took ~55 minutes every run, forever, because nothing throttled
  how often that specific unit's `resume` was invoked. Fixed in D5. This item
  is resolved by D5's fix, not by further observation — the residual UAT need
  is now D5's own, below.
- **D5 live UAT.** Confirm on the real workspace, over multiple scheduled
  runs spanning more than `SLACK_LOOKBACK_DAYS`, that: (a) the first run after
  this deploy still resumes the scoped archive covering the permanently-
  missing channel, since it has no prior `scoped_archive_resumed_at` entry
  yet; (b) subsequent runs within the lookback window report `... due for
  resume` = 0 and `not due for resume yet` in progress evidence, with
  `scoped-archive-reconcile` completing in seconds, not tens of minutes; (c)
  once the lookback window elapses, a resume fires again and finds the
  accumulated backlog with no gap. Cannot be verified here without the live
  host/credentials and without waiting out a real multi-day window —
  synthetic subprocess tests (`archive-reclaim.test.ts`) prove the
  throttle/resume-again mechanism deterministically via injected
  `scoped_archive_resumed_at` timestamps, not the real multi-day
  elapsed-time behavior.
- **D5's own gate found a real defect (D6).** An RI-owner REVISE caught that
  D5's success/failure conflation would have silently hidden a real resume
  failure for up to 7 days with zero durable evidence. Fixed in D6,
  mutation-tested. This item is resolved by code + tests here, not by
  further live observation for the specific conflation bug — the residual
  live-UAT need is D6's own, below.
- **D6 live UAT.** Confirm on the real workspace that a genuine resume
  failure (if one ever occurs) produces a `DETAIL_GAP` visible in the
  connection's durable gap store (not merely a progress line), that
  `scoped_archive_resumed_at` for that archive is confirmed unchanged in the
  next run's committed STATE, and that a later successful resume of the same
  archive produces a matching `DETAIL_GAP_RECOVERED` closing the row. Cannot
  be verified here without provoking (or waiting for) a real live resume
  failure — synthetic subprocess tests prove the mechanism deterministically
  via a fake `SLACKDUMP_BIN` that fails only for the scoped-archive path, not
  a live failure.
- **D7/D8's own residual-risk items are superseded, not merely resolved.**
  D7 and D8 shipped a base-archive throttle whose live-UAT need (originally
  slated to appear here) is now moot: D9 removed the base-archive throttle
  entirely, so there is no base-archive "resume again after lookback
  elapses" behavior left to verify. The connection this incident affected
  (`cin_f565a96cb0a114b0a27e9606`) is the closest thing to a live UAT this
  change has: its base archive was demonstrably frozen at 2026-07-25T16:04
  for 6+ days under the throttle, which is direct live evidence the throttle
  was actively harmful, not merely un-verified.
- **D9 live UAT.** Confirm on the real workspace, once deployed, that (a)
  connection `cin_f565a96cb0a114b0a27e9606`'s next scheduled run invokes a
  base `resume` and its `messages` record count/`max(emitted_at)` advance
  past `212833` rows / `2026-07-25T04:34:06.407Z`; (b) `run_history`'s
  `collection_facts.streams.messages` no longer carries a
  `base_archive_resume_deferred` skip on subsequent runs (the 5c7ff8c7e
  reporting path is now unreachable, so this key should be absent going
  forward, not merely non-`retryable_gap`); (c) steady-state run time for
  this connection's base-archive phase (`slackdump-subprocess` phase timing)
  stays in the low-minutes range it showed pre-incident, confirming the
  ~1.6-minute cost estimate holds on repeat runs, not just the one sampled
  run. Cannot be verified here without the live host/credentials and without
  observing at least one real post-deploy scheduled run.
