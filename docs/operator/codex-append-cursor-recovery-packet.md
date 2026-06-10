# Codex append-cursor migration — operator recovery packet

This packet is the owner-only procedure for restarting the Codex local collector
after the append-safe rollout cursor fix
(`openspec/changes/add-codex-append-rollout-cursor`). It exists because the fix
changes the rollout source cursor, and the live Peregrine Codex source still has
only the **legacy `file_mtimes`** cursor for its long-lived active rollout file —
so the first run after deploy will reparse that file once.

Read this before restarting `pdpp-codex-collector.timer`.

## Command prerequisite

Every command below uses `pdpp-local-collector`, which already emits JSON for
`status`, `doctor`, and `run`; do not add `--format json` (the CLI has no such
flag).

Use a collector binary that contains the append-safe Codex cursor fix:

- after publishing this commit to npm beta, use `npx -y @pdpp/local-collector@beta`;
- on a repo-dist-override host, use the deployed repo binary instead, for example
  `node /home/user/code/pdpp/packages/local-collector/dist/local-collector/bin/pdpp-local-collector.js`.

If `doctor` reports a stale published package or a repo checkout that does not
contain this commit, stop and update the collector before continuing.

In the snippets below, replace `npx -y @pdpp/local-collector@beta` with the
repo-dist command when the beta package has not yet been published from this
commit.

## 0. The one rule

Do not delete unsent outbox rows unless this packet proves they are duplicate
(server-noop on send) or you have a verified backup. Draining is always
preferred over deleting; deleting is only an optional throughput shortcut once
the rows are proven duplicate.

## 1. TL;DR for the owner

- The one-time reparse of the 1.3 GB active rollout **is unavoidable at the
  connector level** — legacy `file_mtimes` stores no byte offset, so there is no
  way to know where the previous emit stopped without reading the file again.
- The reparse **is harmless**: the server ingest **noops byte-identical
  re-emits**, so re-sending already-durable records creates **zero new versions,
  zero churn, zero corruption** — and it still **recovers** any never-emitted
  tail (genuinely new lines are not identical → they ingest normally).
- The only real cost is **throughput / backlog pressure**: one burst of up to
  ~177k record sends that mostly resolve to server noops, plus the existing
  leftover outbox backlog from the pre-fix run.
- The backlog guard already on `main` makes the restart safe regardless: the
  runner drains existing backlog **before** it scans, and skips scanning while
  backlog is over the ceiling. You cannot pile a fresh re-scan on top of an
  undrained backlog.

So: this is an operational drain, not a data-integrity event. The procedure
below drains it safely and bounds the burst.

## 2. Why the replay is unavoidable (connector-level proof)

The legacy cursor shape is `state.<stream>.file_mtimes: { <path>: mtimeMs }`. It
records only *that a file was fully parsed when its mtime was X* — never the byte
offset or line count where emission stopped. The fix's rich cursor
(`file_cursors`) carries `offset_bytes` / `line_count`, but no legacy state can
be losslessly upconverted to it:

- If a legacy file's mtime is **unchanged**, its entire current content was
  already emitted, so it is simply skipped (no replay, and it upgrades to a rich
  cursor the next time it is genuinely touched). The ~1,498 dormant rollout files
  are in this bucket — they cost nothing.
- If a legacy file's mtime **changed** (the active Peregrine rollout), there is
  an unemitted tail of unknown size between the last-parsed EOF and now, and the
  byte boundary of that tail is **not recoverable** from `file_mtimes`. The only
  correct action is to reparse the file in full and let the server deduplicate
  the already-emitted prefix.

A "prime the cursor at EOF without emitting" shortcut was explicitly **rejected**:
without a recoverable boundary it would skip the unemitted tail and silently lose
data. The idempotent full reparse has no such risk.

## 3. Why the replay is harmless (server-noop proof)

The reference ingest treats a re-emit of a record whose `(connector_instance_id,
stream, record_key)` already holds **byte/semantically-identical JSON** as a
no-op — it allocates no new version and writes no change row.

- SQLite backend — `reference-implementation/server/records.js:311`:
  ```js
  if (op !== 'delete' && current && !current.deleted && current.record_json === recordJson) {
    return { kind: 'noop' };
  }
  ```
- Postgres backend (the live Peregrine backend) —
  `reference-implementation/server/postgres-records.js:765,776`:
  ```sql
  ($4::jsonb IS NOT DISTINCT FROM record_json) AS is_identical
  ```
  ```js
  if (op !== 'delete' && current && !current.deleted && current.is_identical) {
    return { kind: 'noop' };
  }
  ```
  `jsonb IS NOT DISTINCT FROM` is semantic JSON equality, robust to `::text`
  formatting differences (see the comment block above it).

Codex rollout records are keyed `${sessionId}:${lineCount}` (+`:output`) and
their content is derived from immutable source lines, so a replayed record is
byte-identical to its original emission → **noop**. Already-durable history
(through the last successful checkpoint at ~19:29Z) noops; only genuinely-new
lines past that point ingest as real records. The replay is therefore both
**lossless** (recovers the never-emitted tail) and **idempotent** (no churn on
the durable prefix).

## 4. The existing outbox backlog (ready/pending rows from the pre-fix run)

The pre-fix full-reparse run left ready/pending `record_batch` rows in the local
device outbox. Classify and handle them as follows.

### 4.1 Inspect (no mutation)

```sh
# On the Peregrine host that owns the Codex outbox. Read-only.
npx -y @pdpp/local-collector@beta status \
  --connector codex \
  --base-url "$PDPP_BASE_URL" > /tmp/codex-outbox-status.json
# `status` reports: outbox.counts (ready/pending/retrying/dead_letter/leased/
# total), lifecycle_state, coverage, and deployment_posture/version. It does
# NOT include the STATE cursor summary — `file_cursors_count` is surfaced by a
# `run` invocation's JSON (flushedState/priorState.streams.messages), used in §5.
```

Also capture a durable backup of the outbox before any deletion:

```sh
# retry-dead-letters --apply already backs up via VACUUM INTO; for a plain
# backup of the whole outbox before manual deletion, copy the sqlite file:
cp "$PDPP_COLLECTOR_QUEUE" "$PDPP_COLLECTOR_QUEUE.pre-codex-cursor-backup"
```

### 4.2 Acceptance criteria — which rows are safe to drain, delete, or escalate

| Row class | Disposition | Why |
|---|---|---|
| `ready` / `pending` `record_batch` for `codex` `messages`/`function_calls`/`sessions` | **Safe to drain** (preferred). They re-send as server noops if already durable, or ingest the real tail if new. **Safe to delete** only after the drain proves they are noops, or if you accept re-deriving them from the next reparse (which will re-emit the same keys). | Records are keyed by `${sessionId}:${lineCount}`; the next reparse re-emits the identical keys, so anything dropped here is reproduced and de-duplicated on the server. |
| `dead_letter` rows | **Escalate to `retry-dead-letters` first** (dry-run, then `--apply`). Do **not** delete blind. | A dead letter may carry a redacted cause (e.g. `400 invalid_request`) that indicates a real ingest problem, not a duplicate. See `retry-dead-letters` in the runbook. |
| `leased` rows older than the lease TTL | **Leave** — `recoverExpiredLeases` reclaims them on the next run. | The runner reclaims stale leases automatically at the top of `run`. |
| Any non-`codex` source rows | **Do not touch** in this lane. | Out of scope; this packet is Codex-only. |

**Safe-deletion bar (must all hold):** the row is a `codex` `record_batch`, you
have the `.pre-codex-cursor-backup` copy, and you accept that the next reparse
re-emits the same keys (server-deduplicated). If any of these is false → **drain,
do not delete**. If a row is a dead letter with a non-duplicate cause → **escalate
to manual review**, do not drain or delete.

## 5. Restart procedure (exact commands)

The backlog guard makes the order safe automatically, but run these explicitly so
the burst is observed and bounded.

```sh
# 0. Confirm the deployed package contains the append-safe cursor fix.
#    `doctor` reports the deployment posture + collector version (not the cursor
#    summary — that comes from `run` in steps 2-3).
npx -y @pdpp/local-collector@beta doctor --connector codex --base-url "$PDPP_BASE_URL" \
  | grep -E '"deployment_posture"|"version"|"is_placeholder_version"'

# 1. Drain-only passes FIRST (timer still stopped). Each `run` drains existing
#    backlog before it scans; while backlog is over the ceiling the connector is
#    NOT spawned (skippedScanForBacklog=true), so no fresh re-scan piles on.
#    Repeat until status shows ready/pending at/near zero.
npx -y @pdpp/local-collector@beta run --connector codex --base-url "$PDPP_BASE_URL" \
  | grep -E '"skippedScanForBacklog"|"sentBatches"|"recordsQueued"|"outboxSummary"'

# 2. Once backlog is drained, the next `run` actually scans with the fixed
#    connector. THIS is the one-time reparse of the active rollout: expect a
#    large recordsQueued (up to ~177k) that drains as mostly server noops, then a
#    rich `file_cursors` entry is written for the active file.
npx -y @pdpp/local-collector@beta run --connector codex --base-url "$PDPP_BASE_URL" \
  | grep -E '"recordsQueued"|"file_cursors|"statePutFailed"'

# 3. Confirm the rich cursor landed and the next run TAILS (no full reparse).
#    A subsequent run with no new Codex activity must show recordsQueued≈0 and a
#    file_cursors_count covering the active file.
npx -y @pdpp/local-collector@beta run --connector codex --base-url "$PDPP_BASE_URL" \
  | grep -E '"recordsQueued"|"file_cursors_count"'

# 4. Only after step 3 shows a tailing steady state, restart the timer.
systemctl --user start pdpp-codex-collector.timer    # (or the owner's timer unit)
```

### Bounding the burst (optional)

If the ~177k single-burst send is undesirable on the live link, lower the outbox
queue-depth ceiling for the reparse pass so the runner drains in bounded
tranches across several invocations rather than one burst (the backlog guard then
spreads the work). Restore the default ceiling after the active file is on a rich
cursor. This is throughput shaping only — it does not change correctness.

## 6. Acceptance — what proves the restart succeeded

1. A `run` invocation's cursor summary reports `file_cursors_count >= 1` for the
   active rollout path's stream (rich cursor established). `status` does not
   include STATE cursor summaries.
2. A no-new-activity `run` reports `recordsQueued` ≈ 0 for `messages` /
   `function_calls` (the connector is now tailing, not reparsing).
3. Server record versions for the replayed session did **not** balloon: the
   replay resolved to noops (spot-check a few `${sessionId}:<line>` keys —
   their `version` did not advance by the full replay count).
4. `dead_letter` count did not grow from the replay (idempotent noops do not
   dead-letter).
5. Outbox `ready`/`pending` returns to a steady drained state between runs.

## 7. What is NOT in this lane

- No retention/compaction of already-emitted Codex rows — that is disk hygiene,
  a separate lane. Deleting sent rows does not fix the cursor and is not required
  here.
- No server-side migration — the server contract is unchanged (STATE cursors are
  opaque to the server; only the connector's cursor shape changed).
- No change to other connectors.

## 8. Why no `--prime-cursors` command was added

A connector mode that establishes rich cursors at EOF **without** emitting
records was considered and rejected: for the active file (mtime changed) it would
skip the unemitted tail and silently lose data, because legacy state has no
recoverable boundary. The idempotent full reparse (§2–§3) is strictly safer — it
recovers the tail and de-duplicates the prefix — at a bounded one-time throughput
cost that §5 manages. Adding a lossy shortcut to avoid a harmless drain would be a
net regression in safety.

## Related

- `openspec/changes/add-codex-append-rollout-cursor/` — the change.
- `docs/operator/local-collector-runbook.md` — backlog guard, `retry-dead-letters`,
  persistent-state guidance.
- `reference-implementation/server/records.js` /
  `reference-implementation/server/postgres-records.js` — the byte-equivalence
  noop that makes the replay harmless.
