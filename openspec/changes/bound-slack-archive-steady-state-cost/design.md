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
- Bounded steady-state disk + run time — D1 bounds run time to new data; D3 +
  default `SKIP_FILES=true` bounds disk to the SQLite.
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
