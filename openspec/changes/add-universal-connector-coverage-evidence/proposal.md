# add-universal-connector-coverage-evidence

## Why

The reference dashboard answers seven coverage questions for each connection:
what was considered, collected, skipped, retryable, terminal, checkpointed, and
expected next run. Today most answers come from run history and gap records, but
two axes have a consumer-without-producer gap that makes the dashboard guess
rather than read:

**Accepted-coverage axis** (`coverage_policy`): the server fully reads a
manifest stream field (`unsupported` / `unavailable` / `deferred` /
`inventory_only`) to promote a non-green coverage axis to accepted. The field is
correctly typed in `ref-control.ts:108` and the server projects it faithfully.
But it exists in zero of 31 connector manifests AND is absent from
`packages/reference-contract` — connector authors have no schema-visible signal
it exists and no validator can enforce its values. The accepted-coverage axis is
dead code in practice.

**Considered denominator** (`DETAIL_COVERAGE`): after a list+detail run the
dashboard cannot answer "of the N items the connector scanned, how many were
successfully hydrated, how many produced gaps, how many were skipped?" ChatGPT
emits `DETAIL_COVERAGE` (1/31); the other 30 connectors emit nothing. There is
no shared helper and no contract requirement to emit it, so every new
list+detail connector must rediscover the pattern from ChatGPT's source.

## What Changes

**Tranche A — Contract promotion** (narrow, contract-only, mergeable on its own):

- Promote `coverage_policy` into the `packages/reference-contract` manifest
  stream schema so the field is validated, documented, and schema-visible to
  all connector authors. No manifest JSON or connector code changes — purely a
  contract addition.

**Tranche B — Shared emission helper + contract requirement** (owner-gated,
requires connector edits):

- Add a shared `emitDetailCoverage(ctx, params)` helper to
  `packages/polyfill-connectors/src/connector-runtime.ts` that wraps the
  existing `DETAIL_COVERAGE` message so no connector needs to rediscover
  ChatGPT's local inline builder.
- Add a contract requirement that a connector with a detail lane SHALL emit
  `DETAIL_COVERAGE` once per run, covering required keys, hydrated keys, gap
  keys, and optional-skip keys. ChatGPT is already compliant; the helper
  lowers the adoption cost to a one-liner for the next connector.

## Capabilities

### New Capabilities

None. Both tranches expose the existing evidence infrastructure to more
authors/connectors; no new runtime semantics are introduced.

### Modified Capabilities

- `polyfill-runtime`: The manifest stream schema SHALL declare and validate
  `coverage_policy`. A connector with a detail lane SHALL emit `DETAIL_COVERAGE`
  once per run.

### Removed Capabilities

None.

## Impact

**Tranche A** — contract-only:

- `packages/reference-contract/src/reference/index.ts`: add `coverage_policy`
  to the manifest stream schema (enum with the five accepted values).
- No connector manifests or runtime code change.
- Affected tests: reference-contract schema tests must accept the new field.

**Tranche B** — helper + contract:

- `packages/polyfill-connectors/src/connector-runtime.ts`: add
  `emitDetailCoverage(ctx, { stream, stateStream, requiredKeys, hydratedKeys,
  gapKeys, optionalSkipKeys })` helper.
- `packages/polyfill-connectors/src/connector-runtime-protocol.ts`: no change
  (the `DetailCoverageMessage` type is already correct).
- New tests: verify the helper emits a valid `DETAIL_COVERAGE` message.
- Connector adoption is owner-gated (which connectors adopt Tranche B is a
  separate decision; this change only establishes the contract and tool).
