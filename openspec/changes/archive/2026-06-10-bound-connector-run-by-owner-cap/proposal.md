# Proposal: bound-connector-run-by-owner-cap

## Why

A connector with a serial detail lane and a large history can run for hours.
The ChatGPT detail lane already defers under *source pressure* (a cumulative
429-density stop opens the upstream-pressure circuit once a pressured account
serves enough 429s). But a genuinely **cold** account — 0% 429 — has no such
brake: at ~3 s per conversation, a single run can walk tens of thousands of
conversations for many hours before it finishes. That is safe when an owner is
present and watching; it is the one thing that keeps an unattended owner-gesture
schedule from being defensible, because one nudge can turn into a multi-hour
grind.

The reference already has the right deferral mechanism (resumable `DETAIL_GAP`
records recovered first on the next run) and the right honesty distinction
(source-pressure gaps arm the cross-run cooldown governor; other resumable gaps
do not). What is missing is an owner-configured way to bound a single run by
**size** and/or **time**, independent of source pressure, so the remainder defers
cleanly instead of running to completion. The implementation landed on
`workstream/ri-chatgpt-bounded-run-cap-v1` (commit `65b98f82`); this change is the
OpenSpec record the behavior and its two new env knobs were owed.

This is a Collection Profile runtime behavior — a bounded run that defers a
resumable tail — distinct from source pressure. The
`surface-source-pressure-detail-gap-backlog` change makes *source-pressure*
backlog visible and is reason-scoped to `upstream_pressure` / `rate_limited`; it
must not absorb a self-imposed cap. The missing piece is a narrow
`polyfill-runtime` requirement defining the owner-configured run cap, its
default-off contract, and the rule that a cap deferral is a resumable gap that
does **not** signal source pressure.

## What Changes

- Add a `polyfill-runtime` requirement defining an **owner-configured bounded-run
  cap** on a connector's detail lane: a maximum number of detail fetches per run
  and/or a maximum wall-clock for the detail phase, each opt-in via an environment
  knob and **default off** (unset / non-positive → no cap → behavior byte-for-byte
  unchanged).
- Require the cap to be **run-scoped and shared** across the gap-recovery pass and
  the forward-walk pass of a single run, so a large recovery backlog plus new
  records are bounded *together*, not per-invocation.
- Require a cap trip to **defer the remainder as resumable `DETAIL_GAP` records**
  — the same deferral the source-pressure stop and per-record exhaustion paths use
  — committing the hydrated prefix's cursor so a later run recovers the deferred
  records first and walks forward. A cap can only ever make a run stop *earlier*,
  never fetch more.
- Require a cap deferral to be **decomplected from source pressure**: the deferred
  gaps SHALL carry a resumable wire reason that is *not* in the source-pressure
  reason set, so the deferral does **not** arm the cross-run source-pressure
  cooldown governor and is **not** counted in the source-pressure detail-gap
  backlog rollup. A distinct error class SHALL mark the self-imposed cap so an
  owner surface can render it separately from a busy-service defer.
- Require the wall-clock cap to be checked **between fetches**, so an in-flight
  serial fetch is never interrupted; a cap may therefore be exceeded by at most
  one in-flight fetch (itself bounded by the connector's per-fetch timeout).
- Update the `reference-connection-health` end-user display copy so the generic
  retry-exhausted reason and the configured run-cap error class read distinctly,
  and neither implies the service was busy.

## Capabilities

Modified:
- `polyfill-runtime`

Added:
- None

Removed:
- None

## Impact

- Collection Profile connector runtime and operator/owner display copy only. Does
  not change the public record/query/search/schema/blob `/v1` API, connector
  manifests, run terminal statuses, the scheduler dispatch policy, or the
  Collection Profile JSONL message set.
- No wire-contract change: the resumable wire reason the cap deferral carries
  (`retry_exhausted`) is already in the closed `DETAIL_GAP` reason union; the cap
  reuses the existing deferral, cursor-commit, and recovery machinery.
- Two new environment knobs, both default off. With neither set, a run is
  byte-for-byte unchanged — no cap is consulted and the only stops are the
  existing pressure / exhaustion circuits.
- Composes with `surface-source-pressure-detail-gap-backlog`: that rollup is
  reason-scoped to source pressure and therefore *excludes* a cap deferral by
  construction, which is the intended separation this change makes normative.
- The cap is implemented in the ChatGPT detail lane today; the requirement is
  written connector-agnostically so other serial-detail connectors can adopt the
  same default-off bounded-run contract without a new change.

## Residual Risks

- Owner-only live verification is deferred. The first live attempt
  (`run_1780681611410` on `cin_11deac1e728b244aaeb56765`, June 5, 2026)
  proved the fetch cap stopped after 25 hydrated details and emitted
  `retry_exhausted` / `run_cap_deferred` gaps without source-pressure evidence,
  but exposed the unbounded tail-materialization burn. That defect is now fixed
  by the tested backlog-cursor construction: the ChatGPT suite covers bounded
  tail write count, default-off byte identity, no source-pressure cooldown, and
  multi-run convergence. The remaining live check requires owner credentials and
  a real large/cold ChatGPT account: run with a finite fetch/time cap and finite
  tail-deferral chunk, confirm the run writes at most `chunk + 1` tail gaps after
  the cap trips, does not arm source-pressure cooldown, and the next run expands
  the backlog before forward work. Per `AGENTS.md`, this owner-only live step is
  recorded here rather than holding the implemented change active indefinitely.
