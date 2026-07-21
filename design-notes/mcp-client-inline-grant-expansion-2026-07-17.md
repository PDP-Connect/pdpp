# MCP client inline grant expansion

Status: captured — deferred; not authorized for implementation
Owner: RI owner
Created: 2026-07-17
Updated: 2026-07-17
Related: `openspec/specs/reference-agent-access-workflow/spec.md`, `spec-core.md` §5–§6, `docs/agent-skills/pdpp-data-access/references/grant-design.md`

## Question

When an MCP client discovers that its current PDPP grant is too narrow for the
user's task, should it be able to request the additional access from within the
active client flow, instead of requiring the owner to find and manually edit the
client's connection in the operator console?

## Context

The current reference-agent contract already requires an agent with insufficient
access to request an explicit upgrade or additional grant. It forbids silently
broadening the grant or falling back to owner authority. What remains unresolved
is the interoperable product and protocol flow that turns that rule into a useful
MCP client experience.

Today, an owner may need to leave the client, locate its grant or connection in
the operator console, infer the missing selection, and update it manually. That
breaks task continuity and makes a legitimate least-privilege grant feel like a
configuration failure. A client is better placed to describe the exact additional
source, streams, fields, time range, or operation it needs, while the authorization
server remains responsible for informed owner approval.

## Stakes

A good flow could make narrow initial grants practical: clients can start with
less access and ask for a bounded delta only when a task needs it. A bad flow
could normalize consent fatigue, create ambient privilege escalation, couple MCP
tool errors to reference-console routes, or replace one durable grant with a
surprisingly broader one.

## Current leaning

Preserve these outcome constraints without selecting a mechanism yet:

- The client requests a concrete grant delta tied to the active client identity
  and task context; it never edits or broadens a grant unilaterally.
- The owner sees the current grant, the requested addition, purpose, duration,
  retention, and resulting effective access before approving.
- Approval may issue an additional grant or a replacement grant, but the choice
  and revocation consequences must be explicit. Existing access must not disappear
  or broaden as an accidental side effect.
- Denial, expiry, abandonment, and partial approval return a typed result the MCP
  client can act on. The original tool call may offer a resumable path, but must
  not wait indefinitely or claim the task continued when it did not.
- Discovery and request semantics should be transport-neutral where possible.
  MCP may expose the flow, but PDPP authorization semantics must not become coupled
  to one ChatGPT, Claude, or operator-console implementation.
- The design should reuse standards-based authorization primitives where they fit.
  It must not invent a PDPP-only escalation protocol before comparing OAuth
  incremental authorization, RFC 9396 Rich Authorization Requests, PAR, UMA,
  GNAP, and current MCP authorization behavior.

## Open questions

- Is the durable unit an additional grant, a replacement grant with continuity,
  or a new authorization transaction that can produce either?
- How does a resource or MCP server return enough structured information for a
  client to request the missing delta without disclosing grant internals or
  teaching every tool a reference-specific UI URL?
- Can an interrupted tool call be resumed safely after approval, or should the
  client repeat it against the newly authorized grant?
- How are concurrent requests, owner edits, denial, expiry, and revocation ordered
  without creating two conflicting effective-grant views?
- Which existing MCP clients can initiate and complete a new authorization request
  during an active connection, and what fallback is appropriate when a host cannot?
- What rate, grouping, and presentation rules prevent repeated micro-prompts from
  becoming consent fatigue?

## Promotion trigger

Promote this note to an OpenSpec change only after both conditions hold:

1. A cited prior-art and interoperability study establishes the smallest
   standards-aligned authorization shape and its security/consent properties.
2. At least one concrete MCP client path can exercise the flow end to end, with a
   defined fallback for clients that cannot initiate authorization inline.

Promotion changes authorization behavior and the client/owner experience, so it
requires protocol-boundary review, threat analysis, and executable conformance
scenarios before implementation.

## Decision log

- 2026-07-17 — Captured as deferred intake. Do not implement while the current
  connection-health closeout is active. The existing requirement to request an
  explicit upgrade or additional grant remains authoritative; this note preserves
  the unresolved inline experience and interoperability question.
