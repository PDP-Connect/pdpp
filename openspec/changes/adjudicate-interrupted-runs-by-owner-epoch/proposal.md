## Why

A run interrupted by container replacement never received an honest terminal
state, and the mechanism built to give it one was silently disabled.

`resolveControllerId` fell back to `os.hostname()`, which under Docker is the
container id and is fresh on every `docker run`. `PDPP_CONTROLLER_ID` is unset
in production, so the boot reconciler's ownership filter
`COALESCE(data_json->>'controller_id', $2) = $2` excluded every prior
container's orphans — a lost-and-found that only accepted items it had lost
itself. Production holds 1,231 `controller.booted` events across 1,153 distinct
controller ids; the one host with a stable id (`peregrine`, non-Docker, 18 boots
under one id) is the only place the mechanism ever worked.

The measured cost: 121 `run.started` events spanning 2026-05-15 to 2026-07-10,
across 106 distinct controller ids, carried no terminal event of any kind. A
second, cruder path picked up part of the slack with the wrong vocabulary —
of 134 runs it recorded as `run.failed`/`controller_restarted`, 55 had staged a
cursor and 34 had durably ingested a batch first. Those were interruptions
recorded as failures, and the two states have different remedies: `failed` on a
bank connector means ask the human, `abandoned` means nobody knows and the
normal schedule will pick it up.

The shipped 5s SIGTERM drain cannot close this. Production sets no
`--stop-timeout`, so Docker's 10s default governs, and only 2 of 17 connectors
finish inside 10s at p95. It was observed in production logging
`{"drained":0,"elapsedMs":5000,"timedOut":1}` — burning its whole budget and
abandoning the run anyway.

## What Changes

- Make controller identity durable in a `controller_identity` row, seeded from
  the hostname on the first boot that finds the table empty and read back
  unchanged thereafter, so a successor container inherits the ownership filter
  that lets it adjudicate its predecessor's orphans. `PDPP_CONTROLLER_ID` still
  wins when set. The boot epoch still advances per boot.
- Stop recording interrupted runs as failures. The controller path no longer
  emits `run.failed`/`controller_restarted`; it retains only its stale-claim
  release, renamed to say what it does. The boot reconciler becomes the single
  writer of an interrupted run's terminal state.
- Delete the connector drain from the SIGTERM path. `drainActiveRuns` stays on
  the controller, where it means "await in-flight runs" — 136 of its 137
  references carry that meaning and keep working.
- Fence in-flight manual-upload artifacts by owner epoch instead of the
  10-minute `MANUAL_UPLOAD_IN_FLIGHT_STALE_MS` wall clock. This requires adding
  an `owner_epoch` column to `manual_upload_artifacts`, which did not exist.
- Add an owner-operated repair tool that adjudicates the already-stranded
  backlog, dry-run by default, with pre-image snapshots taken inside the write
  transaction.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reference-implementation-architecture`: Define durable controller identity,
  the successor-adjudicates ownership rule and its newest-epoch exclusion, the
  single-writer rule for an interrupted run's terminal state, epoch-fenced
  in-flight artifact sweeps, and the absence of a shutdown-path drain.

## Impact

- `reference-implementation/lib/controller-boot.ts`,
  `runtime/controller.ts`, `server/index.ts`,
  `server/stores/manual-upload-artifact-store.ts`,
  `server/routes/ref-manual-upload-draft-connection.ts`
- New `controller_identity` table and additive `manual_upload_artifacts.owner_epoch`
  column on SQLite and PostgreSQL. Both are NULL-tolerant, so existing databases
  migrate without a backfill.
- New owner-only repair script
  `reference-implementation/scripts/repair/adjudicate-orphaned-runs.ts`.
- Shutdown is faster and its failure mode is honest. Interrupted runs terminalize
  as `abandoned` at the next boot rather than as `failed` or not at all.
- Does not change record ingestion, checkpoint commit, or any connector.

## Non-Goals

- **Committing staged cursors under interruption.** The research entry gated
  this on whether connectors emit bounded `DETAIL_COVERAGE` with
  `covered == considered` and a non-null boundary. Measured on the live spine,
  the answer is no: zero of 34,928 `run.detail_coverage_declared` events carry
  `boundary`, `slice_start`, or `slice_end`. Committing staged cursors under an
  interrupted terminal state would fabricate denominators, so it is out of scope
  until that evidence exists.
- **The checkpoint-contract / interval-claim design.** A prototype did not
  survive contact with 2 of 3 connectors: `heb`'s `YYYY-MM-DD` cursor cannot
  express a within-day position, and `slack` has no `ORDER BY` and records its
  watermark before the emission guard, so an interval over that input would be a
  more confident falsehood. Not ready for OpenSpec.
- **Any Node version change.**
- **Auto-resume or auto-retry of interrupted runs.** `chase`, `usaa`, `venmo`,
  `heb`, `amazon`, and `reddit` need an interactive human sign-in; adjudication
  is silent by design and lets the normal schedule pick the work up.

## Residual risks

- Owner-authorized live verification remains: after one deploy in a replaced
  container, a `SIGKILL` mid-run should produce exactly one terminal event for
  that run and it should be `run.abandoned`. This is live-environment
  verification, not an implementation task.
