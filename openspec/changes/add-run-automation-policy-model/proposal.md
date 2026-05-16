## Why

The reference now has schedules, retries, webhooks, run assistance, ntfy, and Web Push, but those mechanisms do not share one owner-facing policy model. Owners need to know whether a run will start unattended, wait for them, or ping them before it runs.

## What Changes

- Define a reference run-automation policy model that treats manual, scheduled, retry, and webhook-triggered runs as one execution path with trigger metadata.
- Add explicit automation modes: unattended, assisted, ask-before-run, and manual-only.
- Define notification policy semantics for action-required versus informational events, per-channel opt-in, quiet-hours suppression, and dashboard-inbox durability.
- Clarify that schedule eligibility is one application of the policy model, not the root concept.
- Keep this as reference-runtime/operator UX semantics, not a Collection Profile requirement.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reference-implementation-architecture`: Add reference run automation, assistance, and notification policy requirements.

## Impact

- Affects schedule creation/projection, scheduler trigger handling, webhook-triggered runs, retry resumption, run-assistance notification fanout, dashboard copy, and future connector manifest policy hints.
- Does not change record/query APIs or root PDPP protocol semantics.
