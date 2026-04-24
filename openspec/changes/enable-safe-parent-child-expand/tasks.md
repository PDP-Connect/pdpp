## 1. Current-State Confirmation

- [ ] 1.1 Re-read `reference-implementation/server/records.js` expansion handling and confirm declared relationship gating, child grant projection, list/detail parity, `expand_limit`, and error codes still match this change before editing code.
- [ ] 1.2 Re-read `reference-implementation/test/query-contract.test.js` expand coverage and identify which existing Spotify tests can remain unchanged versus which Gmail-specific tests must be added.
- [ ] 1.3 Inspect `packages/polyfill-connectors/manifests/gmail.json` and confirm the current `message_bodies` and `attachments` streams expose top-level `message_id` fields and do not expose attachment byte or `blob_ref` fields.

## 2. Manifest Safety Validation

- [ ] 2.1 Add a manifest validator or manifest-level regression test that every `query.expand[]` entry matches a same-stream `relationships[]` entry by name.
- [ ] 2.2 Extend the validation to require the relationship's related stream to exist and the declared `foreign_key` to be a top-level property in that related stream's schema.
- [ ] 2.3 Extend the validation to reject invalid expansion limits: non-positive `default_limit`, non-positive `max_limit`, or `default_limit > max_limit`.
- [ ] 2.4 Add negative coverage with a deliberately invalid fixture for missing relationship, missing child foreign key, and invalid limit declarations.

## 3. Gmail Manifest Enablement

- [ ] 3.1 Add parent-side Gmail `messages` relationships for `message_bodies` and `attachments` using the child streams' `message_id` foreign key.
- [ ] 3.2 Add `query.expand[]` entries on Gmail `messages` for `message_bodies` and `attachments`, with conservative defaults and maximums appropriate for one body record and bounded attachment lists.
- [ ] 3.3 If thread context is included in this tranche, add a parent-side Gmail `threads -> messages` relationship using `messages.thread_id` plus a bounded `query.expand[]` entry on `threads`.
- [ ] 3.4 Do not enable `messages -> thread`, `attachments -> message`, or `message_bodies -> message`; leave those belongs-to/reverse shapes undeclared under `query.expand`.

## 4. Query-Contract Tests

- [ ] 4.1 Add Gmail synthetic-record tests proving `messages?expand=message_bodies` works on list reads and projects child body fields according to the `message_bodies` grant.
- [ ] 4.2 Add Gmail synthetic-record tests proving `messages/<id>?expand=message_bodies` works on detail reads with the same semantics.
- [ ] 4.3 Add Gmail synthetic-record tests proving `messages?expand=attachments&expand_limit[attachments]=N` returns a bounded list object with correct `has_more` behavior.
- [ ] 4.4 Add Gmail tests proving missing body returns `null` and missing attachments return an empty list with `has_more: false`.
- [ ] 4.5 Add Gmail tests proving expansion fails with `insufficient_scope` when the child stream is outside the grant.
- [ ] 4.6 Add Gmail tests proving `expand=thread` on `messages` fails with `invalid_expand` unless a later reverse-expansion change exists.
- [ ] 4.7 If `threads -> messages` is enabled, add a Gmail test proving `threads?expand=messages` hydrates granted messages by `thread_id` and respects `expand_limit`.

## 5. Documentation Alignment

- [ ] 5.1 Update any reference docs or examples touched by this change so `relationships[]` remains descriptive metadata and `query.expand[]` is the public expansion allowlist.
- [ ] 5.2 Document that Gmail attachment expansion is metadata-only and does not grant bytes, `blob_ref`, extracted text, or blob fetch access.
- [ ] 5.3 Document that belongs-to/reverse expansion is deferred and direct queries by foreign key remain the current workaround.

## 6. Acceptance Checks

- [ ] 6.1 Run the targeted query-contract tests covering expand behavior.
- [ ] 6.2 Run the manifest validation tests added or updated by this change.
- [ ] 6.3 Run `openspec validate enable-safe-parent-child-expand --strict`.
- [ ] 6.4 Run `openspec validate --all --strict`.
- [ ] 6.5 Run `git diff --check`.
- [ ] 6.6 Grep the affected manifest and tests for any accidental `messages -> thread`, `attachments -> message`, `message_bodies -> message`, `blob_ref`, or attachment byte-hydration enablement before reporting complete.
