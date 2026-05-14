# Proposal: add-connector-adaptive-lanes

## Why

Large polyfill connectors can over-pressure upstream private or account-scoped endpoints when fixed concurrency, per-request retries, and opaque rate limits interact. ChatGPT conversation detail collection exposed this failure mode: bounded-run cursor finality was correct, but concurrent retry loops made a recoverable throttle likely to exhaust the run.

## What Changes

- Add a reusable connector-runtime adaptive lane utility for outbound upstream work.
- Model one lane per upstream throttle bucket, with bounded concurrency, bounded queueing, inter-launch pacing, retry feedback, `Retry-After` handling, cancellation, deterministic tests, and progress/telemetry hooks.
- Keep cursor advancement and bounded-run terminal semantics outside the lane utility.
- Pilot the utility on ChatGPT conversation detail fetches without raising pressure above the current serialized posture until live evidence supports it.

## Capabilities

Modified:
- `reference-implementation-architecture`

## Impact

- Affects `packages/polyfill-connectors/src/**` shared connector helpers.
- Affects ChatGPT connector detail-fetch orchestration as the first pilot.
- Does not change Collection Profile JSONL messages, connector manifests, run terminal statuses, or public PDPP protocol semantics.
