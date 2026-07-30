## Why

Connector summaries must remain fresh without making an owner read mutate
durable state or fan out with fleet size. Durable connector-summary evidence is
a repairable derived projection; it is not the rendered-summary authority.

## What Changes

- Maintain evidence through transactional dirty signals and a durable
  maintenance sweep.
- Keep `GET /_ref/connectors` read-only; it observes only the requested page.
- Reconcile record, schedule, and run-lifecycle checkpoints from canonical
  durable state, with SQLite/PostgreSQL parity.
- Preserve exact scoped diagnostic reads and read-time synthesis.

## Impact

This modifies the `reference-connector-instances` capability. The complementary
`scale-connector-summary-read-path` change owns the bounded page contract and
its console client integration.
