# Design

## Goal

Make partial connector runs inspectable and safe to reason about. A run can be useful and incomplete at the same time; the reference should expose that distinction rather than forcing a binary succeeded/failed interpretation.

## Core Concepts

- `SKIP_RESULT`: connector/runtime-declared stream or record-class skip with a bounded reason.
- `known_gaps`: durable summary of what the run did not collect and why.
- recovery contract: a machine-readable hint about whether rerun, credentials, manual action, selector update, or upstream unblock is the next step.

## Boundary

This is initially reference-runtime behavior. If later implementations need interop around partial-run semantics, the relevant parts can graduate into the Collection Profile or a sibling profile.

## Non-Goals

- No silent downgrade of protocol violations.
- No promise that partially flushed data is transactionally complete.
- No generic retry scheduler redesign.

## Acceptance Checks

- Dashboard run detail distinguishes failed, partially complete, skipped, and blocked states.
- Machine-readable timeline payloads expose gap reasons without persisting secrets.
- Record/query surfaces do not imply complete coverage when the latest run has known gaps.
