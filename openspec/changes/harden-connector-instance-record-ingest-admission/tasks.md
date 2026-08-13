## 1. Transaction-native admission

- [x] 1.1 Add the opt-in ingest option and central typed lifecycle mapping.
- [x] 1.2 Check admission inside SQLite and PostgreSQL durable transactions.
- [x] 1.3 Opt owner-routed record ingest into the fence.

## 2. Verification

- [x] 2.1 Add deterministic SQLite delete/revoke tests, an owner-batch route proof, and a dedicated-Postgres race lane.
- [x] 2.2 Run acceptance checks: RI typecheck, focused SQLite test, local dedicated-Postgres race test, targeted lint, and strict OpenSpec validation.

## Acceptance checks

- `pnpm --dir reference-implementation typecheck`
- `pnpm --dir reference-implementation exec node --import tsx --test test/connector-instance-record-ingest-admission.test.ts`
- `openspec validate harden-connector-instance-record-ingest-admission --strict`
