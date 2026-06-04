# add-operator-stream-reach-diagnostics

## Why

When the operator opens a run-interaction browser stream and the client's SSE
attach loop exhausts its retries, the console shows one generic give-up message
("Couldn't reach the browser stream after several tries.") with `cause: network`.
The browser's `EventSource` collapses every pre-attach HTTP failure — `401
invalid_token`, `409 session_consumed`, `410 session_expired`, `410
companion_unavailable` — and every raw connect failure into a single
payload-less `error` event with no status code. So neither the operator message
nor the event spine records *which* failure class caused the give-up. Every
occurrence of this class becomes a manual triage with no machine-actionable
reason, as the `ri-browser-stream-regression-v1` investigation documented.

## What Changes

- On give-up, the stream viewer issues one lightweight typed status probe
  (`GET` against the same token-scoped viewer URL) to read the actual HTTP
  status the `EventSource` hid, then classifies the give-up into a typed reason
  and surfaces a specific operator message instead of the generic one.
- A pure, replayable classifier maps the probe result (HTTP status, error code,
  or raw fetch failure) to one typed reason in a closed set.
- The reference emits a bounded, secret-free `run.stream_reach_failed` spine
  event carrying the typed reason and HTTP status so the give-up is auditable
  from the run timeline.
- A new owner-authenticated reference route accepts the give-up beacon, validates
  it against the current run/interaction, sanitizes the reason to the closed set,
  and emits the spine event. The beacon never carries the token, cookies, or raw
  URLs.

This does not change n.eko allocation, browser runtime behavior, the streaming
session lifecycle, or the attach/retry/re-mint state machine. The probe runs
only after the existing give-up condition is already reached.

## Capabilities

### Modified

- `reference-implementation-architecture` — adds give-up diagnostic classification
  and the `run.stream_reach_failed` spine beacon to the existing streaming
  companion requirements.

## Impact

- New reference route `POST /_ref/runs/:runId/run-interaction-stream/reach-failure`
  (owner-authenticated, emits `run.stream_reach_failed`).
- New spine event type `run.stream_reach_failed`.
- Stream viewer give-up path gains one status probe and one best-effort beacon
  call. No change to mint, attach, input, viewport, or n.eko proxy routes.
