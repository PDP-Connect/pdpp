## Why

The current `/sandbox` is a useful static walkthrough, but it does not provide the reviewer experience we actually need: a hosted, credential-free reference instance that feels like the real dashboard and exposes callable AS/RS-shaped APIs. Internal reviewers, implementers, and agents should be able to explore PDPP end to end without Docker, `.env.local`, connector auth, or private owner data.

## What Changes

- Add a public mock reference demo instance under `/sandbox/**` that is backed by deterministic fictional AS/RS state rather than the live reference server.
- Provide dashboard-compatible demo pages for the core operator journey: overview, records, search, grants, runs, traces, deployment/capabilities, and representative detail views.
- Provide public, documented demo API endpoints that mirror the relevant reference/public shapes closely enough for agents and developers to call them directly.
- Keep the existing static walkthrough as lightweight educational entry content, but make the primary sandbox value a usable mock reference instance.
- Add resettable, obviously fictional seeded data covering connectors, streams, records, grants, traces, runs, schemas, capabilities, search, and revocation/refusal evidence.
- Preserve artifact honesty: the demo is not `/dashboard`, not a live owner server, not protocol authority, and not backed by real credentials or source platforms.

## Capabilities

### New Capabilities

- `reference-demo-instance`: Defines the public mock reference instance contract, including demo surface boundaries, seeded state, callable API shape, reset semantics, and fidelity requirements.

### Modified Capabilities

- `reference-surface-topology`: Refines the sandbox route family so it can contain both lightweight pedagogical walkthroughs and a mock reference demo instance without implying Vana hosts a real owner dashboard.
- `reference-web-bridge-contract`: Clarifies that website demo routes may bridge to deterministic mock AS/RS state only when labeled demo-only and must not redefine the primary reference contract.

## Impact

- `apps/web/src/app/sandbox/**`
- Shared dashboard components or adapters under `apps/web/src/app/dashboard/**` if needed to reuse the real operator UI safely
- New mock demo data/service modules under `apps/web/src/app/sandbox/**` or `apps/web/src/lib/**`
- New demo route handlers under `apps/web/src/app/sandbox/api/**` or equivalent
- `/reference` and `/reference/coverage` evidence rows
- OpenSpec specs and tasks for demo-instance behavior
- No real owner credentials, no live connector runtime, no hosted personal data, no protocol wire-format change, and no new external dependency expected for the first slice
