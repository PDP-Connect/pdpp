## 1. OpenSpec authoring

- [x] 1.1 Author proposal, design, and `polyfill-runtime` spec delta.
- [x] 1.2 Validate `add-connector-schema-validation-gate --strict`.

## 2. Allowlist module

- [x] 2.1 Add `src/connector-schema-allowlist.ts` exporting a typed
  `Record<connectorName, justification>` seeded with the 20 audit-identified
  schemaless connectors, each justification naming its remediation lane (A/B/C).

## 3. Build-time gate

- [x] 3.1 Add `src/connector-schema-validation-honesty.test.ts` in the
  `*-manifest-honesty.test.ts` family: scan each connector's `index.ts` +
  `manifests/<name>.json`, detect manifest-stream declaration and
  `validateRecord` wiring, and assert the allowlist invariant in both
  directions (unexplained gap fails; stale allowlist entry fails).
- [x] 3.2 Assert the allowlist contains no unknown connector names (every key
  resolves to an existing connector directory).

## 4. Documentation

- [x] 4.1 Update `docs/connector-authoring-guide.md`: restate the shape-check
  pre-ship item as a build-time invariant and document the allowlist mechanism.

## 5. Validation

- [x] 5.1 `openspec validate add-connector-schema-validation-gate --strict`.
- [x] 5.2 Run the new gate test from a node_modules-resolving checkout; assert it
  passes on the current tree (11 validated, 20 allowlisted, 0 unexplained).
- [x] 5.3 Negative checks: temporarily removing an allowlist entry fails the
  gate; an allowlisted-but-now-validated connector fails the gate.
- [x] 5.4 Run the existing manifest-honesty test family to confirm no regression.

## Deferred follow-up (separate lanes, measured by this gate)

- [x] Lane A: author `schemas.ts` for `google_takeout`, `twitter_archive`,
  `whatsapp`, `imessage`, `loom`; remove their allowlist entries. (All five wire
  `validateRecord` from a sibling `schemas.ts`; allowlist entries removed; gate
  green at 16 validated, 15 allowlisted, 0 unexplained. Each connector has a
  focused `schemas.test.ts` proving the schema accepts representative emitted
  records — parser-derived for google_takeout/twitter_archive, emit-literal for
  whatsapp/imessage, manifest-contract for loom which does not yet emit.)
- [ ] Lane B: author schemas for the medium-risk API connectors; remove entries.
- [ ] Lane C: author schemas for the lower-risk connectors; remove entries.
- [ ] Lane D: migrate Codex to the shared fingerprint cursor (independent of this
  gate).
