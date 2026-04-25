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
