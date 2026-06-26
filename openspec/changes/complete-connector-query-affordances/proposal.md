## Why

The first connector semantic-affordance pass made message-like text searchable and added presentation roles, but the live audit still found useful query semantics left implicit: time fields without range or bucket declarations, owner-recognizable fields without search/facet affordances, and ambiguity between presentation `event-time` roles and query-time date affordances.

This keeps clients from building bounded, honest reads without connector-specific guessing.

## What Changes

- Define a follow-up authoring contract for first-party connector manifests: searchable text, range-filterable time fields, time-bucket aggregation fields, and facet/equality fields must be declared when the connector author knows they are useful and safe.
- Preserve the boundary that `x_pdpp_role` is presentation metadata, not a substitute for range filters, search fields, or aggregation declarations.
- Add manifest-honesty checks and explicit allowlist justifications for intentionally unsupported useful affordances.
- Update connector authoring guidance after prior-art research, with concise rules that connector authors can actually use.

## Capabilities

Modified:

- `polyfill-runtime`

## Impact

- Affected code: first-party connector manifests, manifest schema validation/honesty checks, connector authoring docs.
- Validation: manifest-honesty tests, reference schema/compact schema checks where affordances project into field capabilities, MCP/client schema tests as needed, OpenSpec strict validation.
- Risk: adding search, range, or aggregation declarations can require index rebuilds or expose new query paths over already-granted fields. The tranche must prefer schema-compatible declarations and explicit non-support over invalid or guessed affordances.

