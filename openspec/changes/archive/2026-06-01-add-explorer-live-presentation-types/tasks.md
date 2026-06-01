# Tasks — Explorer live presentation types (flagship pilot)

## 1. Manifest declarations (additive, presentation-only)

- [x] In `packages/polyfill-connectors/manifests/chase.json`, on the `transactions` stream `schema.properties`, add `"x_pdpp_type": "currency"` to `amount`, `"x_pdpp_type": "timestamp"` to `date`, and `"x_pdpp_type": "text"` to `name`. Touch no other field, stream, or query declaration.
- [x] In `packages/polyfill-connectors/manifests/gmail.json`, on the `messages` stream `schema.properties`, add `"x_pdpp_type": "person"` to `from_name`, `"x_pdpp_type": "text"` to `subject`, `"x_pdpp_type": "text"` to `snippet`, and `"x_pdpp_type": "timestamp"` to `date`. Touch no other field, stream, or query declaration.
- [x] Confirm both files remain valid JSON and the connector manifest validator still accepts them. (Validated end-to-end: AS `/connectors` registration returned 201 for both in the harness; `connector-public-catalog-completeness.test.js` passes 3/3 against the edited manifests.)

## 2. Evidence harness (no runtime risk)

- [x] Add a test that loads the **real committed** `chase.json` and `gmail.json` manifests, registers each through the AS, mints an owner token, and reads `GET /v1/streams/:stream` (mirror the HTTP harness in `reference-implementation/test/rs-streams-field-declared-type.test.js`). → `reference-implementation/test/explorer-live-presentation-types.test.js`
- [x] Assert `field_capabilities.amount.type === 'currency'`, `field_capabilities.date.type === 'timestamp'`, `field_capabilities.name.type === 'text'` for chase `transactions`.
- [x] Assert `field_capabilities.from_name.type === 'person'`, a `text` type on `subject`/`snippet`, and `field_capabilities.date.type === 'timestamp'` for gmail `messages`.
- [x] Assert at least one non-pilot field in each stream omits the `type` key (absence is honest, never invented).
- [x] Feed the surfaced declared types into the real declared-type classification and assert `chase/transactions → money` and `gmail/messages → message`. (The reference test reimplements the small declared-type→kind precedence dependency-free; the web `record-kind.test.ts` owns the full `classifyRecordKind`.)
- [x] Re-assert additivity on a real manifest: each pilot field still carries well-formed, independent `granted` / `exact_filter` / `lexical_search` flags and a real JSON-schema echo — the presentation type rode alongside, it did not replace. (Byte-identity to an undeclared twin is proven on a synthetic manifest by the accepted change's `rs-streams-field-declared-type.test.js`.)

## 3. Validation

- [x] `node --test reference-implementation/test/explorer-live-presentation-types.test.js` (run against the worktree manifests via `PDPP_TEST_MANIFESTS_DIR` from a checkout with deps) — 8/8 green. Control run against unmodified manifests fails, proving the test has teeth.
- [x] `node --test reference-implementation/test/rs-streams-field-declared-type.test.js` — still green 4/4 (accepted-change invariant unbroken).
- [x] `pnpm --dir apps/web exec node --test --import tsx src/app/dashboard/lib/record-kind.test.ts` — still green 32/32.
- [x] `connector-public-catalog-completeness.test.js` against the edited manifests — green 3/3 (manifest-validation guard for the two edited manifests).
- [x] `openspec validate add-explorer-live-presentation-types --strict` — passes.
- [x] `openspec validate --all --strict` — passes (34/34, no regression to sibling changes).

## 4. Follow-up handoff (NOT in this change)

- [x] Record that the commit-anchored browser/UAT pass (the >95% gate criteria 4–5 in `design.md`) is a separate lane; this change ships the manifest + harness only. (`design.md` includes the follow-up Browser/UAT runbook and acceptance gates.)
- [x] Record the residual designer-parity gap (photo/activity/reader/location cards, per-stream view switcher, grant-projection toggle) as known-and-scoped-out so ">95% live fidelity" is claimed against the money + message card axis, not full designer parity. (`design.md` records this under the designer-artifact findings and >95% criteria.)
