## Why

Assistants need to search useful personal-data slices such as "email from last week" or "large attachments" without first retrieving broad result sets and filtering locally. The current lexical and semantic retrieval contracts explicitly reject `filter[...]`, while record-listing already has grant-safe exact and declared range filtering. That mismatch blocks safe filtered search guidance.

## What Changes

- Allow `GET /v1/search` and `GET /v1/search/semantic` to accept record-list compatible `filter[...]` parameters in a deliberately narrow first tranche.
- Require filtered search requests to name exactly one `streams[]` value so field validity, grant projection, and range-filter declarations are unambiguous.
- Reuse existing per-stream filter rules: exact filters on authorized top-level scalar fields, and range filters only for fields declared in `query.range_filters` with supported operators.
- Require retrieval candidates to satisfy filters before they can contribute matches, ranking, snippets, or semantic ranking.
- Keep ranking knobs, caller-controlled hybrid weights, portable score fields, expansion, sort, connector-specific query semantics, and cross-stream filtered search out of scope.

## Capabilities

### Modified Capabilities

- `lexical-retrieval`: narrow the v1 lexical search surface to permit grant-safe stream-scoped filters.
- `semantic-retrieval`: narrow the experimental semantic search surface to permit the same grant-safe stream-scoped filters.
- `reference-implementation-architecture`: add reference implementation obligations for filtered search validation, execution, and tests.

### Added Capabilities

*(none)*

### Removed Capabilities

*(none)*

## Impact

- `reference-implementation/server/search*.js` request parsing and execution paths.
- Search capability tests for both lexical and semantic retrieval.
- Manifest/query metadata tests only as needed to prove declared range filters are honored.
- Documentation for retrieval filters after implementation lands.
