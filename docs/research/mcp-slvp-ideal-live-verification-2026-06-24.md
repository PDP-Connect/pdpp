# MCP SLVP Ideal Live Verification — 2026-06-24

Status: passed live smoke after PR #52.

## Deployed Revision

- `origin/main`: `72df54ec121399f20e403947d32e7c89c6456847`
- Reference container: `PDPP_REFERENCE_REVISION=v0.15.0-4-g72df54ec1`
- Live origin: `https://pdpp.vivid.fish`

## Gates

- PR #52 reached `CLEAN`.
- GitHub checks passed: docker validation matrix, Vercel, and `typecheck + full test suite`.
- Local gates before merge:
  - `openspec validate complete-mcp-slvp-surface --strict`
  - `pnpm --dir packages/mcp-server run test:read-surface`
  - `pnpm --dir packages/mcp-server test`
  - `pnpm --dir reference-implementation exec node --test test/lexical-retrieval.test.js test/lexical-retrieval-conformance.test.js test/lexical-retrieval-conformance-postgres.test.js`
  - `pnpm --dir reference-implementation typecheck`
  - `pnpm --dir reference-implementation exec node --test test/rs-search-lexical-operation.test.js test/record-field-window-substrate.test.js test/rs-record-field-window-route.test.js`
  - `pnpm --dir reference-implementation test`
  - `openspec validate --all --strict`
  - `git diff --check`

## Live Smoke

Target: Vana Slack `messages`, connection `cin_f565a96cb0a114b0a27e9606`.

- `search(q=Hyperlane, mode=lexical, limit=1)` passed through the live MCP app.
- The live REST evidence excerpt is no longer only `<mark>Hyperlane</mark>`. It included bounded Slack context: `<mark>Hyperlane</mark> or LayerZero? *Layer Zero for sure.* ... fallback`.
- `read_record_field` on the canonical id returned inline bounded `text` with `total_chars=1215`, offsets, cursors, `has_more=true`, and match offsets.
- `read_record_field` no longer returned a visible `resource` object or `pdpp://field-window/...` URI for ordinary bounded text.
- Projected `fetch` returned inline document output and a content ladder; it did not require file materialization.
- The visible `pdpp://record/...` handle was accepted directly by `read_record_field`.

## Result

The live ChatGPT-facing path now satisfies the intended MCP SLVP ladder for this Slack case:

`compact discovery -> bounded visible evidence -> directly usable record handles -> callable bounded read -> deliberate fetch only when needed`.

The prior weak points are closed for this path:

- Search-visible evidence is classification-useful, not only a marked token.
- Ordinary `read_record_field` output does not expose a dead `pdpp://field-window/...` generic resource handle.
