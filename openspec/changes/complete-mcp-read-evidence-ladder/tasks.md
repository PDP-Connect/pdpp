# Tasks

## 0. Contract

- [x] 0.1 Capture plan in permanent `docs/research/` corpus.
- [x] 0.2 Add OpenSpec proposal, design, tasks, and spec deltas.
- [x] 0.3 Validate `complete-mcp-read-evidence-ladder --strict`.

## 1. Hostile-Client Tests

- [x] 1.1 Add MCP search test where `structuredContent` is ignored and visible `content[]` still contains a bounded matched text window.
- [x] 1.2 Add test proving visible field-window continuations include a model-callable tool path, not only a resource URI.
- [x] 1.3 Add negative control where metadata-only search hits do not invent a body match.
- [x] 1.4 Add small-text read/fetch test that returns inline content without requiring file/resource materialization.
- [x] 1.5 Add binary/large-text tests preserving bounded metadata and explicit continuation.
- [x] 1.6 Add hosted-client structured-preview regression where `content[]` may be ignored but matched text evidence remains visible in `structuredContent`.

## 2. Resource-Server Evidence

- [x] 2.1 Identify current search hit shapes for lexical, semantic, and hybrid search.
- [x] 2.2 Surface proven lexical match-window metadata from the resource server when it can identify the matched text field.
- [x] 2.3 Keep absence of proven match windows explicit; adapters do not infer body/text fields from names.

## 3. Shared Evidence Primitives

- [x] 3.1 Use adapter-neutral content-ladder field-window helpers for record evidence.
- [x] 3.2 Preserve shared continuation descriptors for tool and resource paths.
- [x] 3.3 Keep binary/base64/blob fields metadata-only by default.

## 4. MCP Adapter

- [x] 4.1 Render proven match windows in visible `content[]` within a strict budget.
- [x] 4.2 Include model-callable continuation instructions for incomplete text.
- [x] 4.3 Preserve resource links for capable clients while keeping small text inline.
- [x] 4.4 Ensure `read_record_field` and `resources/read` agree on bounded field windows.
- [x] 4.5 Surface proven match-window previews in `structuredContent.results[]` and `structuredContent.content_ladder.records[]`.
- [x] 4.6 Hide field-window resource URIs from model-visible `content[]` and `structuredContent`; keep the resource URI only in hidden metadata for capable clients.

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
- [ ] 6.10 Rerun full gates and live-backed MCP smoke after hiding model-visible field-window resource URIs.
