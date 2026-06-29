# Tasks

## 0. Contract

- [x] 0.1 Capture the plan in the permanent `docs/research/` corpus.
- [x] 0.2 Add OpenSpec proposal, design, tasks, and spec deltas.
- [x] 0.3 Validate `complete-mcp-read-evidence-ladder --strict`.

## 1. Hostile-Client Tests

- [x] 1.1 Add MCP search coverage where `structuredContent` is ignored and the visible result still carries a bounded matched text window.
- [x] 1.2 Add coverage proving visible field-window continuations include a model-callable tool path, not only a resource URI.
- [x] 1.3 Add a negative control where metadata-only search hits do not invent a body match.
- [x] 1.4 Add small-text read/fetch coverage for inline content without requiring file/resource materialization.
- [x] 1.5 Add binary/large-text coverage that preserves bounded metadata and explicit continuation.
- [x] 1.6 Add hosted-client structured-preview regression coverage where `content[]` may be ignored but matched text evidence remains visible in `structuredContent`.

## 2. Resource-Server Evidence

- [x] 2.1 Identify current search hit shapes for lexical, semantic, and hybrid search.
- [x] 2.2 Surface proven lexical match-window metadata from the resource server matched text field.
- [x] 2.3 Keep proven match windows explicit; adapters do not infer body/text fields.

## 3. Shared Evidence Primitives

- [x] 3.1 Use adapter-neutral content-ladder field-window helpers.
- [x] 3.2 Preserve explicit continuation metadata.
- [x] 3.3 Keep binary/base64/blob fields metadata-only by default.

## 4. MCP Adapter

- [x] 4.1 Render proven match windows in visible output within a strict budget.
- [x] 4.2 Include model-callable `read_record_field` continuation hints.
- [x] 4.3 Return bounded field windows with truthful truncation and match metadata.
- [x] 4.4 Return ordinary small projected fetches inline.
- [x] 4.5 Preserve resource support for capable clients.
- [x] 4.6 Hide field-window resource URIs from model-visible output so hosted clients do not see dead handles.

## 5. CLI and Documentation

- [x] 5.1 Keep CLI/read-evidence field-window behavior aligned with shared primitives.

## 6. Verification

- [x] 6.1 Run focused `packages/read-evidence` tests.
- [x] 6.2 Run focused hostile MCP tests.
- [x] 6.3 Run resource-server lexical match-window regression.
- [x] 6.4 Run full MCP server tests.
- [x] 6.5 Run reference implementation typecheck.
- [x] 6.6 Run OpenSpec validation for this change and all active specs.
- [x] 6.7 Run `git diff --check`.
- [x] 6.8 Prepare LAND/HOLD summary with residual hosted-client smoke status.
- [x] 6.9 Rerun full gates and live-backed MCP smoke after structured-preview fix.
- [x] 6.10 Rerun full gates and live-backed MCP smoke after hiding model-visible field-window resource URIs.
- [x] 6.11 Add hostile-client coverage proving visible `pdpp://record/...` handles are accepted by `read_record_field.id`.
