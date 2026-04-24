## 1. Design Confirmation

- [x] 1.1 Audit existing record filter helpers and `_ref/dataset/summary` for reusable logic.
- [x] 1.2 Decide endpoint shape, query parameters, response envelope, and error codes.
- [x] 1.3 Decide manifest declaration shape for countable, summable, min/max, and groupable fields.

## 2. Manifest And Contract

- [x] 2.1 Add manifest validation for `query.aggregations`.
- [x] 2.2 Add aggregation capability metadata to stream metadata.
- [x] 2.3 Add route contract schema and generated OpenAPI/docs.

## 3. Runtime

- [x] 3.1 Implement single-stream count aggregation under grant projection.
- [x] 3.2 Implement numeric sum and numeric/date min/max for declared fields.
- [x] 3.3 Implement bounded grouped counts for declared groupable scalar fields.
- [x] 3.4 Reuse exact/range filter validation and coercion.
- [x] 3.5 Reject cross-stream, unauthorized, undeclared, malformed, and excessive requests.

## 4. First-Party Coverage

- [x] 4.1 Add conservative aggregation declarations for YNAB transactions and Chase/USAA transaction streams.
- [x] 4.2 Add communication-volume count/group declarations only where they do not expose sensitive free text.
- [x] 4.3 Document deliberately excluded fields.

## 5. Tests

- [x] 5.1 Add query-contract tests for count, sum, min/max, grouped count, and filters.
- [x] 5.2 Add grant-safety tests for unauthorized aggregate and group fields.
- [x] 5.3 Add manifest validation tests for unsafe declarations.
- [x] 5.4 Add first-party manifest regression tests for declared aggregation fields.

## 6. Validation

- [x] 6.1 Run targeted query-contract tests.
- [x] 6.2 Run first-party manifest validation tests.
- [x] 6.3 Run reference implementation verify.
- [x] 6.4 Run contract generation checks.
- [x] 6.5 Run `openspec validate add-grant-safe-query-aggregations --strict`.
- [x] 6.6 Run `openspec validate --all --strict`.
- [x] 6.7 Run `git diff --check`.
