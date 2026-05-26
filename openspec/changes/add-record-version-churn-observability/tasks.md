## 1. Contracts

- [x] 1.1 Define the OpenSpec requirement for reference-only version/churn observability.
- [x] 1.2 Validate the change in strict mode before implementation.

## 2. Reference Read

- [x] 2.1 Add a bounded owner-only `GET /_ref/records/version-stats` route.
- [x] 2.2 Implement SQLite and Postgres query paths or a shared active-backend helper.
- [x] 2.3 Add risk classification with simple documented thresholds.
- [x] 2.4 Ensure the route returns grouped metrics only, not raw record payloads.

## 3. Dashboard And Docs

- [x] 3.1 Add lightweight dashboard consumption where it helps owner diagnosis without blocking the records page.
- [x] 3.2 Update generated reference route docs/OpenAPI if applicable.

## 4. Validation

- [x] 4.1 Add focused tests for classification and response shape.
- [x] 4.2 Add at least one backend test or route test proving bounded grouped output.
- [x] 4.3 Run relevant reference tests, route docs checks if applicable, and `git diff --check`.
- [x] 4.4 Run `openspec validate add-record-version-churn-observability --strict`.
