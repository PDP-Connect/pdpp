# MCP SLVP Surface Audit

Status: incorporated into `openspec/changes/complete-mcp-slvp-surface`
Owner: reference implementation
Created: 2026-06-24

## Question

Does the current PDPP MCP surface meet the full SLVP bar, not just the ChatGPT Slack read-evidence closeout?

## Verdict

No. The ordinary text evidence journey is close and has live ChatGPT proof. The full SLVP surface still fails on setup/doc drift, tool metadata clarity, REST/CLI parity, large JSON/blob/export escalation, and revision/stale-handle semantics.

This does not invalidate the shipped ChatGPT closeout. It means the next tranche must raise the whole read surface to the same ladder:

```text
compact discovery -> bounded visible evidence -> explicit bounded field/window read -> fetch/export only when needed
```

## What Already Passes

- ChatGPT ordinary Slack-message classification can use visible search evidence and `read_record_field` without file materialization.
- `read_record_field` is correctly treated as essential MCP read complexity, not an incidental sixth tool.
- `pdpp://record/...` can be accepted by bounded read tooling.
- MCP hostile-client tests cover content-only ordinary text search/read and metadata-only no-invention controls.
- Field-window resource URIs are not the ordinary visible continuation path, which avoids depending on unreliable hosted-client resource readers.

## Remaining SLVP Gaps

### Client Matrix

Content-only and structured-aware paths have partial coverage. ChatGPT has live proof for ordinary text. Claude, Codex, generic resource-aware clients, resource-less clients, and file-materializing clients do not yet have a durable conformance matrix.

Required gates:

- content-only search -> bounded read
- structured-only search -> bounded read
- resource-aware field-window resource read
- resource-less fallback using tool args
- file-materializing host fixture that fails small-evidence resource/file output

### Handle Semantics

The intended contract is operational handle plus explicit tool path, with `resources/read` as a bonus where supported.

Gaps:

- Tool descriptions do not explicitly say `pdpp://record/...` can be passed to `fetch.id` or `read_record_field.id`.
- `read_record_field.id` lacks a description naming accepted formats.
- `resources/read` has stream coverage, but record-resource read coverage is thin.
- No tool accepts `pdpp://field-window/...` directly, so those URIs must stay hidden or be paired with explicit `read_record_field` args.

### REST And CLI Parity

REST already has a field-window route, but it is under-documented and not promoted as a public evidence-ladder contract.

CLI has `read schema`, `read streams`, `read query-records`, `read fetch`, `read search`, and `read aggregate`; it lacks a first-class `read field-window` command. `ref call` is only an escape hatch, not SLVP parity.

Required gates:

- REST search results expose first-class bounded evidence descriptors.
- REST field-window route has documented response shape and tests for continuation metadata.
- CLI has `pdpp read field-window` with `--field`, `--q`, `--offset-chars`, `--limit-chars`, `--before-chars`, and `--after-chars`.
- CLI search output preserves evidence descriptors in JSON and usable summaries in text.

### Large Data And Export Tier

Large text previews are bounded, but a full large-data ladder is not complete.

Gaps:

- Large text content-only continuation does not have enough hostile-client coverage across multiple windows.
- JSON object/array fields are not readable as bounded subtrees.
- Blob/binary fields need metadata, digest, and deliberate resource/export escalation instead of accidental base64/default file output.
- Export jobs need a grant-scoped lifecycle before they become the normal bulk/full-data path.
- Handles do not yet carry clear revision/freshness semantics; clients cannot distinguish stale handles from replacement content without a typed contract.

### Setup And Docs

The package README and server instructions are mostly aligned. Operator-facing docs drifted.

Gaps:

- `docs/operator/hosted-mcp-setup.md` still enumerates a five-tool surface and omits `read_record_field`.
- `docs/operator/selfhost-quickstart.md` overclaims event-subscription management on the normal `/mcp` surface.
- No invariant currently pins docs to `PDPP_MCP_TOOL_NAMES`.
- Troubleshooting copy needs to distinguish client bearer, MCP package bearer, device authorization, stale connector cache, and owner bearer rejection.

## Implementation Order

1. Fix docs/tool metadata and add invariants so the current six-tool bounded-read surface cannot drift again.
2. Add CLI `read field-window` and REST field-window contract tests.
3. Add hostile-client large-text continuation tests and fix visible continuation metadata if needed.
4. Add resource-aware record/field-window equivalence tests.
5. Design and implement JSON/blob/export/revision semantics as the heavy tranche.
6. Run local gates, deploy under mutex, and run fresh named-client retests.

## Worker Evidence

Read-only worker reports were written under `tmp/workstreams/` in the implementation worktree:

- `mcp-client-matrix-20260624.md`
- `mcp-handle-semantics-20260624.md`
- `mcp-rest-cli-parity-20260624.md`
- `mcp-large-export-20260624.md`
- `mcp-setup-docs-20260624.md`

The reports were used as inputs, not as authority. The OpenSpec change and code/tests own the final contract.
