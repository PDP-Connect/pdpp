## Classification under `canonicalize-public-read-contract`

This change is the **expansion implementation slice** under the canonical public read contract.

The canonical contract owns the expansion primitive: `expand[]` is one-hop, parent-to-child, grant-safe, depth-capped at one, and bounded by `expand_limit`. Reverse, belongs-to, nested, and arbitrary graph traversal are explicitly non-goals. That rule lives in `openspec/changes/canonicalize-public-read-contract/specs/reference-implementation-architecture/spec.md` ("Public read expansion SHALL be one-hop, inline, and grant-safe").

What stays here: the concrete audit of first-party manifests, the safe parent-to-child `query.expand` enablements, the manifest validator coverage, and the docs/test work that proves the existing engine continues to honor the one-hop, grant-safe rule.

No new expansion semantics are introduced. This change does not stack a second expansion contract on top of the canonical one — it implements declarations against the existing engine within the canonical guardrails.

## Existing Contract

The reference expansion engine supports one-hop parent-to-child expansion:

- parent record is already visible under the grant
- child stream is also granted
- manifest declares a relationship
- manifest enables the relationship through `query.expand`
- child stream contains the declared top-level foreign key
- response projects child records through the child grant

This change does not add reverse lookup, belongs-to expansion, nested graph traversal, or joins across unrelated streams.

## Candidate Relations

Implementation should audit, not assume, but likely candidates are:

- already shipped: `gmail.messages -> message_bodies`
- already shipped: `gmail.messages -> attachments`
- possible: `slack.messages -> message_attachments`
- possible: `slack.messages -> reactions`

Candidates must be rejected or deferred when:

- the foreign key is on the parent rather than the child
- the child stream is not actually emitted by the connector
- the relation needs many-to-one lookup such as `message -> channel`, `transaction -> account`, or `issue -> repository`
- the relation would expose blob bytes without the existing `blob_ref` grant checks

## Acceptance

Each enabled relation needs:

- manifest declaration
- validator acceptance
- validator rejection for malformed declarations
- list and detail query tests
- child projection/grant tests
- `expand_limit` behavior for has-many relations

## Non-Goals

- No reverse or belongs-to relation syntax.
- No nested expansion.
- No entity graph.
- No attachment byte extraction beyond existing `blob_ref` hydration.
