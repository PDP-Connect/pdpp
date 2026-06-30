## Context

The refresh synthesis places `connection` and `device` in the reference layer, not PDPP Core. The read surface may expose `connection_id` as grant-safe attribution, but collection mechanics such as upload, local export, browser automation, and provider OAuth must not become stream identity.

Google Maps forced this distinction: Timeline import and Data Portability are different acquisition paths with different provider guarantees, but future normalized Maps streams should not fork just because records arrived through a file or an API. At the same time, merging records from two paths under one `connection_id` without a proven account/source identity would create false attribution.

The ChatGPT fetch report exposed the other side of the same construction value: even when `structuredContent.results` is correct, some hosts display only clipped text. The first usable fetch handle must be visible before verbose metadata.

## Goals / Non-Goals

**Goals:**

- Pin the SLVP ideal construction for multipath stream reuse: stream definition is reusable; acquisition path is provenance; `connection_id` remains the source/disclosure identity.
- Keep the immediate implementation small: harden the MCP visible search summary and add tests for the model-visible path.
- Preserve the existing Google split: `google_maps` Timeline import and `google-maps-data-portability` API source remain separate until a later identity-linking tranche proves they can coalesce.

**Non-Goals:**

- No generic multi-binding connection merge implementation.
- No Google Maps Data Portability live OAuth credentials or archive parser work.
- No change to REST record ids, storage schema, grants, or query semantics.
- No attempt to force all MCP hosts to display `structuredContent`.

## Decisions

1. **Reuse stream definitions without using acquisition path as stream identity.**

   Streams describe record shape and semantics. A connector/source path may emit the same stream definition as another path when the record shape and semantics match. The durable row still belongs to a single `connector_instance_id`.

2. **Default to separate connections unless identity is proven.**

   A file export, provider OAuth account, and browser/local collector binding are not automatically the same source. They may populate a shared normalized stream family under separate connections. Coalescing them under one connection requires an explicit source-identity rule that is at least as strong as the owner-facing claim.

3. **Keep acquisition path as provenance.**

   Path metadata belongs in source binding, run metadata, coverage, and per-record provenance fields where useful. It does not replace `connection_id`, and clients should not need a path selector for normal reads.

4. **Put `first_fetch_id` before source mix metadata.**

   `structuredContent.results` remains canonical, and preview result lines continue to show ids. The hardening adds a redundant first-line `first_fetch_id=<handle>` before `source_mix`, because source mix can be long enough for hosted-client previews to clip the top result lines.

## Risks / Trade-offs

- **Risk: Redundant first handle text increases search summary bytes.** Mitigation: one handle is small relative to existing result previews, and it prevents a real model-visible failure.
- **Risk: Multipath wording could imply implemented coalescing.** Mitigation: the spec explicitly says coalescing requires a later explicit identity rule; this tranche does not merge paths.
- **Risk: Same stream names across connections stay ambiguous.** Mitigation: the existing `schema(stream, connection_id)` and self-contained fetch-id behavior remain the disambiguation mechanisms.
