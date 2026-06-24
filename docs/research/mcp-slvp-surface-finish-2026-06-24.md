# MCP SLVP Surface — Finish (live-blocker closeout)

Date: 2026-06-24
Change: `complete-mcp-slvp-surface`
Status: implemented + gated locally; pending merge → deploy under mutex → live smoke → ChatGPT retest.

## What prompted this

A live ChatGPT retest against the **deployed** surface still failed two SLVP blockers,
even though the prior closeout branch passed its own tests:

- **B1** — search-visible bounded matched text (e.g. a Slack message body) was absent.
- **B2** — a visible `pdpp://record/...` handle from search was not accepted by
  `read_record_field` / `fetch` and was not readable via `resources/read`.

Both were real and reproduced in a sandbox before fixing. Neither was "not deployed
yet" — each was a genuine seam defect that the existing tests masked.

## Root causes (proven, not inferred)

### B1 — server/adapter seam mismatch
The RS lexical search envelope surfaces proven matched text as
`hit.evidence_excerpts[]` (`{object, field_path, preview_text, truncated, provenance}`),
built from the existing FTS5 `snippet()` / Postgres `ts_headline()` snippet.

The MCP adapter's `normalizeSearchMatchWindows` only consumed
`match_windows` / `field_windows` / `matches`. It never read `evidence_excerpts`, so
the model-visible `content[]` "Evidence excerpts:" section was empty. The adapter's own
`evidence_excerpts` (structuredContent) were derived from the empty match windows, so
they were empty too.

The integration test fixtures hand-built `match_windows`, which never exist in a real
RS response — that is exactly why the bug shipped despite green tests.

### B2 — two incompatible `pdpp://record/` encodings
`encodeResourceUri('record', ...)` emits `pdpp://record/{base64url-JSON}` — this is the
`record_uri` the model sees in content ladders and resource templates. But
`parseRecordResultId('pdpp://record/...')` only understood the human-readable
`connection_id/stream:record_id` grammar and **threw** on the base64url form
(reproduced: `pdpp://record/eyJ2...` → "bad stream:record"). So when a model copied the
visible handle into `fetch`/`read_record_field`, it was rejected.

## Fixes

1. **Adapter consumes `evidence_excerpts`** as a first-class match-window source (reads
   `preview_text`, maps `truncated → complete`) and **synthesizes a bounded
   `read_record_field` continuation** from the hit id + matched field when the window
   carries no read hint — so a visible excerpt is never a dead end.
2. **`parseRecordResultId` decodes the base64url resource handle first**, falling back to
   the plain self-contained grammar — so the canonical `record_uri` is accepted directly
   by `read_record_field`, `fetch`, and `resources/read`.
3. **Realistic fixtures**: integration + hostile-client fixtures now mirror the real RS
   envelope (`snippet` + `evidence_excerpts`, NO `match_windows`).
4. **REST/CLI parity**: the RS `evidence_excerpt` now carries a `field_window_read`
   continuation (route + stream + record_id + field + connection_id) so a REST/CLI client
   can follow it to the bounded field window without exporting the record. Public/full
   OpenAPI + route docs regenerated to publish the schema. CLI `read search` preserves the
   descriptor in JSON.
5. **handle_semantics: 'live_lookup'** stamped on every content-ladder entry + the
   field-window resource (typed freshness contract).
6. **JSON-object fields** get bounded inline previews + a `fetch` projection continuation;
   binary/blob fields stay metadata-only (no accidental base64 dumps).

## Commits (branch `workstream/mcp-slvp-ideal-full-20260624`)
- read-evidence: bounded JSON-field previews + live_lookup handle semantics.
- mcp: make search excerpts visible + accept canonical record URIs (B1 + B2).
- search: REST/CLI/MCP parity for bounded evidence read continuations + regenerated contract.

## Gates (local)
- read-evidence: 11/11
- mcp-server: 165/165 (incl. hosted token-budget, tool-footprint, hostile-client matrix)
- cli: 170/170
- reference-implementation search (lexical/hybrid/semantic): 98/98
- hosted MCP OAuth/reference: 86/86
- reference-contract:check-generated: current
- typecheck (reference-implementation): clean
- openspec validate complete-mcp-slvp-surface --strict: valid
- openspec validate --all --strict: 67 passed, 0 failed
- git diff --check: clean

## Acceptance standard (unchanged)
Search visible text includes bounded matched evidence when the backend can prove the
matched field/window; metadata-only hits invent nothing; visible record handles are
accepted by model-callable read tools; `read_record_field` returns inline bounded text +
truthful continuation; ordinary small projected `fetch` stays inline; file/resource
materialization stays reserved for large/bulk/binary; generic resource-read failure is
never a dead end while the visible continuation works.

## Remaining (owner/deploy lane)
- Merge to main after review.
- Deploy under live-stack mutex; smoke deployed revision; record revision.
- Fresh ChatGPT retest using the durable prompt; append result here.
