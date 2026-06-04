# Design — add-universal-connector-coverage-evidence

## Problem

Two coverage evidence channels exist in the runtime protocol but have no
producers except a single connector (ChatGPT):

1. **`coverage_policy` manifest field** — `ref-control.ts:108` defines the
   type; `readAcceptedCoveragePolicy` at line 1122 reads it; `mapCoverageAxis`
   at line 1051 promotes the run to an accepted-coverage label when the run
   succeeds and the manifest declares the policy. But the field appears in 0/31
   connector manifests because `packages/reference-contract` never declared it.
   Authors rely on the contract package for authoring signals; an undeclared
   field is invisible.

2. **`DETAIL_COVERAGE` emitted message** — `connector-runtime-protocol.ts:145`
   defines `DetailCoverageMessage` (required_keys, hydrated_keys, gap_keys,
   optional_skip_keys, state_stream, stream, reference_only: true). ChatGPT's
   `makeConversationDetailCoverage` at index.ts:1739 is the only builder; it
   is inlined with no exports and no shared abstraction. The contract has no
   requirement that list+detail connectors emit this message.

## Decision: Two tranches, smallest first

### Tranche A: Promote `coverage_policy` to the reference-contract manifest schema

The field already exists in runtime logic. Making it part of the reference-
contract schema is the smallest safe change:

- It costs zero connector edits — the field is optional with a sensible
  implicit default (`collect`).
- It immediately makes the field visible to connector authors and validatable by
  any JSON Schema consumer.
- It unblocks dashboard honesty: once connectors start declaring `unavailable`
  or `unsupported` per-stream, the coverage axis projects correctly without
  server-side guesswork.

**Why not add coverage_policy to all 31 manifests immediately?** Doing so
requires knowing per-stream coverage posture for every connector. That is a
correctness decision, not a schema change. Wrong values produce worse dashboard
output than no values. The right path is: (1) publish the contract, (2) let
owners add per-stream policy deliberately per connector.

**Alternative: add coverage_policy as a top-level manifest field instead of
per-stream?** Rejected. Per-stream granularity is already the correct model
(`readAcceptedCoveragePolicy` operates stream-by-stream; `pickAcceptedCoverage`
picks the highest-precedence across streams). A per-stream policy lets a
connector say "messages=unsupported but conversations=collect" — which is
exactly what ChatGPT needs for its unreachable voice transcripts. A top-level
field would lose that precision.

### Tranche B: `emitDetailCoverage` shared helper + contract requirement

**Why a shared helper?**
ChatGPT's builder is 14 lines inlined in a 2000-line file. The `DetailCoverageMessage`
type is exported from `connector-runtime-protocol.ts` but has no usage
documentation or helper. A developer adding a new detail lane must:
1. Know `DETAIL_COVERAGE` exists.
2. Find ChatGPT as the example.
3. Understand the field semantics (required vs. hydrated vs. gap vs. optional).
4. Build their own inline wrapper.

An exported `emitDetailCoverage(ctx, params)` on the connector runtime surface
turns this into a one-liner. The name parallels `ctx.progress()`, `ctx.state()`,
`ctx.emit()` — consistent with the existing helper surface.

**Why a contract requirement?**
Without a requirement, the helper is a convenient option but connectors
continue emitting nothing. The dashboard stays guessing for new connectors.
The requirement is: "a connector that runs a detail lane SHALL emit
`DETAIL_COVERAGE` once per run". This is a cross-connector normalization
requirement, not a per-connector audit.

**Honesty constraint:** The requirement applies to connectors that structurally
have a list+detail lane. API-only connectors that emit a flat stream with no
per-record detail fetch are exempt (they have no `required_keys` concept).
The contract SHALL specify the scope clearly.

### Why NOT add coverage_policy to connector-runtime-protocol.ts?

`coverage_policy` is a manifest-side field that constrains server-side
projection. It is NOT an emitted message. The connector emits `SKIP_RESULT`
when it cannot fetch a stream; the server reads `coverage_policy` from the
manifest to decide whether a missing stream is accepted. Mixing them would blur
the manifest / runtime boundary.

### Why NOT add DETAIL_COVERAGE to the accepted-coverage axis logic?

`DETAIL_COVERAGE` is a per-run message that counts keys. `coverage_policy` is a
static manifest declaration about structural limits. They answer different
questions: `DETAIL_COVERAGE` answers "of the N items I tried, how many worked?"
while `coverage_policy` answers "does this connector structurally support this
stream?" Both are needed; neither replaces the other.

## Schema design for coverage_policy in reference-contract

The manifest stream schema currently in `packages/reference-contract/src/
reference/index.ts` does not expose coverage_policy. The addition:

```typescript
coverage_policy: z.enum([
  "collect",
  "deferred",
  "inventory_only",
  "unavailable",
  "unsupported",
]).optional(),
```

Rationale for including `collect` in the enum (even though it is the implicit
default): explicit declaration is clearer than absence. A connector that wants
to assert "this stream is intentionally collected" can do so. The server's
`readAcceptedCoveragePolicy` returns `null` for `collect` (treat as "no special
policy"), which is the correct behavior — `collect` is not an accepted-coverage
label, just an explicit default.

## Connector runtime helper API

```typescript
// packages/polyfill-connectors/src/connector-runtime.ts
export function emitDetailCoverage(
  ctx: ConnectorContext,
  params: {
    stream: string;
    stateStream: string;
    requiredKeys: Array<string | number>;
    hydratedKeys: Array<string | number>;
    gapKeys?: Array<string | number>;
    optionalSkipKeys?: Array<string | number>;
  }
): void
```

Internally calls `ctx.emit({ type: "DETAIL_COVERAGE", reference_only: true,
...params })`. The function has no return value because it is a fire-and-forget
emission, matching the `ctx.progress()` pattern.

Naming: `emitDetailCoverage` over `ctx.detailCoverage` because the function is a
module-level export (like `emitSkipResult`), not a method on the context object.
This is consistent with the existing helper surface in connector-runtime.ts.

## Acceptance checks

1. `openspec validate add-universal-connector-coverage-evidence --strict` passes.
2. Tranche A: `npx tsc --noEmit` (packages/reference-contract) — no errors.
3. Tranche A: existing reference-contract schema tests pass with the new field
   present.
4. Tranche B: `emitDetailCoverage` unit test — emits a valid `DETAIL_COVERAGE`
   message; required fields present; optional fields absent when not provided;
   `reference_only: true` always set.
5. Tranche B: ChatGPT test still passes after refactoring its inline builder to
   use `emitDetailCoverage`.
6. No connector manifests changed by this PR (policy adoption is owner-gated).

## Out of scope

- Adding `coverage_policy` to individual connector manifests (owner-gated
  per-connector decision, separate from the contract change).
- Requiring existing connectors to adopt `emitDetailCoverage` retroactively
  (separate per-connector adoption tranches).
- Changing `mapCoverageAxis` or `buildCoverageEvidence` server logic — the
  server already handles `coverage_policy` correctly once connectors emit it.
- Adding a new CoverageAxis value — the existing set is correct.
- Changing the dashboard UI coverage rendering — already reads the axis correctly.
