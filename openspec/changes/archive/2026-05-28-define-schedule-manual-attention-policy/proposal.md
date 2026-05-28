## Why

The reference scheduler currently risks treating every due tick as an obligation to start another run, even when the last attempt proved that an owner or operator must intervene first. That can create retry noise, unclear freshness claims, and repeated doomed attempts for browser or account-gated connectors.

PDPP needs a small SLVP policy that separates desired freshness, bounded run attempts, durable manual-attention state, notification delivery, and schedule suppression.

## What Changes

- Define schedules as desired freshness and launch eligibility, not guarantees that every tick creates a run.
- Define runs as bounded attempts that can end in a typed manual-attention state without remaining active forever.
- Introduce a durable `attention_request` contract keyed to connection/source/run context.
- Require notification state, quiet-hour/suppression metadata, and a safe resume path for attention requests.
- Require per-connection pause or suppression of repeated automatic attempts while attention remains unresolved.
- Keep local collectors and host supervisors separate from server schedule control.

## Capabilities

### Modified Capabilities

- `reference-implementation-architecture`: define schedule/manual-attention policy for the reference implementation.

## Impact

- Affects reference scheduler, run state, owner-attention, and freshness semantics.
- Does not require package publishing, PWA, local collector runner, or host supervisor changes in this design-only tranche.
- Future implementation will need storage/API/test updates to make the policy executable.
