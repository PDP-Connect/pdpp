## Why

The Slack connector wraps `slackdump`, which keeps its own persistent archive
at `~/.pdpp/slackdump/<workspace>/archive/`. On the live connection that
archive has grown to 31 GB (29 GB `__uploads/` attachment bytes, 2.4 GB
`slackdump.sqlite` = 574k `MESSAGE` rows / 186k unique messages) and
successful runs grew from ~50s to ~4,000–5,000s while emitting only ~120–250
records per run. The 90-minute schedule was paused.

The framing that motivated this change — "drain old slackdump material after
PDPP has durably accepted it" — does not survive investigation. The 31 GB is
two independent problems with different root causes and different safe fixes:

**Run-time regression (the operationally worst symptom) is a re-scan cost in
this connector's own read path, not a disk problem.** Every run reads the
whole archive and relies on cursor/fingerprint suppression to avoid
re-*emitting*. The message dedup step
(`connectors/slack/index.ts` `buildMessageRowsQuery`) computes
`SELECT CHANNEL_ID, TS, MAX(CHUNK_ID) FROM MESSAGE GROUP BY CHANNEL_ID, TS`
as a CTE **before** the incremental `TS > last_ts` filter can apply. The
slackdump schema
(`internal/chunk/backend/dbase/repository/migrations/20250207082949_initial.sql`)
has no index on `(CHANNEL_ID, TS)` — only `PRIMARY KEY (ID, CHUNK_ID)` and an
index on `CHUNK_ID` — so this aggregation is a full scan + sort/hash of all
574k rows on every run, growing with total archive size regardless of how few
rows are new. `__uploads/` is never walked, stat-ed, or read by the connector
(no `__uploads` reference exists in any `.ts` source), so it is not the cause
of the run-time growth.

**Disk (29 GB `__uploads/`) cannot be safely "drained after PDPP accepts it,"
because PDPP never accepts the bytes.** The connector emits file/attachment
**metadata only** — `buildFileRecord` (`connectors/slack/parsers.ts`) produces
`id`/`name`/`mimetype`/`size`/`url_private`/`permalink` and never reads bytes;
`manifests/slack.json`'s `files` stream carries no `blob_ref`; and PDPP's blob
store (`reference-implementation/operations/rs-blobs-upload/`) is never called
by this connector. `SLACK_SKIP_FILES` defaults to `true` → slackdump runs with
`-files=false`, so steady-state runs do not download files at all. The 29 GB is
legacy residue from a period when files were downloaded. Deleting it is safe
for PDPP's own data integrity (PDPP has no copy to lose), but it is **not**
recoverable and it silently disables re-download: slackdump's resume file
dedup is DB-only (`GetByIDAndSize` against the `FILE` table, never an on-disk
`stat`), so a `FILE` row makes resume treat a deleted upload as "already have
it" forever, and the stored `url_private` values require live Slack auth and
are short-lived. slackdump ships no native prune/compact/rotate for legitimate
data (`tools cleanup` only removes crashed-session debris; `tools dedupe` only
removes redundant lookback-overlap copies; there is no `VACUUM` command).

So the SLVP is not a drain. It is: **make steady-state cost bounded and
measurable**, and give the operator one honest, opt-in escape hatch for the
legacy `__uploads/` residue that states exactly what it sacrifices.

## What Changes

- **Incremental message read (run-time fix, behavior-preserving).** Push the
  per-channel/legacy `TS` threshold into the `latest` dedup CTE in
  `buildMessageRowsQuery`, so the `MAX(CHUNK_ID) GROUP BY CHANNEL_ID, TS`
  aggregation only touches rows newer than the committed cursor instead of the
  whole `MESSAGE` table. Emitted RECORDs are byte-identical: a `(CHANNEL_ID,
  TS)` we would emit has `TS > threshold`, so every chunk that shares that
  `(CHANNEL_ID, TS)` also has `TS > threshold` and the `MAX(CHUNK_ID)` pick is
  preserved; rows at or below the threshold are never emitted either way. The
  first-run / no-cursor / legacy-fallback paths keep the full aggregation
  (correct — there is no threshold to push).

- **Phase timing + size observability.** Emit per-phase timing via the
  existing `progress` channel — slackdump subprocess duration, sqlite open
  duration, per-stream read+emit duration, and total — plus a one-line archive
  size snapshot (`slackdump.sqlite` bytes and `__uploads/` presence/byte
  size). This turns the causal diagnosis ("slackdump network vs. connector
  re-scan") from a guess into a measured value on every run, and makes the
  steady-state-cost invariant checkable.

- **Opt-in `__uploads/` reclaim escape hatch (NOT automatic, NOT a drain).**
  A new `SLACK_RECLAIM_UPLOADS` option (default off). When explicitly enabled,
  after the run's records are durably committed (guarded on the runtime EOF ack
  the connector already waits for at exit), the connector removes the
  `__uploads/` directory for the workspace archive and reports the reclaimed
  byte count via `progress`/`DETAIL_COVERAGE`. It is loudly documented as a
  one-way operation that PDPP cannot undo and that disables slackdump's
  re-download of those files. It never touches `slackdump.sqlite` (the resume
  state). With the default `SLACK_SKIP_FILES=true`, `__uploads/` does not
  regrow, so steady-state disk is the SQLite alone. This is the smallest safe
  reclaim; it is off by default precisely because it is lossy.

- **Docs.** `connectors/slack/README.md` gains a "Disk and run-time" section
  documenting the two-problem reality, the incremental read, the observability,
  and the reclaim escape hatch with its explicit caveats.

## Non-Goals

- **Automatic deletion of any slackdump material.** No automatic drain, prune,
  or rotation of `slackdump.sqlite` or `__uploads/`. Deleting the SQLite would
  destroy resume state and force a multi-hour full re-dump; deleting
  `__uploads/` automatically would silently lose the only byte copy and disable
  re-download. Both are rejected — see `design.md`.

- **Durably storing Slack attachment bytes in PDPP.** Blob-backed fulfillment
  for Slack files is a separate, larger change (see
  `openspec/changes/define-source-backed-fulfillment`); until it exists, PDPP
  holds no attachment bytes, so no "drain after acceptance" is possible.

- **Shrinking the existing 2.4 GB SQLite.** The run-time fix stops the wasteful
  full re-scan; it does not compact the DB. slackdump ships no safe compaction
  for legitimate data, and rewriting slackdump's schema is out of scope.

- **Live UAT.** Confirming the deployed connector's run time drops on the real
  31 GB archive is owner-only and out of scope — recorded as a residual step in
  `design.md`.

## Capabilities

- Modified: `polyfill-runtime` — an archive-backed connector's steady-state
  per-run read cost SHALL scale with new/changed data, not with total archive
  size, and SHALL surface per-phase timing so the bound is measurable;
  reclaiming operator-visible archive residue SHALL be opt-in, gated on durable
  commit, and never remove data the runtime depends on for resume.

## Impact

- `packages/polyfill-connectors/connectors/slack/index.ts`
- `packages/polyfill-connectors/connectors/slack/parsers.ts` (none expected;
  the change is query-side — listed only if a helper moves)
- `packages/polyfill-connectors/connectors/slack/slackdump-runtime.test.ts`
- `packages/polyfill-connectors/connectors/slack/index.ts` message-query tests
  (new deterministic fixture tests)
- `packages/polyfill-connectors/connectors/slack/README.md`
- `packages/polyfill-connectors/manifests/slack.json` (option documentation, if
  options are surfaced there)
