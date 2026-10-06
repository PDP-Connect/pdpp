# PDPP Collection Profile

Status: Informative. Pointer to the canonical Collection Profile. Not a conformance requirement of PDPP Core.
Date: 2026-10-06

The Collection Profile is maintained in the PDP-Connect/data-connectors repository: [docs/spec/collection-profile.md](https://github.com/PDP-Connect/data-connectors/blob/main/docs/spec/collection-profile.md). That document is the canonical profile (v0.2.0 when this page was written) and is normative for the connectors and runtimes that claim it. This page does not restate it, so the two cannot drift.

## What the profile covers

- The connector manifest and its runtime bindings.
- The run protocol between a runtime and a connector process, and its messages.
- Diagnostics.
- Connector and runtime conformance, runtime-specific extensions, and profile versioning.

## Relationship to PDPP Core

Core defines no ingest path (Core Section 3). A connector conforms to PDPP by producing a source declaration valid under Core Section 5 and serving its data through a resource server conforming to Core Section 8. No particular collection method is required, and pre-collected data, manual imports and other ingestion mechanisms are equally valid. The Collection Profile describes one collection method and defines no Core requirement.

Records a connector emits use the Core RECORD envelope (Core Section 4). Where the profile and Core overlap, for example delete records carrying their primary-key fields, Core governs the record model.
