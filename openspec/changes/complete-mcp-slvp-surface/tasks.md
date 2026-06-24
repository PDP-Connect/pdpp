# Tasks

## 1. Research And Audit

- [x] 1.1 Client matrix audit: current MCP outputs versus ChatGPT, Claude, Codex, content-only, resource-less, and resource-materializing clients.
- [x] 1.2 Handle semantics audit: `pdpp://record`, `pdpp://field-window`, resource templates, `resources/read`, `read_record_field`, and fetch compatibility.
- [x] 1.3 REST and CLI parity audit: search evidence windows, field/window reads, projection, fetch, export, and docs.
- [x] 1.4 Large-data/export audit: large text, JSON fields, blobs, stale handles, binary fields, and materialized-file risks.
- [x] 1.5 Setup/docs audit: package README, tool descriptions, server instructions, hosted metadata, and user-visible error recovery.
- [x] 1.6 Store durable research synthesis under `docs/research/`.

## 2. Contract

- [x] 2.1 Create OpenSpec change from the audit results.
- [x] 2.2 Add durable requirement deltas for client-visible evidence, handles, continuation, export, and parity.
- [x] 2.3 Validate `complete-mcp-slvp-surface --strict` after implementation updates.

## 3. Failing Tests

- [x] 3.1 Add hostile-client matrix tests that fail on invisible-only evidence. (content-only on real RS envelope, resource-less tool-args fallback, file-materializing inline guard)
- [x] 3.2 Add no-dead-end continuation tests for visible handles.
- [x] 3.3 Add REST search evidence envelope tests. (evidence_excerpt field_window_read continuation)
- [x] 3.4 Add CLI bounded field-window read tests. (+ CLI search preserves evidence descriptors)
- [x] 3.5 Add large-text multi-window continuation tests.
- [x] 3.6 Add large-field/blob/export escalation tests. (binary metadata-only, JSON bounded preview + fetch projection, large-text bounded window)
- [x] 3.7 Add setup/docs/tool-instruction invariants.
- [x] 3.8 Add record-resource and field-window resource/tool equivalence tests.

## 4. Implementation

- [x] 4.1 Implement handle semantics and model-callable continuations. (handle_semantics: 'live_lookup'; canonical base64url pdpp://record URI accepted by read_record_field/fetch/resources_read — live blocker B2)
- [x] 4.2 Tighten package docs, hosted docs, tool descriptions, and server instructions.
- [x] 4.3 Implement CLI bounded field-window read.
- [x] 4.4 Implement REST evidence parity. (server evidence_excerpts surfaced in visible MCP search content — live blocker B1; REST excerpt read continuation; CLI passthrough)
- [x] 4.5 Implement large-text multi-window visible continuations.
- [x] 4.6 Implement JSON/blob/export metadata and escalation behavior. (json_fields bounded preview + fetch projection; binary metadata-only)
- [x] 4.7 Implement revision or typed stale-handle semantics. (handle_semantics: 'live_lookup' typed contract on every ladder entry + field-window resource)

## 5. Verification

- [x] 5.1 Run read-evidence tests. (11/11)
- [x] 5.2 Run MCP server tests. (165/165)
- [ ] 5.3 Run hosted MCP OAuth/reference tests.
- [x] 5.4 Run REST/CLI parity tests. (cli read 9/9; rs-search 98/98)
- [x] 5.5 Run export/large-data tests. (hostile-client large-field/blob/JSON escalation)
- [x] 5.6 Run `openspec validate complete-mcp-slvp-surface --strict`.
- [ ] 5.7 Run `openspec validate --all --strict`.
- [ ] 5.8 Run `git diff --check`.
- [ ] 5.9 Merge to main only after green gates and review.
- [x] 5.10 Deploy with live-stack mutex and smoke deployed revision. (`v0.15.0-4-g72df54ec1`)
- [x] 5.11 Run fresh ChatGPT client retest and record result under `docs/research/`.

## 6. SLVP-Ideal Retest Closeout

- [x] 6.1 Add REST lexical-search regression proving `evidence_excerpts.preview_text` includes bounded surrounding context, not only the marked query term.
- [x] 6.2 Widen SQLite and Postgres lexical snippets so ordinary matched text is classification-useful in search results.
- [x] 6.3 Remove ordinary `read_record_field` `pdpp://field-window/...` resource exposure from model-visible structured output when the explicit `read_record_field` continuation is the reliable path.
- [x] 6.4 Update hostile-client and server integration tests to assert no dead field-window resource handle is visible on ordinary bounded reads.
- [x] 6.5 Merge, deploy, and live-smoke contextual search evidence plus no visible field-window resource handle before another ChatGPT retest.
