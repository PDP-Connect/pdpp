## Context

PDPP intentionally separates readable fields from searchable fields. A field in `schema.properties` is not automatically indexed; a connector must declare `query.search.lexical_fields` or `query.search.semantic_fields`. That is the right minimization boundary, but it creates an authoring obligation: supported connectors must not expose useful owner-visible text while failing to declare how clients can retrieve it.

The same applies to presentation roles. A field type says how a value formats. A role says what slot the value fills: primary title, secondary text, event time, actor, amount, or media. Clients should not guess this from field names when the connector author knows it.

## Decision

Supported connector manifests shall declare the semantic affordances they know:

- Natural-language top-level string fields that are useful for owner retrieval declare lexical search.
- Meaning-bearing free-text/title/body fields declare semantic search unless there is an explicit exclusion reason.
- Every stream declares at least one `x_pdpp_role` field.
- No stream declares more than one `primary-title`.
- The reference schema and MCP compact schema preserve role flags so clients can use them without inspecting raw manifest JSON.

This change treats tests as the authoring guide's enforcement layer. The prose guide explains why; the tests prevent drift.

## Alternatives

- **Infer from field names at runtime.** Rejected. It creates plausible but wrong rows and hides connector-specific knowledge from review.
- **Search every string field automatically.** Rejected. It would index identifiers, URLs, hashes, MIME types, and status codes that are not natural-language evidence.
- **Write only a connector guide.** Rejected. Documentation without a manifest-honesty gate is too easy to miss.

## Acceptance Checks

- All supported connector streams have at least one declared presentation role.
- No supported connector stream has duplicate `primary-title` roles.
- Natural-language string fields are either lexical/semantic searchable as appropriate or fail the manifest-honesty test.
- Compact schema output carries `role=<value>` alongside type/search/filter flags.
- The guide cites prior art and stays short enough to be used during connector review.

## Residual Risks

- Some role choices are necessarily first-pass for inventory/stat streams. The role-honesty test prevents missing declarations, but product-specific review can still improve which role is primary.
- Adding search declarations may require semantic backfill/index rebuilds on deployed instances.
