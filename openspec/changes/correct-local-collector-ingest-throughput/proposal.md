# Why

Device-exporter ingest currently waits for the complete record-plus-derived-index
path for each record and only writes an outcome after the whole batch succeeds.
The resulting throughput exhausts the collector drain budget, and an index
failure after an authoritative commit cannot safely be repaired by a retry.

# What Changes

- Turn device batch outcomes into durable `processing`/`accepted` reservations
  with canonical request identity and an atomically advanced record prefix.
- Separate the existing authoritative record transaction from idempotent
  final-state index repair without changing general ingest or Postgres
  projection semantics.
- Coordinate every same-instance authoritative/index writer with one re-entrant
  fence; bound batch and semantic work; make local-transformer computation
  killable and safely fenced.
- Preserve only safe diagnostics and require SQLite/real-Postgres proof plus a
  measured local-transformer concurrency selection.

# Impact

Reference device-exporter ingest, record/index write seams, writer/backfill
coordination, device diagnostics, and their SQLite/PostgreSQL stores. No PDPP
protocol change, deploy, client timeout increase, batch reduction, deferred
index acknowledgement, event outbox, or Postgres projection redesign.
