# Connector Failure Diagnostics

Status: decided-promote
Owner: reference-runtime
Created: 2026-04-27
Updated: 2026-04-27
Related: openspec/changes/persist-connector-failure-diagnostics, tmp/connector-failure-diagnostics-memo.md

## Question

What should the reference implementation do when a connector process exits before `DONE` and the runtime had connector stderr available only in memory?

## Context

The investigation memo recorded two recent failures:

| Run | Connector | Terminal reason | Exit | Durable detail |
| --- | --- | --- | --- | --- |
| `run_1777231599663` | YNAB | `connector_exit_without_done` | `1` | no message/stderr |
| `run_1777231731305` | Slack | `connector_exit_without_done` | `1` | no message/stderr |

The runtime captured child stderr into `stderrChunks`, concatenated it in the close handler, and forwarded it only through transient `onProgress({ type: "stderr" })`. The persisted terminal event was built without that evidence, so the owner could not diagnose the failure after the run ended.

The memo also found that direct Slack invocations with and without credentials did not reproduce the same exit-1 path, and that a long-lived dev process unexpectedly lacked `.env.local` variables even though a fresh invocation with the same `--env-file-if-exists=../.env.local` command loaded them. Those observations are retained as evidence, but the root cause is not proven.

## Stakes

The reference implementation exists partly to make protocol and connector behavior inspectable. A run timeline that says only `connector_exit_without_done` when stderr existed in memory fails that standard. The fix must not create a new leak path for credentials, cookies, OTPs, local paths, or upstream payloads.

## Current Leaning

Promote into a focused OpenSpec change:

- Persist a bounded, redacted stderr tail on failed connector exits before `DONE`.
- Add runtime-authored `failure_origin` and `failure_message`.
- Label stderr as connector-authored diagnostic evidence, not the authoritative PDPP error.
- Keep diagnostics owner/control-plane only.
- Defer full log-artifact storage until retention and authorization policy are designed.

## Promotion Trigger

Triggered by the observed YNAB and Slack failures plus the fact that the runtime already had stderr in memory but discarded it before persistence.

## Decision Log

- 2026-04-27: Promoted into `openspec/changes/persist-connector-failure-diagnostics`.
- 2026-04-27: Owner decision is bounded inline diagnostics first; content-addressed log artifacts are deferred.
