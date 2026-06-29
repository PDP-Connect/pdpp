# Tasks

## 1. Adapter implementation

- [x] 1.1 Encode the hit connection into search result ids
      (`{connection_id}/{stream}:{record_id}`) in `normalizeSearchResults`,
      wrapping only record-shaped base ids.
- [x] 1.2 Parse both id grammars in `fetch` (`parseRecordResultId` splits the
      connection segment at the first `/`; every segment passes
      `requireSafeName`) and forward the embedded connection as the canonical
      `connection_id` query parameter.
- [x] 1.3 Reject a self-contained id whose embedded connection disagrees with
      an explicit `connection_id` argument with a typed
      `conflicting_connection_id` error before any RS call.
- [x] 1.4 Stop repeating `connection_id=` in search `content[]` preview lines
      when it is embedded in the id; raise the preview id bound from 80 to 200
      chars so handles stay complete; update the fetch hint line.
- [x] 1.5 Carry the embedded connection into constructed citation URLs
      (`?connection_id=...`).
- [x] 1.6 Update tool descriptions, the `fetch` id input description, the
      search output-schema description, server instructions, and the package
      README for the new grammar.

## 2. Regression coverage

- [x] 2.1 Multi-source journey test per the model-visible-journey canon rule:
      consume only `content[]` text, extract the id, complete search→fetch
      with no `connection_id` argument against a fixture whose unscoped record
      reads return typed 409 `ambiguous_connection`
      (`test/self-contained-result-id.test.js`).
- [x] 2.2 Backcompat pins: legacy `stream:record_id` unscoped still surfaces
      the typed 409; legacy id + explicit `connection_id` unchanged
      (new file plus existing `connection-id-forwarding.test.js`).
- [x] 2.3 Conflict, traversal/malformed-segment, matching-explicit-argument,
      and no-connection passthrough pins.
- [x] 2.4 Update existing pins to the new contract
      (`server.integration.test.js`, `record-payload-token-budget.test.js`)
      and re-run the footprint/token-budget suites within their budgets.

## 3. Validation

- [x] 3.1 Full `packages/mcp-server` suite green (127 tests; was 120).
- [x] 3.2 `openspec validate --all --strict` green.
