# Bulk Import Bootstrap

Status: captured
Owner: RI owner
Created: 2026-06-04
Updated: 2026-06-04
Related: none

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

## Promotion Trigger

Promote to OpenSpec before adding any operator flow, importer manifest shape, record provenance field, or connector cursor behavior that relies on bulk-import bootstrap.

## Decision Log

- 2026-06-04: Captured as a future feature. Do not implement in the ChatGPT slow-catch-up tranche.
