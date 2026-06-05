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

## Residual Risks

The adaptive lane utility, the cold-state preflight, the bare-429 fast-open, the burst canary, the lane-governed retry/cursor-boundary semantics, the QoS lane separation, and their deterministic simulator tests are implemented and validated; the seven durable requirements are folded into `reference-implementation-architecture`. The production ChatGPT pilot keeps `maxConcurrency = 1` (unchanged from the serialized baseline). The remaining work is owner-only live verification and an explicit next-tranche deferral, preserved here per the AGENTS.md residual-risk rule (was tasks 5 live pilot / 6 follow-up gate):

- **Cold-state ChatGPT live pilot (owner-only, deferred).** A Docker ChatGPT live pilot with fixture capture, and the comparison of live telemetry against the serialized baseline (no retry exhaustion, no burst above the lane cap, clear cooldown/progress copy, cursor commit on terminal success), must run from a genuinely cold account. The 2026-06-02 probe left the live source bucket throttled, so a clean pilot is not safe to run now without risking escalation on the real account. The fast-open and circuit behavior are proven deterministically; only the live wall-clock and cooldown-copy comparison remain. Not yet run.
- **`maxConcurrency > 1` decision (owner-only, next tranche).** Whether ChatGPT may raise `maxConcurrency` above `1` is a future policy decision that needs a cold-state connector-run A/B. The production default stays `1` until such an A/B clears the bar; the gating mechanism (cold-state preflight + probe knobs) is shipped and makes that A/B safe to run.
- **Next connector candidate (next tranche).** A second connector SHALL be adopted onto adaptive lanes only after its throttle bucket and required/optional stream semantics are explicit. Out of scope for this change.
