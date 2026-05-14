# Bounded Run Checkpoints And Rate-Limit Retry

Status: sprint-needed
Owner: reference implementation maintainer
Created: 2026-05-13
Updated: 2026-05-14
Related: `openspec/changes/add-polyfill-connector-system/design-notes/partial-run-semantics-open-question.md`, `openspec/changes/add-polyfill-connector-system/design-notes/cursor-finality-and-gap-awareness-open-question.md`, `openspec/changes/add-polyfill-connector-system/design-notes/gap-recovery-execution-open-question.md`, `reference-implementation/runtime/index.js`

## Question

Should a bounded collection run durably advance stream cursors multiple times inside one run, or should recoverable upstream failures such as HTTP 429 be handled by keeping the run alive until it can complete?

## Context

`run_1778641079040` authenticated to ChatGPT, flushed thousands of records, staged stream state, then failed on a recoverable `429` while fetching a conversation. The run's records were durable, but `checkpoint_commit_status` was `not_committed` and `state_streams_committed` was `0`.

The current reference runtime intentionally distinguishes two phases:

- `STATE` during the run flushes records for that stream and records `run.state_staged`.
- Durable state advancement happens after `DONE(status="succeeded")`, when the runtime commits the latest staged cursor per stream.

That means a connector may emit multiple `STATE` messages during a run, but a failed run does not durably advance the cursor. This is aligned with the bounded-run invariant that failed or cancelled runs must not skip data on retry.

## Stakes

Mid-run durable checkpoints could reduce duplicate work after failures, but they create a harder correctness problem: once a cursor advances, retrying the failed run may skip records that were not actually collected or flushed. That would undermine owner trust more than duplicate idempotent upserts.

Large browser/API connectors still need better resilience. A single cooldown-level `429` should not turn a minutes-long successful collection into a failed run with no checkpoint commit.

## Current Leaning

Do not introduce sub-run durable cursor advancement for this ChatGPT issue.

Instead, add a shared connector-side retry/backoff helper for recoverable upstream throttling:

- Respect `Retry-After` when the upstream exposes it.
- Use jittered exponential backoff when it does not.
- Support a long enough retry budget for large first runs.
- Pair retry with source-specific pacing/concurrency limits so the connector does not create multiple concurrent retry loops against one account-level throttle bucket.
- Emit progress/telemetry so the owner sees "waiting for rate limit" rather than a stuck run.
- Keep retry policy local to the connector/runtime package; it does not change the Collection Profile wire format.
- Let terminal failure remain terminal when the retry budget is exhausted.

This preserves the bounded-run invariant while making recoverable throttling non-terminal in normal operation.

For ChatGPT specifically, the immediate reference-connector posture is conservative: serialize `/conversation/{id}` detail fetches and add jittered inter-request delay before considering any adaptive parallelism. The old connector used parallel detail fetches and silently tolerated failed details; the current connector surfaces failures correctly, so it must also lower request pressure rather than repeatedly driving the same hot rate-limit bucket.

## Deferred Alternative

Sub-run checkpoints, partial-success checkpoints, or resumable segments remain a valid future direction for very large sources. They should not be introduced as an incidental bug fix. They would need an explicit OpenSpec change that answers:

- Whether a run is divided into named durable segments.
- Whether each segment has its own success/failure state.
- Whether segment commits are visible to owners and downstream clients.
- How a failed later segment avoids hiding earlier missing records.
- How checkpoint commit interacts with `SKIP_RESULT`, known gaps, and targeted recovery.
- Whether the behavior is a reference-only optimization or a Collection Profile requirement.

## Promotion Trigger

Promote the deferred alternative to an OpenSpec change if duplicate idempotent reprocessing after failed runs becomes materially expensive even after connector-side backoff, or if a connector needs to collect from a source where re-reading already-flushed data is infeasible.

Promote the immediate retry utility to an OpenSpec change only if it changes the JSONL protocol, connector manifests, run terminal statuses, or reference scheduler semantics. A shared library helper for HTTP retries does not need spec treatment.

## Decision Log

- 2026-05-13: Captured after ChatGPT `run_1778641079040`. Decision: fix `429` as connector-side recoverable backoff first; do not weaken bounded-run cursor finality.
- 2026-05-14: Clarified that retry/backoff is not enough by itself for ChatGPT. Immediate fix includes source-specific pacing: one detail request at a time with jittered delay. This is still not sub-run checkpointing, partial-success checkpointing, or resumable segment semantics.
