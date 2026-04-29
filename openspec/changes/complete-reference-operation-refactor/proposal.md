## Summary

Finish the reference-operation refactor by moving the remaining protocol and
operator route semantics out of `reference-implementation/server/index.js` and
behind canonical operation modules or explicit capability-shaped adapters.

## Motivation

Most public RS reads and `_ref` reads now use canonical operation modules. The
remaining inline route families still mix HTTP wiring with protocol semantics,
storage calls, OAuth/consent state transitions, blob visibility, and mutation
rules. This keeps the reference server difficult to audit and makes future
runtime portability work harder than necessary.

## Scope

This change covers the final remaining route families:

- AS OAuth/device/consent/grant/DCR/PAR routes.
- `_ref` diagnostics: records timeline, deployment, clients.
- RS public search routes: lexical, semantic, hybrid.
- RS blobs: upload and read.
- RS record mutations: bulk delete, single delete, ingest.
- RS connector state.
- RS discovery/root routes.

## Non-Goals

- No public protocol behavior changes.
- No intentional error-envelope changes.
- No intentional spine/disclosure event-ordering changes unless explicitly
  documented in the owning worker report and pinned by tests.
- No generic repository abstraction, Kysely migration, or runtime Postgres
  implementation.
- No direct worker merges to `main`.
