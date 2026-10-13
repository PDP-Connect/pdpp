# PDPP Collection Profile

Status: Informative. Pointer to the canonical Collection Profile. Not a conformance requirement of PDPP Core.
Date: 2026-10-13

The Collection Profile is maintained in the PDP-Connect/data-connectors repository: [docs/spec/collection-profile.md](https://github.com/PDP-Connect/data-connectors/blob/main/docs/spec/collection-profile.md). That document is the canonical profile (v0.2.0 when this page was written) and is normative for the connectors and runtimes that claim it. The link follows the main branch, so it shows the latest development text, not a fixed conformance target. A Collection Profile conformance claim names the profile version it claims; PDPP Core v0.1 conformance does not imply one. This page does not restate the profile's requirements.

**Compatibility note.** This page formerly held informative builder guidance labelled Collection Profile v0.1.0 ([historical text](https://github.com/PDP-Connect/pdpp/blob/cba5d6db07bfafc52ae0a7e36c3d49bfb257657b/spec-collection-profile.md)). The canonical profile is not wire-compatible with that guidance in every binding. For example, it replaces the `browser_automation` binding, which carried a CDP WebSocket descriptor, with `browser` and declared features. The canonical profile's Bindings section (3.3) lists each removed binding name and its replacement. PDPP Core v0.1 requirements do not change.

## What the profile covers

- The connector manifest and its runtime bindings.
- The run protocol between a runtime and a connector process, and its messages.
- Diagnostics.
- Connector and runtime conformance, runtime-specific extensions, and profile versioning.

## Relationship to PDPP Core

Core defines no ingest path (Core Section 3). A connector conforms to PDPP by producing a source declaration valid under Core Section 5 and serving its data through a resource server conforming to Core Section 8. No particular collection method is required, and pre-collected data, manual imports and other ingestion mechanisms are equally valid. The Collection Profile describes one collection method and defines no Core requirement.

Records a connector emits use the Core RECORD envelope (Core Section 4). Where the profile and Core overlap, for example delete records carrying their primary-key fields, Core governs the record model.
