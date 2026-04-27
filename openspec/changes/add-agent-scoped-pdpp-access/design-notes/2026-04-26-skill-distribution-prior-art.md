# Skill Distribution Prior Art

Status: captured
Owner: agent-scoped-pdpp-access worker
Created: 2026-04-26
Updated: 2026-04-26
Related: `openspec/changes/add-agent-scoped-pdpp-access/`, `docs/agent-skills/pdpp-data-access/`, `2026-04-25-reference-surface-audit.md`

## Question

How do leading developer-platform companies distribute "agent skills" — the procedural-knowledge bundles (typically a `SKILL.md` plus references) that coding agents like Claude Code, Cursor, and Codex CLI load to integrate correctly with a product? PDPP shipped `pdpp-data-access` as a tracked in-repo skill at `docs/agent-skills/pdpp-data-access/` (see the 2026-04-25 audit) but has not yet picked a distribution channel for downstream developers whose agents need to consume PDPP. This memo captures the prior-art landscape so that a follow-on tranche can pick channels with eyes open.

## Context

The 2026-04-25 reference-surface audit deferred CLI, Approval UX, Protocol Candidate Handling, and Validation. It also routed the skill itself to `docs/agent-skills/` because the root `.gitignore` reserves `skills/` for the upstream skills installer's consumer-side state. That decision was correct for the publisher path but left "how does a third-party developer's agent actually load this" unanswered.

Two project facts matter for the channel question and were under-weighted in the original audit:

- The `pdpp` CLI already exists as the `bin` entry of `reference-implementation/package.json` and ships an `agent` subcommand group (`bootstrap`, `request`, `wait`, `store`, `use`, `forget`, `revoke`) that automates the exact discovery → register → PAR → cache flow the skill teaches in raw HTTP form.
- The `apps/web` Next app already serves `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource` under the sandbox route. A `.well-known/skills/index.json` is the same shape and would not require new infrastructure.

The rest of this note documents what other shops are doing as of April 2026.

## Anthropic's Official Skill Ecosystem

- Repo: `github.com/anthropics/skills` — public Anthropic skills, also a Claude Code plugin marketplace via `.claude-plugin/marketplace.json`. Users register the marketplace and run `/plugin install <skill>@anthropic-agent-skills`.
- Open spec: `agentskills.io` / `github.com/agentskills/agentskills`. The same `SKILL.md` format works in Claude Code, Cursor, Codex CLI, Gemini CLI, and Antigravity.
- Frontmatter (per `code.claude.com/docs/en/skills`):

  ```yaml
  ---
  name: my-skill                    # required; ^[a-z0-9]+(-[a-z0-9]+)*$, 1-64 chars
  description: ...                  # required; 1-1024 chars; "pushy" wording loads better
  disable-model-invocation: false   # optional; user-invoked only when true
  user-invocable: true              # optional; hide from /menu, keep as background context
  allowed-tools: Read Grep          # optional; Claude-Code-specific (Agent SDK ignores it)
  ---
  ```

- Discovery paths Claude Code scans: `.claude/skills/` (project), `~/.claude/skills/` (user), and plugin-namespaced skills.
- Progressive-disclosure rule: keep `SKILL.md` under ~500 lines / ~5k tokens; offload to `references/`, `scripts/`, `assets/` and tell the model when to load them. The shipped `pdpp-data-access` SKILL.md already follows this shape.
- Anthropic ships no first-party CLI installer. Distribution is git-clone, the plugin marketplace, or third-party CLIs.

## Distribution Matrix — What Real Companies Ship

| Company | `llms.txt` | MCP server | Skill | SDK | Notes |
| --- | --- | --- | --- | --- | --- |
| Stripe | `docs.stripe.com/llms.txt` | hosted `mcp.stripe.com` + local `npx -y @stripe/mcp` | Yes — catalog at `docs.stripe.com/.well-known/skills/index.json` (3 skills as of writing) | `@stripe/agent-toolkit`, `@stripe/ai-sdk` | All four layers |
| Linear | — | hosted `mcp.linear.app/mcp` (OAuth) | — | — | Runtime-only |
| Plaid | `plaid.com/llms.txt` + `llms-full.txt` | hosted `api.dashboard.plaid.com/mcp` (diagnostics) + local Sandbox MCP | Vibe-coding guide pages, no formal skill | Plaid CLI | No skill yet |
| Supabase | — | hosted `mcp.supabase.com/mcp` | Bundled in Cursor plugin (Cursor strips skills today, forum bug) | — | MCP-first |
| Clerk | `clerk.com/llms.txt` | — | Yes — Clerk Skills launched 2026-01-29 | — | Skill + llms.txt |
| Convex | `docs.convex.dev/llms.txt` + `llms-full.txt` | — | Yes — `npx skills add get-convex/agent-skills` | — | CLI-distributed |
| Vercel AI SDK | — | — | Bundled inside `node_modules/ai`; agent reads from there | `ai` npm package | Versioned with the SDK |
| GitHub | — | hosted GitHub MCP (Copilot) | — | — | Runtime-only |

The pattern at the more mature end of the matrix (Stripe most clearly) is to ship llms.txt, MCP, Skills, and an SDK as complementary layers with different jobs.

## MCP Versus Skill — Division Of Labor

- MCP is a runtime tool surface. The agent calls a function, the server returns data. Best when the agent must *do* something against the live system (read state, mutate, OAuth into a user account).
- A skill is procedural knowledge. It teaches the agent *how to integrate* — which API to pick, what fields to send, how to read errors, how to refuse anti-patterns. Loaded into the model's context, no network.
- Stripe's pattern is the proof: their `stripe-best-practices` skill exists alongside their MCP server because the MCP server cannot teach the agent which Stripe API to choose. PDPP is in the same shape: the agent must know how to construct a grant request before any PDPP endpoint or CLI call.

## Distribution Mechanics

| Mechanism | Concrete example | Tradeoffs |
| --- | --- | --- |
| `npx skills add owner/repo` (npm `skills`, repo `vercel-labs/skills`) | `npx skills add get-convex/agent-skills -g` | Works across 17+ agents incl. Claude Code, Cursor, Codex, Gemini CLI, Windsurf. Pulls SKILL.md from the git tree, writes to agent dirs, tracks `~/.agents/.skill-lock.json` (v3, keyed on git tree SHA). Pre-1.0; no `skills install` to restore from lockfile yet (issues #283, #549); project-scoped skills not lockfile-tracked (#337). |
| `.well-known/skills/index.json` + `npx skills add` | Stripe's `docs.stripe.com/.well-known/skills/index.json` lists `{ name, description, files[] }` per skill | Self-hosted, version-controlled by the publisher, multi-agent-compatible. Stripe's own docs note that manually added skills do not auto-update. |
| Plugin marketplace | Anthropic's `.claude-plugin/marketplace.json`; Cursor Plugins | Native Claude Code install via `/plugin install`. Cursor's plugin variant currently strips skills; only ships MCP. |
| npm package with postinstall hook | `neovateai/agent-skill-npm-boilerplate`, `autoskills` | `npm i your-skill` runs `install-skill.js` to copy SKILL.md into `~/.claude/skills/`. Brittle: postinstall hooks are blocked by `--ignore-scripts` and discouraged in security-conscious shops. |
| Bundle inside an SDK package | Vercel AI SDK ships SKILL.md inside `node_modules/ai`; the agent reads it from there | Zero install step beyond `npm i`. Versioned with the SDK automatically. Requires a global hint (often AGENTS.md) so the agent knows to look there. |
| Plain `llms.txt` | Stripe, Plaid, Clerk, Convex | Passive, crawler-friendly. Not loaded into Claude Code's skill system. Useful baseline, insufficient on its own. |

There is a de-facto leaderboard at `skills.sh` (~91k skills indexed, populated from `npx skills` telemetry; no manual submission flow).

## Per-Project Versus Global Skills

- Convention is to commit `.claude/skills/` to the repo for team-shared skills, and use `~/.claude/skills/` for personal.
- Many developers globally `.gitignore` `.claude/`. A repo that drops project skills there silently fails to commit for those users (Anthropic Claude Code issue #9928 tracks the related "(project, gitignored)" system-prompt bug).
- Mitigation used by Convex, Stripe, and others: ship via a tool (`npx skills`) that writes to user-level `~/.agents/skills/` and `~/.claude/skills/`, sidestepping repo-level ignore rules.

## PDPP-Specific Constraints Surfaced By This Research

- The root `.gitignore` rule that pushed `pdpp-data-access` to `docs/agent-skills/` is consumer-side: it ignores `skills/` because the upstream `npx skills` installer writes there. Publishing a PDPP-authored skill from `skills/pdpp-data-access/` would require either a `!skills/pdpp-data-access/` exception or moving the published copy to a non-ignored location (for example `reference-implementation/skills/`, or a separate `pdpp-skills/` repo). The 2026-04-25 audit explicitly deferred this decision.
- The published SKILL.md currently teaches the raw HTTP / curl flow. The shipped `pdpp agent` CLI absorbs nearly all of that complexity. A skill rewritten to drive `pdpp agent` would shrink considerably and would version with the CLI package.
- `apps/web` already serves `.well-known/*` routes for the sandbox. A `.well-known/skills/index.json` route is structurally identical and could be added without new infrastructure.

## Decision Log

- 2026-04-26: Captured. No channel selection made; see sibling memo `docs/inbox/skill-distribution-channels-2026-04-26.md` for an unopinionated tradeoff write-up that this note feeds into.

## Sources

- Claude Code skill docs: `code.claude.com/docs/en/skills`
- `anthropics/skills` repo and `.claude-plugin/marketplace.json`
- `agentskills.io` open spec
- `vercel-labs/skills` repo, npm `skills` package, and lockfile issues #283 / #337 / #549
- `skills.sh` leaderboard
- Stripe: `docs.stripe.com/building-with-ai`, `docs.stripe.com/.well-known/skills/index.json`, `docs.stripe.com/mcp`, `stripe/agent-toolkit`
- Linear: `linear.app/docs/mcp`
- Plaid: `plaid.com/docs/resources/mcp/`, `plaid.com/llms.txt`
- Supabase: `supabase.com/docs/guides/getting-started/mcp`, Cursor forum thread on plugin skill stripping
- Clerk: `clerk.com/changelog/2026-01-29-clerk-skills`, `clerk.com/llms.txt`
- Convex: `github.com/get-convex/agent-skills`, `docs.convex.dev/llms.txt`
- Vercel AI SDK: `ai-sdk.dev/docs/getting-started/coding-agents`
- Boilerplate: `github.com/neovateai/agent-skill-npm-boilerplate`, npm `autoskills`
- Anthropic Claude Code issue #9928 (gitignored project context)
