## 1. Contract And Request Parsing

- [ ] 1.1 Update lexical retrieval parsing so `filter[...]` is accepted only when exactly one `streams[]` value is present.
- [ ] 1.2 Update semantic retrieval parsing with the same filtered-request gate.
- [ ] 1.3 Reuse the record-list filter validator for exact filters, range filters, operator support, field authorization, and value coercion rather than adding a second filter grammar.
- [ ] 1.4 Preserve explicit rejection for ranking knobs, sort, expansion, connector-specific parameters, raw vectors, model selectors, score/debug parameters, and arbitrary DSL-shaped parameters.

## 2. Execution

- [ ] 2.1 Apply filters as server-side candidate constraints before returning lexical results.
- [ ] 2.2 Apply filters as server-side candidate constraints before returning semantic results.
- [ ] 2.3 Ensure owner-token filtered search works across owner-visible connectors for the single named stream and preserves `connector_id` attribution.
- [ ] 2.4 Ensure client-token filtered search respects grant stream, field projection, time/resource restrictions, declared searchable fields, and declared semantic fields.

## 3. Tests

- [ ] 3.1 Add lexical search tests for a successful declared range filter, exact filter, and no-match filter.
- [ ] 3.2 Add semantic search tests for a successful declared range filter and no-match filter.
- [ ] 3.3 Add rejection tests for filters without `streams[]`, filters with multiple `streams[]`, unauthorized fields, undeclared range fields, unsupported operators, malformed values, and still-forbidden search parameters.
- [ ] 3.4 Add owner-token tests proving filtered search fans out by stream across connectors without accepting public `connector_id`.

## 4. Docs And Validation

- [ ] 4.1 Update retrieval docs to describe the single-stream filtered search rule and point clients to stream metadata for `query.range_filters`.
- [ ] 4.2 Document cross-stream filtered search, score/reranking, and caller-controlled hybrid ranking as deferred.
- [ ] 4.3 Run `openspec validate add-filtered-retrieval-search --strict`.
- [ ] 4.4 Run `openspec validate --all --strict`.
- [ ] 4.5 Run relevant reference implementation tests for lexical retrieval, semantic retrieval, and record filter validation.
