# Bulk Import Bootstrap

Status: captured
Owner: RI owner
Created: 2026-06-04
Updated: 2026-06-04
Related: `design-notes/passthrough-resource-server-mode-2026-06-04.md`, `design-notes/source-authority-vs-schema-identity-2026-04-30.md`, `design-notes/connector-public-listing-honesty-2026-05-15.md`, `design-notes/connector-catalog-vs-connection-lifecycle-2026-06-02.md`

## Question

Should the reference implementation support bulk imports that bootstrap a connection from exported artifacts, so browser/API collection only has to cover incremental updates afterward?

## Context

Some sources provide downloadable archives: GDPR/portability exports, account data exports, backup files, CSV/JSON archives, local app databases, or user-supplied artifacts. For ChatGPT, a bulk export could hydrate much of the historical conversation corpus, leaving the browser connector to collect only records changed or created after the export window.

This should not be limited to GDPR exports. The broader capability is artifact-backed connection bootstrap.

## Stakes

Bulk imports can make large histories practical without source throttling, but they introduce schema and provenance problems. A source's export schema may not match the browser/API schema, may omit fields visible in the live app, may include extra fields unavailable live, or may use different identifiers and timestamps. If the import is treated as equivalent to scraped data without proof, the server can silently create gaps or duplicates.

## Current Leaning

Model bulk import as an explicit connection bootstrap phase:

- The imported artifact has its own provenance: source, export time, file hash, parser version, and declared coverage.
- Importers map source-specific export schemas into PDPP streams using the same record identity rules as live connectors where possible.
- Schema mismatches are first-class: fields can be `import_only`, `live_only`, `normalized`, `missing`, or `unverified`.
- The live connector should dedupe against imported records and establish a cutover cursor/window for incremental collection.
- The dashboard should distinguish imported historical coverage from live incremental coverage until both paths are reconciled.
- Arbitrary imports should be allowed only through a declared parser/manifest, not by pretending unknown files are source-equivalent.

## Open Questions

These are unresolved and should be answered in architecture mode before promotion:

- Schema mismatches: how are `import_only` / `live_only` / `normalized` / `missing` / `unverified` field states represented per stream and surfaced to readers, and how does a query over a mixed corpus behave when a filtered/sorted field exists only in one path?
- Cursor alignment: how is the cutover between imported history and live incremental collection expressed so the live connector neither re-collects the imported window nor skips records created between the export's coverage boundary and the first live run? Export coverage is often fuzzy (an "as of" time that lags the file's contents).
- Provenance: imported records carry artifact provenance (source, export time, file hash, parser version, declared coverage) distinct from live-run provenance; the read surface should let a consumer tell which path produced a record.
- Storage and indexing: imported corpora can be large; what indexing and dedupe strategy keeps import + live reconciliation correct without doubling storage or producing duplicate/ghost records?
- Query/filter capability gaps: a field present only in the import (or only live) changes what filters and sorts can be honestly answered over the unified stream until both paths are reconciled.
- Agent understanding of incomplete support: an MCP/agent consumer should be able to tell that a connection's coverage is import-backed historical vs. live incremental, and that some fields/streams are not yet reconciled, so it does not treat partial historical coverage as complete. Reuse the existing maturity/coverage honesty vocabulary rather than a parallel one.

## Promotion Trigger

Promote to OpenSpec before adding any operator flow, importer manifest shape, record provenance field, or connector cursor behavior that relies on bulk-import bootstrap.

## Decision Log

- 2026-06-04: Captured as a future feature. Do not implement in the ChatGPT slow-catch-up tranche.
- 2026-06-04: Added explicit Open Questions (schema mismatches, cursor alignment, provenance, storage/indexing, query/filter capability gaps, agent understanding of incomplete support) and linked related notes, to make the note useful for later architecture mode. Still non-normative; no spec change.
