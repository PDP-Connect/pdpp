## Context

The owner console needs one honest visual contract for record identity. Before this change, each Explore surface assembled its own identity line and the detail page could render a raw record key as the primary header.

## Decision

Introduce `RecordIdentity` in `@pdpp/operator-ui` and route the feed row, stream table cell, mobile card, and detail-page header through it. The component consumes `RecordPreview` output and the record key; it does not inspect arbitrary field names to invent title semantics.

Declared display roles remain confident primary content. Undeclared or id-only records remain derived and quiet. Machine keys are only rendered through the key slot, using mono/muted treatment.

## Alternatives Considered

- Keep per-surface rendering and patch the detail header only. Rejected because it would leave four interpretations of the same record identity and regress cross-surface parity.
- Promote common field names like `title`, `name`, or `merchant`. Rejected because that guesses semantics from field names rather than relying on manifest-authored roles.

## Acceptance Checks

- The same record has the same primary identity across feed, table, card, and detail header.
- An id-only record never renders its key as a confident bold detail title.
- Undeclared `title` or `name` fields do not become a manifest-authored primary title.
- Mono typography is limited to machine keys and ids, not prose primary content.
