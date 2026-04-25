## Why

The reference now exposes lexical and semantic retrieval with scores, but assistants still have to call both endpoints and merge results client-side. A server-side hybrid endpoint would make the recall layer simpler, safer, and easier to evaluate.

## What Changes

- Define an optional experimental hybrid retrieval extension that combines lexical and semantic retrieval into one grant-safe result list.
- Advertise the extension only when both underlying retrieval surfaces are available and compatible.
- Preserve the existing lexical and semantic endpoints unchanged.
- Define result provenance so clients can see whether a record matched lexical, semantic, or both.

## Capabilities

### New Capabilities

- `hybrid-retrieval`: optional experimental retrieval extension combining lexical and semantic recall.

### Modified Capabilities

- `lexical-retrieval`: clarify that hybrid retrieval does not change `/v1/search`.
- `semantic-retrieval`: clarify that hybrid retrieval does not change `/v1/search/semantic`.

## Impact

- `openspec/specs/hybrid-retrieval/spec.md`
- `reference-implementation/server/index.js`
- `reference-implementation/server/search*.js`
- `reference-implementation/test/lexical-retrieval.test.js`
- `reference-implementation/test/semantic-retrieval.test.js`
- `packages/reference-contract/src/public/index.ts`
- dashboard search may consume the endpoint after the API is proven
