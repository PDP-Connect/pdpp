# Codex CLI local-collector source-home fixtures

These directories are committed, fully-synthetic Codex CLI source homes used by
`connectors/codex/source-inventory.fixture.test.ts` to exercise the local
source-inventory classification contract from
`openspec/changes/complete-local-agent-collectors`.

No real local user data, secrets, tokens, cookies, or machine identifiers are
present. Every file that stands in for a sensitive store contains an obvious
synthetic sentinel string (for example `FIXTURE_FAKE_TOKEN_DO_NOT_COLLECT`) so
redaction/negative tests can assert that no risky payload is ever emitted as a
record or blob.

The inner home directory is named `codex-home/` rather than `.codex/`.
Dot-prefixed agent directories (`.codex/`, `.claude/`, …) are intentionally
git-ignored at the repo root to keep developers' real local agent state out of
commits; the connector resolves every path from `CODEX_HOME`, so the directory
name is irrelevant to behavior and a plain name keeps the fixtures committable.

## Layout

- `deviceA/codex-home/` — a "complete" primary source home covering every store
  class in the inventory taxonomy:
  - declared/collected streams: `sessions/`, `rules/`, `prompts/`, `skills/`
  - inventory-only stores: `history.jsonl`, `session_index.jsonl`,
    `shell-snapshots/`, `cache/`, `config.toml`
  - deferred store (no payload emission): `logs/`
  - diagnostics-only private stores: `memories/`, `context-mode/`
  - excluded auth-adjacent store: `auth.json`
  - an `unknown-future-store/` that the inventory does not declare, used to
    prove unknown stores do not silently become collected payload.
- `deviceB/codex-home/` — a second device source home for the same owner, used
  to prove two Codex source homes inventory independently without colliding.

`sessions/` here intentionally contains no rollout `*.jsonl` content; the
inventory, rules/prompts/skills, shell-snapshot, and diagnostics paths are what
these fixtures cover. Rollout-shape coverage lives in the existing
`fixtures/codex/pilot-real-shape/` and `records/` fixtures.
