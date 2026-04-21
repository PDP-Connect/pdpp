# Control plane v1 follow-up

**Status:** resolved
**Date:** 2026-04-19

## Purpose

Capture the first implementation-review findings for the control-plane v1 so the next agent can fix the remaining correctness gaps without re-deriving them from chat history.

This note does not reopen the control-plane product shape. It is a narrow follow-up on implementation correctness and IA consistency.

## Required follow-up

1. Align the dashboard timeline client/server envelope shape. — **done**
   - The `_ref` timeline envelope returns events under `data`; the dashboard ref-client now normalizes that payload to a typed `events` field while leaving the server/CLI contract unchanged.

2. Normalize grant worklist status semantics to lifecycle states. — **done**
   - `listSpineCorrelations('grant', …)` derives a grant lifecycle status (`revoked` > `denied` > `failed` > `issued` > `pending`) from the event history instead of surfacing the last raw event status.

3. Keep the shared operator shell on nested Records routes. — **done**
   - Every nested `/dashboard/records/...` page renders inside `DashboardShell` so the left rail, command palette, and navigation model stay consistent with the rest of the console.

4. Complete the reference-server-unreachable fallback on Records routes. — **done**
   - Manifest loads are inside the same `try`/`catch` as downstream detail reads on `/dashboard/records` and `/dashboard/records/[connector]`, so the degraded `ServerUnreachable` UI covers the manifest fetch path as well.

## IA consistency cleanup (2026-04-19)

A second pass resolved the `Data` vs `Search` naming confusion:

- the `Data` section is renamed to `Records`
- connector/stream/record browsing moved from `/dashboard/data` to `/dashboard/records`
- the standalone `/dashboard/timeline` route is folded under `/dashboard/records/timeline` so there is no parallel top-level timeline surface
- redirects from `/dashboard/data/...` and `/dashboard/timeline` preserve existing deep links
- `Search` remains the single cross-artifact jump surface for request/trace/grant/run ids and text search

## Non-goals

- no new mutation/control features
- no new product-shape redesign
- no reopening of the local-first or inspection-first control-plane contract
