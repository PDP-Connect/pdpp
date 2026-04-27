## Context

The reference currently supports two dangerous extremes for agents:

- owner-token use, which is too broad for routine assistant work
- hand-built client-token flows, which are too awkward for agents to discover and operate independently

The intended experience is closer to mature CLI authorization flows:

- RFC 8628 defines a device flow where the client displays a verification URI/user code and polls while the user approves in a browser.
- GitHub CLI defaults to a browser-based flow, stores the resulting token in a credential store when available, and falls back to a file with discoverable status.
- AWS CLI SSO can open a browser or display a URL/code, caches session tokens to disk, and requires explicit re-login when the cached session expires.

That supports the answer to "can Claude drop that link?": yes. A terminal agent can print the URL/code in its output or tmux pane, and the CLI can optionally open a browser. The agent cannot approve for the owner; it can only present the request and poll.

## Design

Add a reference CLI and skill workflow:

1. The agent discovers the AS/RS metadata and `/v1/schema`.
2. The agent registers or reuses a local public client identity for the project/agent.
3. The agent builds a grant request with source, streams, fields, time range, purpose, access mode, and retention.
4. The CLI creates a pending consent request and prints an approval URL plus a short summary.
5. The owner approves or denies in the dashboard/consent UI.
6. The CLI polls and stores the resulting client token in a project-local ignored cache.
7. The agent uses the client token for records, search, schema, changes, blobs, and aggregations.
8. If the task needs broader access later, the agent asks for an incremental grant rather than silently broadening.

### Project-local cache

Default cache location should be project-local and gitignored, for example:

```text
.pdpp/
  agent-access.json
  tokens/<client-id>.json
```

The cache stores:

- AS/RS URLs
- client id and display metadata
- grant id, token expiry, source, streams, fields, purpose, retention, and issued time
- opaque client token in a secret-bearing file with restrictive permissions

The cache must not be committed. The CLI should create or update `.gitignore` only when it can do so safely and explicitly.

### Agent skill

The skill should be a first-class product artifact, not a thin command list. It should teach agents to:

- start with discovery, not guessed endpoints
- choose the narrowest grant that can answer the current user need
- prefer schema/search/changes cursors over broad pagination
- explain requested access in owner-readable language
- use `streams[]`, `filter[...]`, `changes_since=beginning`, `/v1/schema`, `blob_ref.fetch_url`, and retrieval endpoints correctly
- cache and reuse grants without leaking tokens into prompts, logs, shell history, commits, or tool output
- request upgrades/re-auth when access is missing, expired, revoked, or insufficient
- revoke or forget grants when a project no longer needs them

### Approval UX

The approval page should show:

- agent/client name
- project path or caller-provided local context when available
- requested connector/provider
- streams, fields/views, time range, retention, and access mode
- purpose text written for the owner, not for a protocol implementer
- whether the grant is one-time, expiring, renewable, or continuous
- risks and revocation path

Do not default to perpetual broad access. Long-lived access can exist, but must be explicit and visible.

### Skill distribution channels

The canonical source remains `docs/agent-skills/pdpp-data-access/`. That path avoids the repo-root `skills/` collision with local agent installer state while keeping the skill reviewable in the docs tree.

This tranche publishes two low-drift channels from that source:

1. `/.well-known/skills/index.json` lists the `pdpp-data-access` skill, every served file, byte length, SHA-256, media type, repository path, and absolute URL. File serving is allowlist-only; the route does not expose arbitrary repository files.
2. `/llms.txt` points agents at the catalog and primary `SKILL.md`; `/llms-full.txt` includes the full skill and reference content for crawler/search workflows.

In composed reference deployments, the RS protected-resource metadata also carries a `pdpp_agent_discovery` block with advisory links to those browser-hosted surfaces. The block is intentionally descriptive rather than authoritative PDPP protocol semantics: it tells a cold-start agent where to learn the recommended `pdpp agent` workflow, but data access still requires an owner-approved client grant. Direct AS/RS-only deployments omit the block because they do not serve the web skill and LLM routes.

The skill itself is CLI-first. It teaches `pdpp agent bootstrap`, `pdpp agent request`, `pdpp agent wait`, `pdpp agent store`, `pdpp agent use`, and `pdpp agent status` as the happy path. Raw HTTP remains documented only as a fallback when the CLI is unavailable.

Deferred channels:

- `npx skills` repo-root layout: deferred because `skills/` is intentionally ignored for consumer-side installer state, and the installer is still pre-1.0.
- CLI-package bundling: deferred until the reference CLI package publishing story is settled.
- Claude plugin marketplace: deferred because it is currently single-harness and lower leverage than web discovery.

Rejected channel:

- npm `postinstall` copying into user skill directories. It is too surprising for a credential-adjacent integration and is commonly disabled in security-conscious environments.

## Protocol posture

This change is reference-first. It may expose gaps in the root PDPP authorization profile, but it does not finalize them.

If implementation needs new wire fields beyond the current reference contract, they must be labeled experimental/reference-only and captured as candidates for the root PDPP/companion specs before being treated as normative.

## Alternatives Considered

- Keep using owner keys: rejected. It collapses least privilege and makes agent-specific access impossible.
- Store a global machine token: rejected as the default. It is convenient but makes project/agent boundaries invisible.
- Require users to manually paste tokens: acceptable as an escape hatch, not the primary UX.
- Start by changing the root PDPP protocol: rejected for this tranche. We can learn from the reference and skill first.

## Acceptance Checks

- An agent can obtain and use a client grant without ever seeing an owner token.
- The owner can understand and approve/deny the requested access from a browser link.
- Tokens are cached locally with restrictive handling and are never written to repo-tracked files by default.
- The skill lets a fresh agent discover and use PDPP data without guessing unsupported endpoints.
- Any protocol-candidate behavior is explicitly documented as proposed/experimental.

## Prior Art

- OAuth 2.0 Device Authorization Grant: https://datatracker.ietf.org/doc/html/rfc8628
- GitHub CLI auth flow: https://cli.github.com/manual/gh_auth_login
- AWS CLI SSO/device-code and credential cache: https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sso.html
