# Fast Broad Agent Consent

Status: promoted
Owner: owner
Created: 2026-04-27
Updated: 2026-04-27
Related: `openspec/changes/add-agent-scoped-pdpp-access/`, `openspec/changes/design-fast-broad-agent-consent/`, `apps/web/content/docs/spec-core.md`

## Question

How should PDPP let an owner grant a capable agent "lots of useful permission fast" without collapsing least privilege, hiding source boundaries, or normalizing one-click access to the owner's whole personal data plane?

## Context

Live testing exposed a real user-experience problem. A fresh agent asked for the "most permissive grant" and discovered that the reference accepts exactly one `authorization_details[]` entry per PAR request. It could not request all available connectors in one approval. It then staged a maximal single-source Slack request: every Slack stream, no field restrictions, `continuous` access, and no time bound.

Two things are true at once:

- The current reference safety rail is useful. A single approval cannot silently bundle all sources, and the public reference contract currently pins `authorization_details.maxItems = 1`.
- The owner experience is too slow for legitimate high-trust agent setup. If an owner wants to empower an assistant across email, finance, Slack, GitHub, and local coding history, repeating the same consent ceremony 5-12 times is friction that will push users back toward owner tokens.

The current root PDPP core spec also creates ambiguity. It normatively describes grants as one `connector_id`/source plus streams, and `access_mode` as `single_use | continuous`. It does not fully normatively specify the AS interaction model, and it does not yet define a batch-consent or grant-bundle primitive. Therefore "one source per grant" is aligned with the current model, but "one source per consent ceremony forever" is not yet a settled PDPP rule.

## Stakes

This is high-stakes normative design material because it sits at the intersection of:

- **Data minimization:** broad multi-source grants can become a disguised owner token.
- **User agency:** owners should be able to intentionally grant broad access when they understand the tradeoff.
- **Agent effectiveness:** narrow per-source approvals are safe but can make the best agent UX impractically slow.
- **Auditability:** if many grants are approved together, revocation and audit must remain source-specific and understandable.
- **Consent UX integrity:** the UI must not make maximal access look routine or safe by default.

Bad outcomes to avoid:

- One-click "all data" consent that trains owners to approve everything.
- Artificial friction so high that users paste owner tokens into agent chats.
- A grant object that spans many unrelated sources and becomes hard to revoke or inspect.
- A reference-only convenience that later gets mistaken for finalized PDPP semantics.

## Current Leaning

Keep the durable grant model source-bounded: one issued grant binds to one source boundary (`connector_id` or native `provider_id`) and an explicit set of streams/fields/time/resource constraints.

Explore a separate **batch consent ceremony** or **grant package** concept:

- The client submits multiple source-bounded grant requests as one owner-facing review session.
- The AS renders a grouped summary with per-source risk, stream counts, field/time/resource constraints, and access modes.
- The owner can approve all, deny all, or toggle individual sources/streams before approval.
- Approval issues multiple independent grants, one per source, rather than one all-powerful cross-source grant.
- Revocation remains per-grant/per-source, with an optional "revoke package" affordance for convenience.
- Maximal requests (`continuous`, no fields, no time range, many streams) receive high-friction UI treatment: explicit warning, source-by-source confirmation, and no default "approve all" affordance until reviewed.

This shape preserves source-bounded enforcement while making legitimate broad setup fast.

Candidate terms to evaluate:

- **grant package:** an owner-facing bundle of independent grants approved in one session.
- **batch consent:** the AS interaction that reviews and issues a package.
- **permission set / access preset:** an owner-authored reusable collection of source scopes, possibly safer than client-authored "everything" bundles.
- **agent role:** an owner-defined policy such as "personal assistant", "finance reviewer", or "coding assistant" that maps to one or more source-bounded grants.

Open design questions:

- Should the client be allowed to author grant packages, or should only the owner assemble reusable permission sets?
- Should "approve all" ever be shown for mixed-source requests, and if yes, under what risk thresholds?
- Should continuous access across multiple sensitive sources require a stronger ceremony than single-use access?
- How should package-level audit work without weakening per-grant revocation?
- Can this be modeled as OAuth RAR with multiple `authorization_details[]` entries, or does PDPP need a companion batch-consent profile?
- How should this interact with future local agent skills and project-scoped token caches?

## Promotion Trigger

Promote this note into a dedicated OpenSpec change before implementing any of the following:

- accepting multiple `authorization_details[]` entries in the reference PAR route,
- adding any "approve many grants" consent UI,
- adding a grant package, permission-set, or agent-role object,
- changing root PDPP language about whether grants are source-bounded,
- changing the agent skill to recommend broad multi-source setup flows.

The promoted change should include prior-art review across OAuth RAR/PAR, GitHub fine-grained permissions, Google OAuth consent, Slack app scopes, Apple/Android permission grouping, AWS IAM permission sets, and GitHub/GitLab organization app installation flows.

## Decision Log

- 2026-04-27: Captured after live agent testing showed the current reference cannot grant all sources quickly, while a maximal single-source continuous grant is easy to stage. Owner feedback: the inability to grant lots of permission fast is itself a user problem; do not rush the normative answer.
- 2026-04-27: Promoted into `openspec/changes/design-fast-broad-agent-consent/` as a dedicated normative design track. This note remains the intake record; implementation remains blocked until the promoted change reaches an owner-reviewed decision.
