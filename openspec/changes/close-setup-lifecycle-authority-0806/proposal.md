## Why

The static-secret setup projection currently treats every terminal zero as the
same outcome, reads terminal evidence by an unscoped `run_id`, and leaves a
draft's terminal setup result indistinguishable from setup that has not run.
Those seams allow a sibling connection's run to leak into the status page and
make Dashboard, Sources, and Syncs disagree about a completed zero-yield setup.

## What Changes

- Make one pure setup terminal-disposition projection over connection-scoped
  `run_history` and canonical `collection_facts`, distinguishing verified empty,
  unverified zero, and missing counts.
- Preserve count-presence evidence in the existing bounded `facts_json` payload
  so a missing runtime count is not rewritten as a proven zero.
- Resolve setup terminal evidence by `(connector_instance_id, run_id)` when a
  run is requested and by the latest product `run_history` row for the owner
  connection when no run id is supplied.
- Carry the resulting connection-scoped disposition into the existing summary
  contract and shared owner actionability projection. Drafts remain visible for
  setup review but never become active or scheduled from a zero-yield result.
- Add deterministic regression coverage for valid-empty, silent-zero,
  missing-count, duplicate-run-id isolation, run-id-less revisit, and
  cross-surface zero-yield behavior.

## Capabilities

Modified:

- reference-connection-health
- reference-implementation-runtime

## Out of Scope

- No new lifecycle storage or parallel state model.
- No aggregate-count inference in place of canonical collection facts.
- No run admission, catalog, schedule activation, deployment, live mutation,
  push, or PR.
