## Status

This is a high-stakes normative design track. It is not an accepted PDPP protocol change, does not modify the reference PAR contract, and does not authorize implementation of multi-source grants or approve-many consent UI.

## Problem

A capable owner-authorized agent often needs access to multiple sources before it can be useful: email, finances, Slack, GitHub, local coding history, calendar, and memories. Requiring a separate consent ceremony for every source is safe in isolation but poor as setup UX.

At the same time, "approve everything" is exactly the failure mode PDPP exists to avoid. A broad multi-source approval can become an owner token with nicer packaging unless source boundaries, scope explanation, revocation, and audit remain explicit.

The current reference behavior is a defensible safety rail:

- `authorization_details[]` is constrained to one entry.
- An issued client grant is source-bounded.
- A client cannot bundle all sources into one approval.

But it creates a real user problem:

- A legitimate high-trust setup can require many approval round trips.
- The path of least resistance becomes owner-token sharing or maximal continuous grants.
- The consent UI does not yet help the owner understand cumulative broadness across a sequence of approvals.

## Design Principles

- **Preserve source-bounded enforcement.** One issued grant should remain bound to one source boundary unless a future accepted spec very deliberately changes that rule.
- **Separate ceremony from grant object.** A fast owner-facing approval flow can issue many independent grants; it does not need one cross-source grant.
- **Make broadness legible.** Mixed-source, continuous, no-time-limit, all-stream, or no-field-limit access needs stronger presentation than a narrow one-shot task grant.
- **Keep denial and revocation granular.** The owner must be able to deny or revoke one source without invalidating unrelated approved access unless they choose package-level revocation.
- **Do not let clients author dark-pattern bundles.** Client-authored broad packages need constraints. Owner-authored permission sets may be safer for repeated high-trust use.
- **Treat this as proposed until accepted.** Any experimental reference implementation must be labeled reference-experimental and must not claim root PDPP normativity.

## Candidate Models

### Option A: Keep one source per ceremony

The current behavior becomes normative: clients request one source at a time, and owners approve one source at a time.

Pros:

- Strongest data-minimization default.
- Simple audit and revocation.
- Closest to the current reference.

Cons:

- Poor setup UX for useful agents.
- Encourages owner-token shortcuts.
- Makes legitimate broad access feel like a tedious workaround instead of an intentional owner decision.

### Option B: Batch consent ceremony issuing independent grants

The client submits a batch containing multiple source-bounded grant requests. The AS renders one owner-facing review session. Approval issues one independent grant per source.

Pros:

- Fast setup without cross-source grant objects.
- Keeps revocation and enforcement source-bounded.
- Maps naturally to OAuth RAR multiple `authorization_details[]` entries while preserving PDPP source boundaries.

Cons:

- Consent UI complexity increases sharply.
- "Approve all" can become a dark pattern.
- Pending-consent storage, timeline, audit, CLI, and dashboard need package-level concepts.

### Option C: Owner-authored permission sets

The owner defines reusable sets such as "personal assistant", "finance review", or "coding assistant". Clients request a named permission set or the owner applies one during consent.

Pros:

- The owner, not the requesting client, authors broad access.
- Repeated setup becomes fast without normalizing client-authored maximal requests.
- Permission sets can be reviewed, versioned, and retired.

Cons:

- More product surface before the first useful grant.
- Requires policy storage, edit UI, and package versioning semantics.
- Still needs per-source audit and revocation.

### Option D: Agent roles

The AS supports owner-defined roles that map an agent/client identity to allowed grant envelopes over time.

Pros:

- Strong fit for long-lived personal assistants.
- Can support incremental upgrades and policy drift explicitly.

Cons:

- Highest protocol complexity.
- Risks becoming account-level authorization policy rather than consent.
- Needs careful relationship to client registration, project-local caches, and revocation.

## Current Leaning

Prefer **Option B as the first implementation candidate**, constrained by source-bounded issued grants, and evaluate **Option C** as the safer long-term owner-controlled abstraction.

The likely shape:

1. A client may stage a batch consent request containing multiple source-bounded grant requests.
2. The AS renders a grouped consent ceremony.
3. The owner can approve all, deny all, or toggle individual sources/streams.
4. Approval issues multiple independent grants, one per source.
5. The AS records a package/session id for audit, timeline grouping, and optional "revoke package" convenience.
6. RS enforcement remains unchanged: each token/grant is still source-scoped.
7. High-risk items require explicit confirmation: continuous access, all streams, no time bound, sensitive connectors, and no field projection.

This leaning is not final. It must survive prior-art review and owner review before implementation.

## Prior Art To Review

- OAuth RAR (RFC 9396): multiple `authorization_details[]`, rich scoped requests, and typed authorization details.
- OAuth PAR (RFC 9126): pushed request integrity and short-lived staged authorization requests.
- Google OAuth consent: multi-scope grouping, sensitive/restricted scopes, and incremental auth.
- GitHub fine-grained personal access tokens and GitHub App installation: resource selection, permission grouping, repository toggles.
- Slack app scopes: app installation as a bundled permission ceremony with per-scope review.
- Plaid Link: institution/source selection, product scopes, account filtering, and consent copy.
- Apple/Android permissions: grouped permission prompts, progressive disclosure, and high-risk permission friction.
- AWS IAM Identity Center / permission sets: owner/admin-authored reusable access bundles.
- GitLab/GitHub organization app installation: approve many resources while preserving resource-level control.

## Non-Goals

- Do not implement multi-source PAR in this change.
- Do not change issued grant enforcement from source-bounded to cross-source.
- Do not add reusable permission sets or agent roles in this change.
- Do not update the `pdpp-data-access` skill to recommend broad setup flows until a design is accepted.
- Do not treat the reference's current `authorization_details.maxItems = 1` as permanently normative without explicit owner/spec review.

## Acceptance Checks

- The OpenSpec change validates strictly.
- The design clearly distinguishes current behavior from proposed behavior.
- Tasks require prior-art review before implementation planning.
- Any future implementation task preserves source-bounded issued grants unless a later accepted change says otherwise.
