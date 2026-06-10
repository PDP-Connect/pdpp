## Why

A green-prep audit (`tmp/workstreams/ri-connector-schema-green-prep-audit-report.md`)
found that 20 of 31 polyfill connectors declare per-stream JSON schemas in their
manifests but never wire `makeValidateRecord` / `validateRecord` into
`runConnector`. The shared validation machinery exists
(`src/schema-registry.ts`, `amazon/schemas.ts` as the canonical model) and the
authoring guide lists "Emits shape-check assertions for every field that can go
wrong" in the pre-ship checklist — but nothing enforces it. Authors can ship a
connector that emits `RECORD` events without any emit-time shape check, and CI
stays green.

The result is a silent SLVP "verifiable" gap: schema drift, corrupt text,
oversized fields, or malformed records pass into the spine with no `SKIP_RESULT`
signal, while operator dashboards report clean runs. The manifest schema and the
emitted record are untethered for the majority of the fleet.

The construction problem is not "20 connectors have a bug." It is that *missing
validation is invisible and free*. The smallest correct fix is not to author 20
schemas (that fixes today's instances but not the regression class); it is to
make the absence of validation **explicit and hard to regress** — a build-time
gate plus a documented, justified allowlist that can only shrink.

## What Changes

- Add a reference/polyfill requirement: a connector whose manifest declares one
  or more streams SHALL wire emit-time record validation (`validateRecord`),
  OR be listed on an explicit, justified schemaless allowlist.
- Add a build-time guardrail test
  (`src/connector-schema-validation-honesty.test.ts`, in the same family as the
  existing `*-manifest-honesty.test.ts` tests) that fails when a connector
  declares manifest streams, omits `validateRecord`, and is not on the
  allowlist. The test runs inside the package `test` script that CI already
  executes.
- Seed the allowlist with the 20 connectors the audit identified as currently
  schemaless, each with a one-line justification and a pointer to the remediation
  lane (audit Lanes A–C). New connectors are validated by default: adding a
  connector to the allowlist is a deliberate, reviewed act, not a silent default.
- Update the connector authoring guide to state the rule as a build-time
  invariant rather than a soft checklist item, and to document the allowlist /
  justification mechanism.

This change does not author any connector `schemas.ts`. It establishes the
construction boundary; per-connector schema authoring (audit Lanes A–C) and the
Codex fingerprint migration (Lane D) remain separate, independent work that this
gate measures and ratchets.

## Capabilities

### New Capabilities

None. No new protocol surface, manifest field, or `/v1` behavior.

### Modified Capabilities

- `polyfill-runtime`: add a reference/polyfill authoring-and-CI requirement that
  connectors declaring manifest streams SHALL validate emitted records or appear
  on a justified schemaless allowlist enforced at build time. This is
  reference-implementation tooling and authoring policy, not PDPP Core or
  Collection Profile protocol semantics.

## Impact

- `packages/polyfill-connectors/src/connector-schema-validation-honesty.test.ts`
  — new build-time guardrail test (the gate).
- `packages/polyfill-connectors/src/connector-schema-allowlist.ts` — new module
  holding the explicit schemaless allowlist with per-connector justifications;
  imported by the gate test and available for future tooling/reporting.
- `packages/polyfill-connectors/docs/connector-authoring-guide.md` — restate the
  shape-check requirement as a build-time invariant; document the allowlist
  mechanism.
- No runtime code path changes. `runConnector`'s `validateRecord?` stays
  optional in the type signature (a zero-dep entrypoint must still be able to run
  a connector that has no schema); the gate enforces the policy above that
  optionality at authoring/CI time.
- No `/v1` grant-scoped surface change.
