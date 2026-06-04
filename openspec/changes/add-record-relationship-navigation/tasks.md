# Tasks — add-record-relationship-navigation

This change is structured so the protocol-side requirements land first, the GitHub manifest backfill (one safe join) proves them, and the operator console picks them up last. Each section is independently committable. This is a design change only; the tasks below describe the implementation slice that would follow acceptance.

## 1. Current-state confirmation

- [ ] 1.1 Re-read `openspec/specs/reference-implementation-architecture/spec.md` "Public record expansion" requirements and confirm the one-hop / grant-scoped / manifest-allowlist contract still holds at HEAD, including the "Expansion pushes child-stream narrowing into SQL" scenario (`WHERE child.foreign_key IN (…parent keys…)`).
- [ ] 1.2 Re-read `reference-implementation/server/record-expand-helpers.js` (`normalizeExpandRequest`) and both backends' hydration paths (`records.js` ~1719, `postgres-records.js` ~587) to confirm `foreign_key` is a field on the **child** filtered against **parent** record keys, and the child's own key is its `primary_key`.
- [ ] 1.3 Inspect `packages/reference-contract/src/public/index.ts` `expand_capabilities` items schema and record the current required field set (`name`, `stream`, `cardinality`, `granted`, `usable`) and the optional properties already present (`target_stream`, `foreign_key`, `relation`).
- [ ] 1.4 Inspect `reference-implementation/server/index.js` `buildExpandCapabilities` and record what it emits today (`stream`, `foreign_key`, `granted`, `usable`, `reason: 'related_stream_not_granted'`; no `target_stream`).
- [ ] 1.5 Inspect `packages/polyfill-connectors/connectors/github/schemas.ts` and `manifests/github.json` to confirm `user_stats.user_id` is required, and `issues.repository_id` / `pull_requests.repository_id` are nullable / not required. Confirm `commits` is absent from the manifest.

## 2. Contract additions (`packages/reference-contract`)

- [ ] 2.1 Make `target_stream` (the child/related stream) and `child_parent_key_field` (the field on the child carrying the parent key) required on `expand_capabilities[*]`. Add `child_parent_key_field` to the schema; keep `foreign_key` as an optional back-compat alias documented as carrying the identical value.
- [ ] 2.2 Define the `reason` enum values for `usable: false` entries: `related_stream_not_granted`, `related_stream_unknown`, `related_stream_not_loaded`. Document them in the schema and note `related_stream_not_granted` is the value the server already emits.
- [ ] 2.3 Regenerate `openapi.json` / `schema.json` and any snapshot fixtures the contract package emits; `pnpm --filter @pdpp/reference-contract run check:generated` should pass after the snapshot is updated.
- [ ] 2.4 Add contract-level negative tests asserting validation fails for an `expand_capabilities` entry that omits `target_stream` or `child_parent_key_field`.

## 3. Server stream-metadata builder

- [ ] 3.1 Update `buildExpandCapabilities` to emit `target_stream` (= `relationship.stream`) and `child_parent_key_field` (= `relationship.foreign_key`) on every entry, keeping `foreign_key` as the back-compat alias with the same value.
- [ ] 3.2 Update the builder so it emits an entry for every enabled parent-stream relation — including entries whose target stream is outside the caller's grant, unknown, or not loaded — with `usable: false` and a `reason` value chosen from the new enum (`related_stream_not_granted` for not-granted, the additive members for unknown / not-loaded).
- [ ] 3.3 Update the existing SQLite and Postgres expand tests where they assert the shape of `expand_capabilities` so the new required fields and the inert-presence rule are covered.
- [ ] 3.4 Add tests asserting that for a `user`-only grant, the stream metadata for `user` includes an inert `usable: false` entry for `user_stats` with `reason: related_stream_not_granted`, and that the same entry under a both-granted token carries `target_stream: "user_stats"`, `child_parent_key_field: "user_id"`, `usable: true`.

## 4. Manifest validation

- [ ] 4.1 Confirm the existing rule (each enabled `query.expand[]` entry resolves to a `relationships[]` entry whose `foreign_key` is a **required** top-level property of the child schema) still passes; the `user → user_stats` declaration must satisfy it. Do not weaken this rule in this change.
- [ ] 4.2 Add a negative manifest test asserting that a declaration whose `foreign_key` is a non-required child property (the `repositories → issues` shape with nullable `repository_id`) fails validation — pinning the reason `repositories → issues` is deferred and documenting the prerequisite for the follow-up slice.

## 5. GitHub connector manifest

- [ ] 5.1 Declare `user.relationships[]` with `user_stats` (`has_many`, `foreign_key=user_id`) and `user.query.expand[]` with `user_stats` (`default_limit=30`, `max_limit=365`).
- [ ] 5.2 Do NOT declare `repositories → issues` or `repositories → pull_requests` (their `repository_id` foreign key is nullable / not required on the child, so they fail manifest validation today). Add a comment or design pointer noting the prerequisite (make the child key required, or add a null-keyed-child policy) for the follow-up slice.
- [ ] 5.3 Do NOT declare any `commits` relationship. Add a negative manifest test that asserts the GitHub manifest contains no relationship pointing at a `commits` stream.
- [ ] 5.4 Do NOT declare reverse-edge relationships from `user_stats`, `issues`, or `pull_requests` back to their parents.
- [ ] 5.5 Update any first-party manifest snapshot fixtures the test suite carries and run the GitHub connector's `*.test.ts` (in `packages/polyfill-connectors/connectors/github/`) to confirm no regression in shape-check-before-emit.

## 6. Query-contract tests (reference server)

- [ ] 6.1 Add a GitHub-synthetic test proving `GET /v1/streams/user/records?expand=user_stats` hydrates `user_stats` filtered by `user_id` for a grant covering both streams, and that each hydrated child carries `user_id` equal to the parent user record key (and a child record key of its own `id`, not `user_id`).
- [ ] 6.2 Add a GitHub-synthetic test proving `GET /v1/streams/user/records/<id>?expand=user_stats&expand_limit[user_stats]=N` honors the limit and reports `has_more`.
- [ ] 6.3 Add a GitHub-synthetic test proving `GET /v1/streams/user/records?expand=user_stats` returns `insufficient_scope` when the grant excludes `user_stats`.
- [ ] 6.4 Add a GitHub-synthetic test proving `GET /v1/streams/user_stats/records?expand=user` returns `invalid_expand` (reverse expansion not declared).
- [ ] 6.5 Add a GitHub-synthetic test proving `GET /v1/streams/repositories/records?expand=issues` returns `invalid_expand` (relation not declared in this change).
- [ ] 6.6 Add a GitHub-synthetic test proving `GET /v1/streams/user` stream metadata includes an `expand_capabilities` entry for `user_stats` with `target_stream`, `child_parent_key_field=user_id`, and `usable: true` when both streams are granted, and `usable: false` + `reason: related_stream_not_granted` under a `user`-only grant.

## 7. Operator console rendering

- [ ] 7.1 Add a thin helper (`apps/console/src/app/dashboard/records/lib/relationships.ts`) that consumes an `expand_capabilities[]` array and a record envelope and returns, per declared relation: `{ relation, targetStream, cardinality, childParentKeyField, navigable: boolean, href?: string, advisory?: string }`. The helper SHALL build a `has_many` href as the child list filtered by `childParentKeyField` = parent key, never as a child detail URL.
- [ ] 7.2 Update `apps/console/src/app/dashboard/records/[connector]/[stream]/[recordKey]/page.tsx`:
  - Fetch the stream metadata in parallel with the record (no new round-trips beyond what already exists for that page).
  - Render a "Related" section below the JSON envelope. Each declared relation renders as one of:
    - a link (`usable: true`): for `has_many`, `?filter[<child_parent_key_field>]=<parent_record_key>` on the child stream's list page; for `has_one`, the child detail page only when the parent carries the child key, or
    - inert text with the manifest-supplied `reason` advisory (`usable: false`), or
    - inert text "no related <relation>" when `usable: true` but the link cannot be built (e.g. `has_many` child has not declared the filter capability).
  - For `has_many`, never construct a child record-detail URL from the parent record key.
- [ ] 7.3 Update `apps/console/src/app/dashboard/records/[connector]/[stream]/page.tsx` (and the detail page) so that a field matching the `child_parent_key_field` of any declared forward relation renders as a link to the **parent** record's detail page `/dashboard/records/<conn>/<parent_stream>/<value>` (symmetric console linking per Decision D6).
- [ ] 7.4 Add a server-action / loader regression test (vitest + msw or the existing console test harness) asserting:
  - The detail page renders links for `usable: true` relations.
  - A `has_many` link points at the filtered child list, not a child detail URL built from the parent key.
  - The detail page renders inert advisory text for `usable: false` relations.
  - The child page renders a `child_parent_key_field` field as a parent-detail link when a forward relation exists.
  - No `expand[]` parameter is added to `getRecord` calls solely to draw links.

## 8. Documentation alignment

- [ ] 8.1 Add a short "Relationship navigation" paragraph to `docs/reference-audit.md` or `docs/operator/` (whichever is the live operator quick-reference index) pointing at the `user → user_stats` declaration and the console behavior, and noting the deferred `repositories → issues` prerequisite.
- [ ] 8.2 Update `docs/research/record-relationship-navigation-prior-art-2026-06-04.md` only if a prior-art source needs correction; do not duplicate spec content there.
- [ ] 8.3 Update `apps/site/` reference-page coverage matrix (or whichever index lists GitHub stream maturity) only if it needs to surface the new declared relationship; do not invent new coverage claims.

## 9. Acceptance checks

- [ ] 9.1 `openspec validate add-record-relationship-navigation --strict`
- [ ] 9.2 `openspec validate --all --strict`
- [ ] 9.3 Targeted reference tests: `pnpm --dir reference-implementation exec node --test test/query-contract.test.js test/postgres-expand-hydration.test.js`
- [ ] 9.4 Manifest validation: `pnpm --filter @pdpp/polyfill-connectors run verify`
- [ ] 9.5 Contract checks: `pnpm --filter @pdpp/reference-contract run verify` and `pnpm --filter @pdpp/reference-contract run check:generated`
- [ ] 9.6 Console checks: `pnpm --dir apps/console run types:check` and `pnpm --dir apps/console run check`
- [ ] 9.7 Final grep: confirm no console file references a hard-coded foreign-key field name; all such names flow through `expand_capabilities[*].child_parent_key_field`. Confirm no `has_many` console link builds a child record-detail URL from a parent record key.
