# External Gemini Flash Promises Audit Triage

Status: captured
Owner: reference implementation owner
Created: 2026-05-28
Updated: 2026-05-28
Related: `docs/inbox/external-gemini-flash-promises-audit-2026-05-28.md`, `design-notes/full-context-refresh.md`, `docs/agent-workstream-playbook.md`

## Question

Which findings from the external Gemini Flash promises audit should influence
the reference implementation docket, and which claims are stale, over-broad, or
not accepted without proof?

## Context

The source audit was produced by a low-reasoning agent over a long collaboration
history. It is useful as a recovery checklist but is not ground truth. Its
claims must be checked against current code, OpenSpec state, and the standing
PDPP boundary model before they become work items.

The current boundary model remains: PDPP Core owns grant-scoped disclosure;
Collection Profile owns bounded collection runs; the reference implementation
owns Docker topology, operator UX, connector runtime, run diagnostics, and
self-hosting ergonomics.

## Stakes

Accepting the audit wholesale would add noise, resurrect stale bugs, and
increase cognitive tracking overhead. Ignoring it would risk losing legitimate
missed commitments. The useful move is triage: classify each theme by current
truth and construction boundary, then dispatch or archive accordingly.

## Current Leaning

The audit has a high stale/false-positive rate, but it contains several real
follow-ups.

Already closed or contradicted by current code:

- Event-subscription management is not backend-only: `_ref` routes, CLI
  commands, MCP tool support, and tests exist. Remaining work is acceptance and
  polish, not absence of management surfaces.
- Gmail attachment hydration is not wholly missing: current docs and code expose
  `blob_ref` as the PDPP byte-fetch contract, with Gmail as the first migrated
  source. Remaining work belongs to connector coverage/backfill, not a missing
  read primitive.
- The `PDPP-Version` criticism conflates protocol version and implementation
  revision. `PDPP-Version` should remain protocol-facing; reference revision is
  a separate header/surface and has already been added.
- The MCP package parser failure is covered by a current regression test that
  rejects legacy delimited URL selections without truncating to `https`.
- The worker-silent-failure concern is partly closed by tmux launch support,
  captured transcripts, recovery reports, and retry/fail-closed behavior for the
  Claude thinking-block API failure.

Real but already in flight:

- Public site versus operator console separation remains an active OpenSpec
  change and is not closed.
- Route-family split and `_ref`/operator route coherence remain active
  architecture work. Claims about unauthenticated `/_ref` endpoints should be
  proven route-by-route before acceptance.
- Code-quality closure remains active. Lint suppressions and complexity metrics
  should be resolved by configuration policy plus architectural decomposition,
  not by unsafe formatter output or unexplained ignores.
- Explorer/search/timeline IA remains active. The current implementation is not
  the final visual/product SLVP target.
- Connector-green issues remain active and should be handled through connector
  coverage, schema, fixture, and runtime reliability lanes.
- OpenSpec archive backlog is being reduced in batches; remaining completed
  changes still need owner-gated archive passes.

Real follow-ups to preserve:

- Webhook/event-subscription envelope standards need owner-level review against
  CloudEvents and Standard Webhooks before declaring the event system
  SLVP-ideal. The specific questions are `specversion`, header names, signed
  payload shape, retry/disable policy, and whether payload delivery modes are
  event pointers, inline data, or both.
- Aggregation/read-plane enhancements such as date bucketing, top-N/facets, and
  term or emoji frequency are real read-contract design questions. They should
  be treated as canonical read-contract work, not explorer-only UI features.
- `maximum_staleness_seconds` belongs in reference/Collection Profile health
  semantics as advisory policy. It should not be promoted into PDPP Core unless
  it becomes grant/disclosure behavior.
- Connection identity and multi-instance semantics are load-bearing. Core grants
  should remain about disclosure; reference/Collection Profile surfaces should
  make connection-scoped access explicit without leaking runtime implementation
  details into Core.
- Schemaless connector inventory, fixture capture, and source-local cursor or
  fingerprint guardrails are connector-authoring quality work worth preserving
  for the green-connector tranche.
- PWA icon/notification onboarding remains residual product polish and is
  intentionally behind higher-leverage reference/connector work.

Rejected or needs proof before action:

- "Dynamic client registration is broken because it requires an IAT" is not
  accepted as a defect by itself. Owner-gated client registration is a
  legitimate reference security posture unless a public registration mode is
  intentionally designed.
- "All `/_ref` endpoints are unauthenticated" is too broad. Treat it as a
  security audit prompt, not as a fact, until route inventory proves it.
- "SQLite WAL must be enabled everywhere" is not accepted as a universal fix.
  SQLite remains a local/small deployment backend; Postgres is the correct
  multi-process reference deployment target.
- "Every URL connector identifier is legacy baggage" matches the current owner
  preference, but manifest identifiers and compatibility aliases need a
  migration plan before removal.

## Promotion Trigger

Promote individual themes into OpenSpec before implementation when they change a
durable contract or architecture boundary, especially webhook envelope
compatibility, canonical read-contract aggregation/faceting, connection identity
semantics, route topology/auth posture, or operator/self-hosting UX.

## Decision Log

- 2026-05-28: Triaged the external Gemini Flash audit as useful but
  non-authoritative. Preserve real findings, reject stale claims, and use this
  note to prevent the audit from becoming another unbounded checklist.
