## Why

Several first-party connector manifests expose owner-visible natural-language fields as readable schema fields without declaring the retrieval and presentation affordances clients need to use them well. The concrete trigger was WhatsApp `messages.content`: it was granted/readable but not advertised as lexical or semantic searchable. The same pattern existed in other supported connectors.

This leaves useful semantics on the table. Search clients cannot discover relevant fields, Explore surfaces fall back to generic rows, and MCP clients must infer too much from field names.

## What Changes

- Add missing `query.search.lexical_fields` and `query.search.semantic_fields` declarations for supported connector natural-language fields.
- Add `schema.properties[field].x_pdpp_role` declarations across supported connector streams so every stream has a presentation role.
- Project `x_pdpp_role` through reference `field_capabilities` and compact schema flags.
- Add manifest-honesty tests that fail when a supported connector omits natural-language search affordances or presentation roles.
- Add prior-art-backed connector authoring guidance so future connector authors have a short checklist backed by enforcement.

## Capabilities

Modified:

- `reference-implementation-architecture`

## Impact

- Affected code: reference schema projection, MCP schema compaction, connector manifests, manifest tests, connector authoring docs.
- Validation: manifest-honesty tests, compact schema formatter tests, OpenSpec strict validation.
- Risk: broader semantic indexing declarations can trigger index rebuilds for changed streams. This is expected; the declarations describe already-granted owner-visible fields.
