## Why

Connector runs can require owner help for reasons that are not equivalent: app approval, OTP entry, browser control, retry/backoff, and blocked challenges need different UX and runtime behavior. The reference currently overuses `manual_action` and `PROGRESS`, which creates confusing prompts and makes browser streaming appear intrinsic to human assistance.

## What Changes

- Define a reference-only run-assistance contract that separates progress posture, owner action, response obligation, attachments, sensitivity, and durability.
- Keep browser streaming as an optional attachment to assistance, not the meaning of assistance itself.
- Clarify which parts are Collection Profile candidates versus reference-runtime/operator UX behavior.
- Provide UI semantics for each assistance shape so dashboard copy and controls are derived from structured state instead of connector-specific guesses.
- Preserve existing `INTERACTION` compatibility during migration while giving new code a cleaner target.

## Capabilities

### New Capabilities

- `reference-run-assistance`: Reference runtime contract for owner-assistance states, attachments, privacy, and operator UX semantics during connector runs.

### Modified Capabilities

- `reference-implementation-architecture`: Clarify that run assistance is reference-only until promoted into Collection Profile semantics, and that browser surfaces are optional assistance attachments rather than a generic interaction requirement.

## Impact

- `packages/polyfill-connectors/src/connector-runtime.ts` interaction/progress emission boundary.
- `reference-implementation/server/**` run timeline, interaction handling, and reference-only mutation routes.
- `apps/web/src/app/dashboard/**` run timeline and assistance UX.
- `packages/remote-surface/**` only as an optional browser-surface attachment provider.
- OpenSpec design for future Collection Profile alignment.
