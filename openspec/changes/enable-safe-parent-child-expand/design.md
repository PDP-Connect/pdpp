## Context

The readiness audit found that the reference server already supports declared, one-hop expansion through `expand[]`, including grant projection, list/detail behavior, `expand_limit`, unknown-relation rejection, and insufficient-scope rejection. Those behaviors are covered today by the Spotify query-contract tests in `reference-implementation/test/query-contract.test.js` and implemented in `reference-implementation/server/records.js`.

The gap is enablement and durability. First-party polyfill manifests have relationship metadata but historically did not expose `query.expand`; some relationships are child-to-parent declarations that the current implementation cannot safely serve as parent-to-child joins. Gmail is the most valuable first target: `messages` should be able to hydrate separately grantable body records and attachment metadata without teaching clients to perform manual joins.

## Goals / Non-Goals

**Goals:**

- Make public `expand[]` semantics explicit enough for clients and reviewers to rely on.
- Require `query.expand` to be an allowlist over declared stream relationships, not an inferred graph traversal feature.
- Preserve grant safety: expanded child records must be filtered and field-projected under the child stream grant.
- Preserve list/detail parity: the same declared expansion must work on record-list and record-detail reads.
- Define `expand_limit` behavior for has-many child collections.
- Add manifest validation expectations before enabling first-party expansions.
- Enable Gmail `messages -> message_bodies` and `messages -> attachments` as safe parent-to-child joins.
- Handle Gmail thread context without adding reverse lookup semantics: `threads -> messages` may be enabled as a safe parent-to-child join if the manifest declares it, but `messages -> thread` remains deferred.

**Non-Goals:**

- Belongs-to or reverse expansion, such as `messages -> thread`, `message_bodies -> message`, `attachments -> message`, or `transactions -> account`.
- Nested expansion, graph traversal, entity resolution, aggregation, sorting changes, timeline endpoints, or cross-connector joins.
- Attachment byte hydration, `blob_ref` emission for Gmail attachments, extracted attachment text, or blob HTTP behavior changes.
- Changing the record query grammar beyond using the existing `expand` and `expand_limit[relation]` parameters.

## Decisions

### Use explicit manifest allowlists

An expansion is public only when the parent stream has both a matching `relationships[]` entry and a matching `query.expand[]` entry. This keeps relationship metadata descriptive while making public hydration opt-in. The alternative, exposing every relationship automatically, would turn stale or directionally incompatible declarations into public failures.

### Keep v1 expansion parent-to-child

The implementation joins child records by filtering the related stream's declared `foreign_key` against the current page of parent record keys. This is efficient, testable, and already covered by the SQL bounded-read invariant. Reverse lookup needs different semantics because the foreign key is on the parent, not the related stream. That should be a separate change if owners want it.

### Validate before backfill

The apply phase should first add manifest validation or manifest-level tests that reject unsafe `query.expand` declarations. At minimum, each enabled relation must reference an existing relationship, the child stream must exist, the declared `foreign_key` must be a top-level schema property on the child stream, and declared limits must be positive integers with `default_limit <= max_limit`. This prevents a broad manifest backfill from silently shipping empty or misleading joins.

### Enable Gmail in the safe direction only

For `messages`, add parent-side relationships to `message_bodies` and `attachments`, because those streams already carry `message_id`. Use `has_one` for `message_bodies` if each message has at most one body record, and `has_many` for `attachments`. For thread context, prefer a `threads -> messages` expansion because message records already carry `thread_id`; do not model `messages -> thread` in this tranche unless a separate reverse-expansion contract exists.

### Preserve existing missing/unknown behavior

Unknown, undeclared, nested, malformed, and limit-only expansion requests should continue failing loudly as `invalid_expand`. Requests where the parent grant is valid but the related stream is not granted should continue failing as `insufficient_scope`. Missing matching child records are not errors: has-one expansions return `null`, and has-many expansions return an empty list with `has_more: false`.

## Risks / Trade-offs

- Reverse thread context remains awkward for clients that start from a single Gmail message. Mitigation: document that this change enables body and attachment hydration from messages, while message-to-thread reverse hydration is intentionally deferred.
- Manifest relationship names may need cleanup where current child streams declare `message` as a belongs-to relation. Mitigation: require parent-side `query.expand` declarations to be validated against the implementation's join shape before enabling them.
- Existing public docs may still contain stale stream metadata or expansion wording. Mitigation: include a documentation alignment task, but keep protocol surface broadening out of this change.
- Expansion can increase response size. Mitigation: preserve `default_limit`, `max_limit`, child grant projection, and SQL-bounded child fetches.

## Migration Plan

1. Add manifest validator coverage for safe `query.expand` declarations.
2. Add first-party Gmail synthetic query-contract tests that prove list/detail expansion, grant projection, insufficient scope, missing child behavior, unknown relation failure, and `expand_limit`.
3. Backfill only the Gmail parent-to-child declarations that pass the validator.
4. Optionally enable `threads -> messages` as a safe parent-to-child thread-context path.
5. Roll back by removing the affected `query.expand` entries; existing direct stream queries remain available.

## Open Questions

- Should a later change add reverse/belongs-to expansion for high-value lookups such as `messages -> thread`, `attachments -> message`, and `transactions -> account`?
- Should thread-context UX be solved by reverse expansion, a dedicated thread detail pattern, or client-side direct lookup by `thread_id`?
