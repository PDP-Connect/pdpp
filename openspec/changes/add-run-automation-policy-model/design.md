## Context

Recent connector work exposed a design gap around when the reference may start a connector run and when it may interrupt the owner. Schedule safety, ChatGPT app-push assistance, browser-control handoff, retry/backoff, Web Push, ntfy, and source webhooks all touch the same question: "May this run proceed, and may PDPP ask the owner for help?"

The existing pieces are useful but local:

- `capabilities.refresh_policy` gives first-party connector hints.
- Unsafe schedules are gated.
- Eligible automatic connectors can be auto-enrolled.
- Structured run assistance distinguishes owner action from browser streaming.
- Web Push and ntfy can notify the owner.

The missing piece is a small shared policy model. This change does not replace the existing mechanisms; it gives them a common decision vocabulary.

## Goals / Non-Goals

**Goals:**

- Model manual, scheduled, retry, and webhook-triggered runs as one execution path with trigger metadata.
- Make owner interruption explicit and opt-in.
- Preserve dashboard inbox as the durable notification surface.
- Distinguish action-required notifications from informational notifications.
- Keep quiet-hours behavior small and understandable.
- Avoid connector-specific state names and a workflow/rules engine.

**Non-Goals:**

- Do not build custom notification rules, per-day quiet-hour calendars, or a general workflow engine.
- Do not make Web Push, ntfy, or n.eko part of PDPP Core.
- Do not standardize schedule policy in Collection Profile semantics.
- Do not solve connector credential vaulting or durable credential persistence.

## Decisions

### 1. Treat Trigger Kind As Metadata

Run requests have one of four trigger kinds:

- `manual`
- `scheduled`
- `retry`
- `webhook`

The trigger kind affects policy and copy, but it must not create four incompatible execution paths. This preserves a single source of truth for concurrency, readiness, assistance, notifications, and timeline behavior.

### 2. Define Four Automation Modes

The reference should evaluate the connector, deployment, owner preferences, and trigger kind into one of four modes:

- `unattended`: may start in the background and should not need owner assistance.
- `assisted`: may start in the background and may notify the owner if a bounded assistance state appears.
- `ask_before_run`: a schedule or webhook may create intent, but the owner must approve before the connector starts.
- `manual_only`: the run may start only from an owner gesture.

This is more precise than "background_safe" alone while remaining smaller than a policy DSL.

### 3. Keep Assistance Orthogonal

This change depends on the existing structured run-assistance direction:

- progress posture: running, blocked, waiting retry;
- owner action: none, act elsewhere, provide value, operate attachment;
- response obligation: none or response required.

Connector-specific phrases such as `chatgpt_push_pending` or `chase_otp_pending` remain copy/diagnostic details, not policy states.

### 4. Use Two Notification Tiers

Notifications have two tiers:

- `action_required`: the run or connector cannot make useful progress without the owner.
- `informational`: status changes, completion, recovery, first failure, or non-urgent drift.

Dashboard inbox entries are always durable. Web Push and ntfy require explicit opt-in per channel. Informational notifications obey quiet hours. Action-required notifications bypass app-level quiet hours but still respect OS/browser controls and user channel subscription state.

### 5. Keep Quiet Hours Minimal

The reference should support one timezone-aware quiet window. It should not duplicate OS Focus/DND. The copy must make the contract explicit: informational events wait; action-required events may still notify if the owner opted into that channel.

### 6. Preserve Existing Gating

Existing unsafe-schedule and runtime-readiness gates remain valid. This change reframes them as policy evaluations:

- unsafe automatic schedule -> not eligible or ask-before-run/manual-only;
- missing runtime prerequisite -> not-ready skip for automatic triggers;
- manual run -> allowed to surface the real connector/runtime failure path.

## Risks / Trade-offs

- [Risk] The model becomes a policy DSL.
  - Mitigation: only four automation modes, two notification tiers, and one quiet window.
- [Risk] Action-required notifications become noisy.
  - Mitigation: require per-channel opt-in and classify notifications from structured assistance/failure state, not connector strings.
- [Risk] Ask-before-run adds complexity before it is needed.
  - Mitigation: implement only where a scheduled/webhook run would otherwise predictably interrupt or fail; manual-only remains valid for high-friction connectors.
- [Risk] Existing schedule behavior diverges during migration.
  - Mitigation: keep current gates and add policy projection before changing scheduler execution.

## Migration Plan

1. Add policy projection helpers that classify connector/run requests without changing scheduler behavior.
2. Surface the projected mode and notification implications in schedule/dashboard APIs.
3. Add notification preference and quiet-window storage only after the projection semantics are proven.
4. Route scheduled, retry, and webhook triggers through the same policy check before starting a connector.
5. Keep manual runs as the escape hatch that surfaces the connector's honest live behavior.
