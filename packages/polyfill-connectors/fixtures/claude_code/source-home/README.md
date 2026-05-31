# Claude Code local-collector source-home fixtures

These directories are committed, fully-synthetic Claude Code source homes used
by `connectors/claude_code/source-inventory.fixture.test.ts` to exercise the
local source-inventory classification contract from
`openspec/changes/complete-local-agent-collectors`.

No real local user data, secrets, tokens, cookies, or machine identifiers are
present. Every file that stands in for a sensitive store contains an obvious
synthetic sentinel string (for example `FIXTURE_FAKE_TOKEN_DO_NOT_COLLECT`) so
redaction/negative tests can assert that no risky payload is ever emitted as a
record or blob.

The inner home directory is named `claude-home/` rather than `.claude/`.
Dot-prefixed agent directories (`.claude/`, `.codex/`, …) are intentionally
git-ignored at the repo root to keep developers' real local agent state out of
commits; the connector resolves every path from `CLAUDE_CODE_HOME`, so the
directory name is irrelevant to behavior and a plain name keeps the fixtures
committable.

## Layout

- `deviceA/claude-home/` — a "complete" primary source home covering every
  store class in the inventory taxonomy:
  - declared/collected streams: `projects/`, `skills/`, `commands/`
  - inventory-only stores: `file-history/`, `cache/`, `backups/`,
    `settings.json` (config)
  - deferred stores (no payload emission): `debug/`, `downloads/`
  - diagnostics-only private store: `context-mode/`
  - excluded auth-adjacent store: `auth.json`
  - an `unknown-future-store/` that the inventory does not declare, used to
    prove unknown stores do not silently become collected payload.
- `deviceB/claude-home/` — a second device source home for the same owner,
  used to prove two Claude source homes inventory independently without
  colliding.

`projects/` here intentionally contains no `*.jsonl` transcript content; the
inventory and skills/commands/file-history/diagnostics paths are what these
fixtures cover. Transcript-shape coverage lives in the existing
`fixtures/claude_code/pilot-real-shape/` and `records/` fixtures.
