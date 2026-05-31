## Why

When a connector emits `SKIP_RESULT` with a `diagnostics` payload (the connector-runtime protocol already declares the field), the reference runtime drops it before writing the `run.stream_skipped` spine event. USAA's CSV export failures produced a rich `PageDiagnostics` plus `BodyResponseDiagnostics` object at the moment of failure (page url/title, dialog state, response candidates, MIME types, CDP errors). None of that reaches the persisted timeline, so the owner sees only `reason: "export_no_download"` and a short message such as `Checking: export_artifact_wait_failed at unknown url`. The artifact-side investigation cannot proceed without another live human run.

This change is bounded: forward the existing `SKIP_RESULT.diagnostics` field through the validator, the `known_gap`, and the `run.stream_skipped` spine event payload, with the same secret-redaction and length-bounding contract the runtime already applies to other connector-authored strings.

## What Changes

- Validate `SKIP_RESULT.diagnostics` shape (object only, not array; bounded JSON size) on receipt.
- Land bounded, redacted `diagnostics` on the `known_gap` produced for a `SKIP_RESULT`.
- Include the bounded `diagnostics` on the `run.stream_skipped` spine event `data` block.
- Reuse the existing secret-redaction / length-bound helper used by `boundGapString`; truncate string fields, cap total JSON size, drop unsupported value types.
- Keep `SKIP_RESULT.diagnostics` owner/control-plane evidence only. Do not expose it through `/v1` grant-scoped reads.
- Sibling to `persist-connector-failure-diagnostics`: that change covers `run.failed` (connector exit before `DONE`). This change covers `run.stream_skipped` (connector-authored skip, run continues).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reference-implementation-architecture`: add a reference-runtime requirement that bounded, redacted `SKIP_RESULT.diagnostics` propagate to the `run.stream_skipped` spine event and to the corresponding `known_gap`.

## Impact

- `reference-implementation/runtime/index.js` — extend `validateSkipResultMessage`, `buildKnownGap`, and the `SKIP_RESULT` handler to carry diagnostics. Add a `boundGapDiagnostics` helper that redacts/length-bounds nested string fields and caps total JSON byte size.
- `reference-implementation/test/collection-profile.test.js` — assert diagnostics land on the spine event and known gap; assert oversized / malformed payloads are bounded or rejected.
- `packages/polyfill-connectors/connectors/usaa/index.ts` — no protocol change required; the connector already emits `SKIP_RESULT.diagnostics`. Continue emitting it once the runtime propagates it.
- `openspec/specs/reference-implementation-architecture/spec.md` — folded in on archive.
- No `/v1` grant-scoped surface change. The diagnostics live on `run.stream_skipped` events, which are operator/owner timeline data.
