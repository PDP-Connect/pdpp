# MCP closeout status - 2026-07-01

Status: durable closeout note for the current MCP read-evidence tranche.

## Closed scope

The current MCP closeout is closed for the bounded read-evidence journey:

- hosted and stdio MCP expose the same grant-scoped, read-only tool surface;
- `schema`, `query_records`, `aggregate`, `search`, `fetch`, and
  `read_record_field` are the intended current tools;
- search output can expose bounded matched evidence for ordinary message-like
  records;
- `read_record_field` is the callable bounded-read path and returns inline
  windows with offsets, cursors, and truncation metadata;
- small projected `fetch` returns inline document content instead of forcing a
  materialized file attachment;
- ordinary model-visible output should prefer explicit callable read recipes
  over standalone `pdpp://field-window/...` resource handles.

The durable evidence is already in:

- `docs/research/mcp-slvp-ideal-live-verification-2026-06-24.md`
- `docs/research/mcp-handle-footgun-audit-2026-06-26.md`
- `docs/operator/hosted-mcp-setup.md`
- `openspec/specs/mcp-adapter/spec.md`

The Claude Code OAuth loopback compatibility issue is closed by
`96ff21ee5` (`fix(oauth): accept native loopback runtime ports`) and owner
retest succeeded after that change.

## Residual rule

Do not keep old MCP worktrees or workstream files open merely because they
exist. They are not the source of truth. A future MCP item should be opened only
when one of these happens:

- a fresh hosted-client retest fails the bounded evidence/read recipe path;
- a client requires a compatibility behavior not covered by the current setup
  runbook or `mcp-adapter` spec;
- prior-art research identifies a better model-visible read pattern than the
  current content ladder.

Raw `pdpp://record/...` and `pdpp://field-window/...` compatibility details may
still exist below the primary tool contract. They become a bug only if ordinary
client output leaves the model with a non-callable handle instead of bounded
visible evidence plus a callable read recipe.

## Cleanup implication

MCP worktrees should be treated as cleanup/sprawl, not active MCP product work,
unless a per-worktree diff review finds unmerged behavior not represented by the
tracked artifacts above. Removal still requires the normal worktree cleanup
proof: clean or harvested diff, no unique patches against `origin/main`, and no
active handoff depending on the worktree.
