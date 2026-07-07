## Design

The source-control surface has two separate failure modes.

First, browser assistance already has the correct authority split: the run route resolves a browser-surface target from the active lease, then the streaming companion consumes that target. The bug is an implementation seam: the TypeScript default companion factory drops the explicit `target` and falls back to the legacy registry resolver. The fix is to make the default factory input contract match the route's call shape and prefer the explicit target when present. This keeps the existing lease-scoped approval checks and avoids adding connector-specific repair logic.

Second, source summary evidence is maintained as a dirty/reconciled read model, but source-list reads must not render known-dirty evidence as if it were current. The list and detail routes already own the owner-facing source projection boundary, so they are the right place to trigger bounded dirty reconciliation before rendering.

For per-stream coverage unknown/count-unavailable states, the durable SLVP direction remains the evidence-strategy contract already present in code: every stream should either emit coverage/freshness facts or declare a precise accepted policy. This change does not complete that connector-wide backfill. It prevents the current UI from making missing evidence sound like active checking and leaves the larger connector instrumentation pass as the next explicit tranche.

## Alternatives

- Start a new ChatGPT-specific repair flow: rejected. The stream failure is connector-neutral browser-surface plumbing; a ChatGPT patch would preserve the seam.
- Hide "Coverage unknown" in the UI: rejected. It would make incomplete evidence less visible without making the instance healthier.
- Rebuild all summary evidence periodically only: rejected as insufficient. Owner reads should reconcile dirty rows before presenting them, even if a background worker also exists.

## Acceptance Checks

- A no-response browser-surface assistance request backed by a ready lease opens through the production default factory without consulting the legacy registry resolver.
- Dirty connector summary evidence is reconciled before `/ _ref/connectors` list/detail output is built.
- Owner-facing stream count copy no longer implies an active collection count check when the only known fact is missing count evidence.
