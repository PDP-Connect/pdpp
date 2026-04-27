# Skill Distribution Channels

Status: decided
Owner: add-agent-scoped-pdpp-access
Created: 2026-04-26
Updated: 2026-04-26
Related: `docs/inbox/skill-distribution-channels-2026-04-26.md`, `2026-04-26-skill-distribution-prior-art.md`, `docs/agent-skills/pdpp-data-access/`

## Question

How should PDPP make `pdpp-data-access` discoverable to third-party coding agents after the reference CLI gained `pdpp agent bootstrap/request/wait/store/use/status`?

## Decision

Implement the web-discovery baseline now:

- Keep the canonical source at `docs/agent-skills/pdpp-data-access/`.
- Publish `/.well-known/skills/index.json` with explicit file URLs, byte lengths, SHA-256 digests, media types, and repository paths.
- Serve only allowlisted skill files; do not expose arbitrary repository files.
- Add skill pointers to `/llms.txt` and full skill content to `/llms-full.txt`.
- Rewrite the skill happy path around `pdpp agent`, including the current local-cache-only semantics of `pdpp agent wait` and expired/revoked grant rejection in `pdpp agent use`.

This pairs skill distribution with the implemented agent-scoped access path: agents discover the skill, use the CLI, request narrow grants, wait on local cache state, and avoid owner bearer tokens.

## Deferred

- Root `skills/` publishing for `npx skills`: deferred because this repo ignores `skills/` for consumer-side installer state, and the installer is still pre-1.0.
- Bundling inside a published CLI package: deferred until the reference CLI package publishing story is settled.
- Claude plugin marketplace: deferred because it is currently lower leverage than cross-agent web discovery.

## Rejected

- npm `postinstall` copying into user skill directories. This is too surprising for a credential-adjacent integration and is commonly disabled in security-conscious environments.
