## Context

`tmp/workstreams/refactor-operation-mount-inventory-report.md` identified connector catalog and approvals reads as Batch B: medium value, medium risk. The prerequisite store extraction has landed, so approvals can depend on injected consent/device read dependencies instead of reaching directly into route-local auth internals.

## Decision

Create operation modules under `reference-implementation/operations/` for:

- `ref-connectors-list`
- `ref-connectors-detail`
- `ref-approvals-list`

Each operation SHALL own request normalization, response shaping, and typed error behavior. Host adapters SHALL inject data dependencies and remain responsible for Fastify auth/session gates and HTTP-specific headers.

The operation modules SHALL pass the shared operation-boundary gate: no Fastify, Next, SQLite, `getDb()`, `server/auth.js`, process/env, or direct route imports.

## Stop Conditions

Stop for owner review if the implementation:

- changes existing `/_ref/connectors`, `/_ref/connectors/:connectorId`, or `/_ref/approvals` response shapes;
- weakens owner-auth gating or CSRF behavior;
- moves auth mutation flows (`/consent`, `/device`, revoke, introspect, DCR) into this change;
- imports SQLite/auth internals directly from operation modules;
- overlaps with spine timeline operation work.

## Acceptance Checks

- Existing connector and approval route tests remain green.
- New operation-boundary tests cover all three modules.
- `ref-read-owner-gate` remains green.
- Consent/device conformance remains green for approval read prerequisites.
