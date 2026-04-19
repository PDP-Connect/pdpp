# E2E Program Synthesis

Status note: historical synthesis memo. The active canonical program tracker now lives in `openspec/changes/reference-implementation-program/`.

Date: 2026-04-16  
Status: Owner-level synthesis after architecture, prior-art, and standards review

## Program shape

PDPP should not grow one giant reference app.

It should grow:

- one forkable engine substrate in `e2e/`
- one canonical reference world:
  - `Northstar HR` native provider
  - personal-server polyfill path
  - `Longview` client
  - CLI
- one companion auth/discovery profile for provider-connect flows
- one shared scenario registry and event/trace spine
- two disciplined projections over that substrate:
  - curated illustrated narrative
  - optional live operator console

## Hard boundaries

### Engine first

The forkable reference is:

- `e2e/server`
- `e2e/runtime`
- `e2e/cli`
- `e2e/test`

The website and any future control plane are downstream consumers.

### Reuse standards directly

PDPP should reuse OAuth by reference wherever it already solves the problem:

- bearer-token presentation
- PKCE / auth code
- device flow
- AS metadata discovery
- client metadata
- `authorization_details`

PDPP should define only the missing provider-connect glue.

### Event spine before dashboard

Do not build a serious dashboard until the system has:

- stable identifiers
- typed append-only events
- scenario registry
- CLI and tests consuming the same substrate

Otherwise the dashboard will invent a second architecture.

### Serverless-friendly application contract

Local Docker Compose is good. Local SQLite is good as a first adapter.

But the application contract should still assume:

- stateless application instances
- explicit persistence seams
- no normative reliance on sticky sessions or local disk

That keeps remote database / Redis / object-storage backing feasible later without major surgery.

## Dominant organizing objects

The best current organizing objects are:

- `grant` for PDPP core behavior
- `collection run` for Collection Profile behavior

That is a better center of gravity than:

- service health alone
- connector lists
- equal-weight client/server/runtime panels

## Recommended execution order

1. extraction audit
2. native HR world
3. provider-connect companion profile
4. event/trace spine
5. CLI owner path
6. request-model cleanup
7. Collection Profile cleanup
8. docs and tests
9. optional control plane

## Anti-goals

Do not:

- turn `apps/web` into runtime infrastructure
- build an all-in-one demo shell
- add dashboard-only endpoints
- let sample-world assumptions leak into the engine
- rewrite OAuth in PDPP-flavored prose when a direct reference would do

## Primary references

- [e2e-reference-implementation-plan.md](/home/user/code/pdpp/docs/archive/2026-04-e2e-superseded/e2e-reference-implementation-plan.md:1)
- [reference-implementation-substrate-audit.md](/home/user/code/pdpp/docs/inbox/reference-implementation-substrate-audit.md:1)
- [pdpp-provider-connect-profile-outline.md](/home/user/code/pdpp/docs/inbox/pdpp-provider-connect-profile-outline.md:1)
- [reference-topology-memo.md](/home/user/code/pdpp/docs/archive/2026-04-e2e-superseded/reference-topology-memo.md:1)
- [control-plane-surface-memo.md](/home/user/code/pdpp/docs/inbox/control-plane-surface-memo.md:1)
- [live-reference-surface-recommendation.md](/home/user/code/pdpp/docs/inbox/live-reference-surface-recommendation.md:1)
- [reference-implementation-owner-decisions-2026-04-16.md](/home/user/code/pdpp/docs/inbox/reference-implementation-owner-decisions-2026-04-16.md:1)
- [control-plane-prior-art.md](/home/user/code/pdpp/docs/research/control-plane-prior-art.md:1)
- [reference-implementation-ux-prior-art.md](/home/user/code/pdpp/docs/research/reference-implementation-ux-prior-art.md:1)
- [trace-surface-patterns.md](/home/user/code/pdpp/docs/research/trace-surface-patterns.md:1)
