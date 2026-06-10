# PDPP MCP Server — SLVP Design Research

Status: researching
Owner: reference implementation owner (delegated worker)
Created: 2026-05-21
Updated: 2026-05-21
Related: `spec-core.md` §8, `spec-data-query-api.md`, `spec-auth-design.md`, `docs/agent-skills/pdpp-data-access/SKILL.md`, `openspec/changes/add-agent-scoped-pdpp-access/design-notes/2026-04-25-reference-surface-audit.md`, `openspec/changes/add-agent-scoped-pdpp-access/design-notes/2026-04-26-skill-distribution-prior-art.md`, `docs/personas/standards-editor-reviewer.md`, `design-notes/full-context-refresh.md`

## Question

What is the 95%+-confidence SLVP-ideal shape of an MCP server for PDPP — what does it expose, how is it authenticated, where does it live, what is explicitly out of scope, and what is the smallest tranche that proves the architecture is correct by construction rather than patched together?

## TL;DR (recommendation)

Ship **`@pdpp/mcp-server`** as a **thin adapter over the existing PDPP resource server**, not a new data plane. Concretely:

1. **Default transport: stdio.** A local agent harness (Claude Code, Codex CLI, Cursor) spawns the adapter as a subprocess; the adapter reads a project-local scoped client token from `.pdpp/` (already produced by `pdpp connect`) and proxies MCP tool calls into the existing `/v1/*` HTTP surface on the user's PDPP RS. No new auth, no new tokens, no new wire contract.
2. **Streamable HTTP is a second tranche**, gated on the protocol-candidate "PAR-status polling" gap and on an honest decision about hosted-vs-self-host posture. Doing it first would either bypass the existing OAuth/RAR/grant model or duplicate it badly.
3. **Capabilities: tools first, resources second, elicitation maybe, sampling/roots no.** The agent's job is to discover schema, fetch records, search, fetch blobs — that is a tool/resources surface. Sampling and roots are client-side capabilities that PDPP servers should not initiate.
4. **The MCP server holds no grant-issuance authority.** It is a *client* of the PDPP RS, presenting the user's already-issued scoped token in `Authorization: Bearer …`. The MCP authorization spec's "MCP server = OAuth Resource Server" model maps to PDPP's RS, not to the adapter. For stdio (the recommended first tranche), MCP's own authorization spec doesn't apply at all — credentials come from environment, exactly what the spec prescribes for stdio transports.
5. **Smallest correct tranche:** stdio adapter that exposes 5 tools — `schema`, `list_streams`, `query_records`, `search`, `fetch_blob` — and 1 resource template — `pdpp://stream/{name}` — all backed by the existing `/v1/schema`, `/v1/streams[/...]`, `/v1/search`, `/v1/blobs/:id` endpoints. Token comes from `.pdpp/tokens/<grant-id>.token`. Zero new HTTP routes. Zero new spec surface.

If this is wrong, the rest of the note shows why it is wrong; I expect this is the correct frame.

## Context

### What MCP is in 2026

[MCP](https://modelcontextprotocol.io/specification/2025-06-18) is a JSON-RPC 2.0 protocol between an *LLM host* (a "client") and an *MCP server*. Servers offer **resources**, **prompts**, **tools**; clients optionally offer **sampling**, **roots**, **elicitation**.

Two transports are normative ([Transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)):

- **stdio** — the host spawns the server as a subprocess and exchanges newline-delimited JSON-RPC over stdin/stdout. Clients **SHOULD** support stdio whenever possible. There is no authorization spec for stdio; credentials are read from the environment.
- **Streamable HTTP** — a single HTTP endpoint accepting POST (with optional SSE response stream) and GET (for server→client SSE). Replaces the deprecated HTTP+SSE transport from 2024-11-05.

[Authorization for HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization) is built around OAuth 2.1 draft-13. The MCP server **MUST** act as an [RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728) Protected Resource (advertising its AS via `/.well-known/oauth-protected-resource`); the MCP client **MUST** discover the AS, perform DCR if available ([RFC 7591](https://datatracker.ietf.org/doc/html/rfc7591)), do authorization-code + PKCE, request a token with the `resource` parameter ([RFC 8707](https://www.rfc-editor.org/rfc/rfc8707.html)), and present a bearer token bound to that MCP server as audience. **Token passthrough is explicitly forbidden** — an MCP server may not accept a token issued for a different audience and forward it to a downstream API ([Security Best Practices §Token Passthrough](https://modelcontextprotocol.io/specification/2025-06-18/basic/security_best_practices#token-passthrough)).

### What PDPP already has

The reference implementation already ships nearly every primitive an MCP adapter needs:

- AS at `POST /oauth/par`, `POST /oauth/register`, `GET /consent`, `POST /consent/approve`, `POST /grants/:id/revoke`, `POST /introspect`.
- RS at `GET /v1/schema`, `GET /v1/streams[/:stream[/records[/:id]]]`, `GET /v1/streams/:s/aggregate`, `GET /v1/search`, `GET /v1/blobs/:id`.
- Protected-resource metadata at `GET /.well-known/oauth-protected-resource` and AS metadata at `GET /.well-known/oauth-authorization-server`.
- Owner-vs-client token distinction with audience-tagged bearer kinds (`pdpp_token_kind=owner` vs scoped client).
- Project-local scoped-token cache convention under `.pdpp/` (`tokens/<grant-id>.token` mode `0600`).
- A CLI `pdpp connect <provider-url>` that does discovery → DCR → PAR → owner-approval-relay → cache.
- A Claude skill at `docs/agent-skills/pdpp-data-access/` teaching agents to drive the scoped-grant flow using raw HTTP or `pdpp connect`.

Two reference-side gaps relevant here, both already documented:

- No agent-side polling endpoint for PAR-staged client grants (`add-agent-scoped-pdpp-access/design-notes/2026-04-25-reference-surface-audit.md`). Today the agent either receives the token in the approval response or has the owner paste it.
- No formally-distinct "remote MCP server URL" in metadata. The RS URL is the canonical PDPP resource URL.

### Stakes

PDPP's load-bearing claim, restated in `design-notes/full-context-refresh.md`, is:

> An app authorizes against the user's authorization server, the resource server enforces the grant, collection is separate.

An MCP server done wrong damages this in either direction:

- **Direction A — MCP as a connector hack.** Re-implementing data fetch in the MCP server (browser automation, OAuth into Gmail/etc., raw record shaping) collapses the Core/Collection boundary that the project just finished extracting. It also turns the MCP server into a Confused Deputy: a single static-client OAuth proxy doing user-specific data access ([MCP §Confused Deputy](https://modelcontextprotocol.io/specification/2025-06-18/basic/security_best_practices#confused-deputy-problem)).
- **Direction B — MCP as a new authorization plane.** Inventing scopes, tokens, or grant semantics inside the MCP server bypasses the existing manifest-and-grant trust model that the consent UI work has been carefully refining ([client_metadata_decision](../openspec/changes/add-agent-scoped-pdpp-access/) memory). The user would consent twice, in two visually different surfaces, with two different vocabularies.

Both are avoidable. The correct construction is a translation layer, not a server.

The audiences from the experience-architecture brief (CEO/external person, engineer, product, LF reviewer, GTM) all benefit from the same correct shape: a one-screen story — "PDPP exposes data; MCP is one transport into that data; the grant model is unchanged" — that is provable by running the adapter and watching every record flow through the existing RS query logic.

## Findings By Question

### 1. What does current MCP prior art/spec say is the right server shape in 2026?

The 2025-06-18 spec (latest with `/2025-06-18/...` URL stem) is the authoritative reference; 2025-11-25 is a published increment but the substantive shape — JSON-RPC base, capability negotiation, tools/resources/prompts vs sampling/roots/elicitation, stdio vs Streamable HTTP, RFC 9728/8707-based auth — is stable across both. Spec architecture: [overview](https://modelcontextprotocol.io/specification/2025-06-18), [transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports), [authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization), [security best practices](https://modelcontextprotocol.io/specification/2025-06-18/basic/security_best_practices).

Observed pattern from leading data-platform shops (matrix in `skill-distribution-prior-art-2026-04-26.md`):

- Stripe ships local `npx -y @stripe/mcp` **and** hosted `mcp.stripe.com`.
- Plaid ships local Sandbox MCP **and** hosted `api.dashboard.plaid.com/mcp`.
- Linear/Supabase/GitHub run **hosted-only**.
- Convex/Vercel AI SDK ship **skill-only**, no MCP.

Almost everyone who ships MCP at all ships a *local stdio binary first*, because:

1. Local MCP servers carry no transport-layer auth burden (per spec §Authorization, stdio reads credentials from environment).
2. They install with one line in `claude_desktop_config.json` / Codex equivalent / Cursor MCP config.
3. They sidestep DCR/PKCE/RFC 8707 entirely until the hosted variant is wanted.

The pattern: a thin local MCP that **wraps the company's already-existing authenticated API**. That is exactly the PDPP shape — the authenticated API exists, the cache exists, the CLI already orchestrates the grant flow.

### 2. Which transport(s) first: stdio, Streamable HTTP, or both?

**First tranche: stdio only.** Reasons:

- The PDPP RS *already is* the OAuth Resource Server in the MCP-authorization sense. The MCP server is a *client* of it. Putting Streamable HTTP first means standing up a *second* RS-shaped surface that either (a) re-implements RFC 9728 metadata + audience binding for itself and confuses agents about which URL is canonical, or (b) does token passthrough — which the spec explicitly forbids.
- For local agent harnesses (Claude Code, Codex, Cursor) — the audience for PDPP's `pdpp-data-access` skill — stdio is the canonical install method. Per the MCP spec, "Clients **SHOULD** support stdio whenever possible."
- stdio with a `localhost` adapter avoids the [DNS rebinding warning](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#security-warning) that Streamable HTTP servers must defend against.
- The adapter reads the scoped token from `.pdpp/tokens/<grant-id>.token` — the cache shape already designed in the 2026-04-25 audit. No new key material is created or stored.

**Second tranche: Streamable HTTP, only when an honest use case exists.** Plausible cases:

- **Remote agent harnesses** (Anthropic-hosted Claude.ai, Vercel AI Gateway, Cloudflare Workers) that cannot spawn subprocesses. Here the MCP server runs as a publicly-addressable HTTP endpoint hosted by the user's PDPP deployment (operator console / `apps/web`). The MCP server becomes a public face of the same RS.
- **Multi-user PDPP deployments** where one MCP endpoint serves multiple owners. The MCP `resource` parameter (RFC 8707) plus per-owner token audience is the correct partition.

In the Streamable HTTP tranche, the MCP server **is** the OAuth Resource Server per MCP spec. The cleanest construction is that the MCP server's RFC 9728 metadata document points at *the existing PDPP AS*, the `resource` parameter is the canonical MCP endpoint URL (`https://<owner-host>/mcp`), and the token audience is the MCP endpoint. Two acceptable internal models:

1. **Co-located audience** — the AS issues tokens with `aud = [pdpp-rs, mcp-endpoint]`. Adapter validates `aud` includes the MCP endpoint and then delegates record reads to its in-process RS implementation (same code, no HTTP hop).
2. **Token exchange** — the agent presents a token bound to the MCP endpoint; the MCP server exchanges it for a separate token bound to the RS (RFC 8693). More moving parts, real "two distinct RSs" story, no passthrough.

Option 1 is the SLVP path. Option 2 is correct if PDPP ever supports MCP servers that are operationally separate from the RS (e.g. third-party MCP hosting). Both avoid token passthrough.

Until that tranche exists, **the stdio adapter is the entire MCP product**. That is consistent with how most platform vendors started (Stripe shipped local first, hosted later; Cloudflare's `McpAgent` was the precursor to hosted McpServer).

### 3. How should PDPP authentication/authorization work without bypassing existing grants?

stdio tranche: trivially. The adapter reads the scoped client token from `.pdpp/tokens/<grant-id>.token` (mode 0600). Every outbound call to the RS attaches `Authorization: Bearer <token>`. No new auth machinery exists inside the MCP server. The user revokes by running `pdpp` revoke commands against the AS exactly as today.

Critical rules (these are how we avoid Direction-A and Direction-B failures):

- The adapter **MUST NOT** ask the user for an owner bearer token. If the cache is empty, it prints the same "run `pdpp connect <provider-url>`" guidance that the skill already teaches.
- The adapter **MUST NOT** request grant upgrades on its own. If a tool call needs a stream the current grant does not cover, the tool returns a structured "needs broader grant" error including the `purpose_code` and `streams[]` that would be needed; the agent surfaces this to the user, who runs `pdpp connect` or the future `pdpp agent request` flow.
- The adapter **MUST** treat `invalid_token`, `insufficient_scope`, and `grant_revoked` as terminal — no tight-loop retries.
- The adapter **MUST** propagate the RS's structured error envelope into MCP `isError: true` results with the original `error.code` preserved in `structuredContent` so the agent can react correctly.

Streamable HTTP tranche: defer until we have a polling endpoint and a remote-MCP audience use case. When we do, follow the spec literally — RFC 9728 metadata, audience binding via RFC 8707, DCR for agent clients, PKCE, per-client consent for any proxy semantics. The existing `/oauth/register` and `/oauth/par` surfaces are already RFC-aligned; this is mostly metadata-plumbing work plus the polling-endpoint gap.

### 4. Which MCP capabilities map cleanly to PDPP?

| MCP capability | PDPP mapping | Recommend in tranche 1? |
| --- | --- | --- |
| **Tools** (server→client) | `schema` (wraps `/v1/schema`), `list_streams`, `query_records`, `search`, `fetch_blob`. Each tool is a typed front for one or two existing endpoints. | **Yes — primary surface.** |
| **Resources** + resource templates (server→client) | `pdpp://stream/{name}` resource template returns the stream metadata document (`/v1/streams/{name}`); `pdpp://record/{stream}/{id}` returns a single record envelope. URI scheme is custom (`pdpp://`); the spec allows custom schemes if they follow RFC 3986. | **Yes — one template, narrow.** Enables resource-picker UX in clients that support it (Claude Desktop) without re-shaping the tool surface. |
| **Resource subscriptions** | Maps to "stream had new records since cursor X". The RS already supports `changes_since` cursors. | **No in tranche 1.** Premature: requires server-push, complicates stdio (need to keep an event loop alive), and the agent UX for live subscriptions is unsettled. Revisit when the connector-event-subscriptions design note matures. |
| **Prompts** (server→client) | Templated workflows like "summarize last 7 days of email from <sender>". Could draft canonical purpose-strings and pre-fill grant requests. | **No in tranche 1.** Prompts ossify product opinions inside the protocol layer. Keep PDPP transport-neutral; let agent harnesses build prompts. |
| **Elicitation** (server asks client to ask user) | Could be used to interactively narrow a grant request (ask user for date range, sender, etc.) before issuing `/oauth/par`. | **Maybe in tranche 1.** Only if the adapter ever needs to ask the user a structured question without involving the LLM. Current scoped-grant flow already routes user interaction through the AS consent screen; elicitation would be a *second* interaction surface. Risk of duplicating the consent vocabulary. **Defer unless a concrete tool call surfaces a clear need.** |
| **Sampling** (client→server LLM access) | Server asks the host's LLM to do completions. | **No, ever.** PDPP servers should never request inference on the user's behalf. This would expand the trust model (server now influences what the LLM sees / costs) for no PDPP-shaped benefit. |
| **Roots** (client filesystem boundaries) | Servers ask clients what filesystem paths they may touch. | **No.** The MCP adapter does not touch the filesystem beyond reading the `.pdpp/` cache. Roots is a coding-agent / IDE concern, not a personal-data-access concern. |

### 5. What is explicitly out of scope?

To avoid incidental complexity (and to keep the "good construction" bar from `design-notes/full-context-refresh.md`):

- **No new auth tokens.** The adapter uses the existing scoped client token.
- **No new wire contract on the PDPP side.** Every tool is a thin call to an existing `/v1/*` endpoint.
- **No connector or ingestion functionality.** The MCP adapter is read-only against the RS. Collection is a separate concern; an "MCP-driven connector trigger" tool is out of scope until there is a Collection-Profile-shaped reason for it.
- **No grant issuance.** The adapter does not call `/oauth/par`, `/oauth/register`, `/consent/approve`, or `/grants/:id/revoke` on its own. It surfaces errors that prompt the agent to run `pdpp connect`.
- **No prompts, no sampling, no roots, no subscriptions** (per §4).
- **No hosted Streamable HTTP variant in tranche 1.**
- **No bespoke MCP scope vocabulary.** Scopes are whatever the existing grant projects — streams + fields + time ranges. The adapter does not invent `mcp:tools-basic`-style scopes.
- **No Stripe-style "agent toolkit" SDK.** The MCP server *is* the agent toolkit.
- **No registry of "known MCP-ready PDPP providers."** Discovery follows the RS URL the user already gave to `pdpp connect`.

### 6. What is the smallest implementation tranche that proves the correct architecture?

**Tranche 1: stdio adapter, 5 tools, 1 resource template, no new spec.**

Concretely the adapter is a Node binary published as `@pdpp/mcp-server`, invoked by an agent harness as:

```jsonc
// claude_desktop_config.json (or equivalent)
{
  "mcpServers": {
    "pdpp": {
      "command": "npx",
      "args": ["-y", "@pdpp/mcp-server@beta", "--provider-url", "https://pdpp.example.com"]
    }
  }
}
```

On start, it:

1. Resolves the provider URL → reads `.pdpp/clients/<host>.json` and `.pdpp/grants/<grant-id>.json` and `.pdpp/tokens/<grant-id>.token`. If no token, prints a structured "no scoped grant cached; run `pdpp connect <provider-url>` first" message to stderr and exits non-zero (so the harness surfaces it).
2. Reads `/v1/schema` once with the cached token to confirm liveness, capture connector/stream catalog, and cache it.
3. Speaks MCP over stdio. Negotiates `tools: { listChanged: true }` and `resources: { listChanged: false }` capabilities.

Tools (each is a one-call wrapper, name → endpoint):

- `pdpp.schema()` → `GET /v1/schema`. Returns the grant-scoped schema as `structuredContent`.
- `pdpp.list_streams()` → `GET /v1/streams`. Returns the stream list.
- `pdpp.query_records({ stream, limit?, cursor?, order?, filter?, fields?, expand?, expand_limit? })` → `GET /v1/streams/{stream}/records?…`. The input schema mirrors `spec-data-query-api.md` query params; the output is the RS's list envelope verbatim (echoed into `structuredContent`).
- `pdpp.search({ q, streams?, hybrid? })` → `GET /v1/search` (or `/v1/search/hybrid` when the schema advertises it).
- `pdpp.fetch_blob({ blob_id, range? })` → `GET /v1/blobs/{blob_id}` with optional `Range`. Returns base64 binary content with `mimeType` from response headers.

Resource template:

- `pdpp://stream/{name}` → `GET /v1/streams/{name}` metadata document. Lets a host like Claude Desktop attach a stream's schema directly into context without invoking a tool.

Error mapping: every non-2xx RS response becomes a tool result with `isError: true` and `structuredContent: { error: { type, code, message, request_id } }`, exactly the RS error envelope from `spec-data-query-api.md`.

Tool annotations (per [MCP §Tool annotations](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)):

- All five tools: `{ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }`. Clients that surface these hints — Claude Desktop, MCP Inspector — will correctly mark the surface as read-only.

Evidence the architecture is right by construction:

- Diff includes **zero changes** to `reference-implementation/server/*` and zero new OpenSpec specs/changes.
- A live integration test (vitest or `node --test`) spins up the reference server in-memory, runs `connectProvider` to mint a scoped token, instantiates `@pdpp/mcp-server` via stdio against an MCP client harness, asserts that `pdpp.query_records` returns the same JSON as a direct `curl` to `/v1/streams/.../records`.
- Manual probe with MCP Inspector (`npx @modelcontextprotocol/inspector npx -y @pdpp/mcp-server …`) shows the five tools and one resource template.

**Tranche 2 (deferred, OpenSpec-required): Streamable HTTP variant.** Requires:

- The PAR-status polling endpoint candidate documented in the 2026-04-25 audit.
- An OpenSpec change to formalize MCP audience binding in PDPP RS tokens (`aud` claim or equivalent).
- Per-client consent for any proxy path (`/specification/2025-06-18/basic/security_best_practices#confused-deputy-problem`).
- A hosting story (likely behind the operator console, on `/mcp`, with origin validation and localhost-bind when run locally).

**Tranche 3 (deferred): resource subscriptions and elicitation**, only if real use cases pin them.

### 7. What package/app boundary should host this?

Choices considered:

| Option | Pros | Cons |
| --- | --- | --- |
| `packages/mcp-server` (new package, published as `@pdpp/mcp-server`) | Clean package boundary; matches existing `packages/cli`, `packages/local-collector`, `packages/remote-surface`; publishable independently; agent harness can `npx -y @pdpp/mcp-server@beta`. | One more package to maintain; needs its own `package.json`, README, tests. |
| Subcommand of `@pdpp/cli` (`pdpp mcp serve`) | Single install for end users; reuses CLI's `connectProvider` and credential cache code paths. | Conflates the CLI (interactive owner-facing tool) with a long-running stdio server; harness configs would invoke `pdpp mcp serve` which is awkward to communicate; harder to evolve independently. |
| Routes inside `reference-implementation/` (`/mcp`) | Zero new package; HTTP-shaped, fits Streamable HTTP eventually. | Couples MCP to the reference server, violating the boundary that `design-notes/full-context-refresh.md` defends. Means the "MCP server is a client of the RS" invariant is hidden. And conflates tranche-1 (stdio) with tranche-2 (HTTP). |
| Routes inside `apps/web` (`/.well-known/mcp`, `/mcp`) | Fits the existing `.well-known/oauth-*` pattern; same surface as Stripe's `mcp.stripe.com`. | Same coupling concern as above; Next.js is not a great host for stdio. Right place for *hosted Streamable HTTP* later, not stdio today. |

**Recommendation: `packages/mcp-server`, published as `@pdpp/mcp-server`.**

Why:

- The package boundary makes the "thin adapter, RS is the source of truth" claim physically auditable. Reviewers can verify by reading `packages/mcp-server/src/*.ts` that there is no record-layer logic, no grant logic, no auth issuance.
- It mirrors the established package shape (`packages/cli`, `packages/local-collector`, `packages/remote-surface`) and matches the publication pattern users already understand (`npx -y @pdpp/cli@beta connect …`, `npx -y @pdpp/local-collector@beta …`).
- The CLI continues to be the owner-facing interactive tool. The MCP server is a different role: a long-running subprocess driven by an agent harness, not a person.
- When tranche 2 (Streamable HTTP) arrives, the same package can ship a `serve --http` mode; `apps/web` mounts it at `/mcp` via a thin Next route, but the implementation stays in the package and reuses every code path.

`packages/mcp-server` will import:

- `@pdpp/cli`'s `readStoredCredential` / `normalizeProviderUrl` (already exported) for cache reads.
- `@modelcontextprotocol/sdk` (TypeScript SDK v1.x, since v2 is pre-alpha; v1 remains recommended through Q1 2026).
- `undici` or `node:fetch` for HTTP calls to the RS.

It will **not** import anything from `reference-implementation/` — that is the boundary that makes the construction provable.

### 8. What security hazards and evaluation/validation checks are most important?

**Hazards specific to this design:**

1. **Owner-token leakage via env confusion.** The adapter must refuse to use `PDPP_OWNER_TOKEN` even if present, unless the user has explicitly enabled an "owner-mode" flag (which the spec/skill discourages). Default behavior: scoped token only. *Check: integration test that sets `PDPP_OWNER_TOKEN` and asserts the adapter still requires `.pdpp/tokens/`.*
2. **Token in tool output.** Tools must never echo the bearer token into MCP responses (some agents log responses verbatim). *Check: snapshot test asserting no token substring appears in any tool result.*
3. **Tool description prompt-injection from manifest data.** Stream names come from `/v1/schema`, which is owner-installed connector data — generally trusted but agent harnesses [must treat tool annotations as untrusted](https://modelcontextprotocol.io/specification/2025-06-18/server/tools). The adapter should *not* dynamically generate tool descriptions from connector data; tool descriptions are static, stream names appear as enum values in `inputSchema`. *Check: code review + unit test that no schema field ends up inside a tool `description` string.*
4. **Confused deputy if the package ever grows a proxy mode.** Today the adapter is single-user, single-cache, single-token. If a future variant accepts MCP-client tokens and proxies upstream PDPP RS calls, [per-client consent is mandatory](https://modelcontextprotocol.io/specification/2025-06-18/basic/security_best_practices#confused-deputy-problem). *Check: explicit `## Out Of Scope` note in the package README that names the proxy anti-pattern.*
5. **Resource template path traversal / URI confusion.** The `pdpp://stream/{name}` template must reject names that don't match the schema-advertised list. *Check: unit test for `pdpp://stream/../etc/passwd`-style inputs returning a structured error.*
6. **`expand[]` over-fetching under low-context agents.** An agent that calls `query_records` with broad expand chains may exfiltrate more than the user intended for one prompt. The skill already guides this; the tool's input schema should keep `expand_limit` defaults conservative (5) and document the cost. *Check: input-schema review.*
7. **stdio crash leaking JSON-RPC framing.** The MCP spec mandates stdout contains only valid MCP messages; the adapter must direct all logging to stderr. *Check: integration test grepping stdout for non-JSON-RPC content during a deliberate error path.*

**Standard validation matrix for the slice (from `docs/agent-workstream-playbook.md`):**

- `openspec validate --all --strict` — no spec deltas in tranche 1; should remain green.
- `pnpm --filter @pdpp/mcp-server run test` (new package) — unit + integration coverage of the five tools and the resource template.
- `pnpm --dir reference-implementation run verify` — reference server untouched, should remain green.
- Manual probe with `npx @modelcontextprotocol/inspector npx -y @pdpp/mcp-server@beta --provider-url …` against a local reference deployment; capture the connection trace to a fixture under `tmp/workstreams/`.
- A short live-agent probe in Claude Code or Codex CLI: register the MCP server, ask "what streams can you see in my PDPP," confirm the agent calls `pdpp.list_streams`, returns the schema-scoped list, and does not invent endpoints.

## Comparison To Recommended Recommendation Shape

The owner expected "a thin MCP adapter over existing PDPP resource-server/query/grant surfaces, not a new data plane." This research agrees. The only material refinement: **scope tranche 1 to stdio alone**, and treat Streamable HTTP as a separately-spec'd tranche-2 effort whose protocol candidates already exist as gap notes in the 2026-04-25 reference-surface audit. Going stdio-first removes the entire surface that would require new normative MCP authorization work, keeps the existing grant flow as the single user-consent vocabulary, and matches how Stripe/Plaid/Cloudflare-era platforms have shipped MCP.

## Promotion Trigger

Promote to OpenSpec before any of these:

- Adding tools that mutate data, trigger collection runs, or issue grants (would change durable behavior).
- Adding Streamable HTTP serving (changes auth posture, RFC 9728 metadata, requires audience binding).
- Adding sampling, prompts, resource subscriptions (each changes the trust/consent surface).
- Publishing `@pdpp/mcp-server` outside `@beta`.

Until then, the adapter can ship as a `@beta` package built from a single non-OpenSpec implementation change, because every behavior is a wrapper around an already-spec'd endpoint and the cache shape is already in the 2026-04-25 audit.

## Next OpenSpec / Implementation Recommendation

Open a single OpenSpec change: **`add-mcp-stdio-adapter`** with these properties:

- Capability: new `mcp-adapter` capability (mirrors `polyfill-connector-system`'s shape — narrow, package-local, no Core/Collection spec deltas).
- Proposal: "Ship `@pdpp/mcp-server` as a stdio MCP server that wraps the existing PDPP RS. No protocol changes. No new tokens. No grant issuance."
- Design rationale: this note (link).
- Spec delta: a single ADDED requirement saying the adapter MUST be read-only against the RS, MUST use scoped client tokens from `.pdpp/`, MUST refuse owner tokens by default, MUST NOT issue grants, MUST surface RS errors verbatim. Scenarios: cached-grant present → list_streams succeeds; cache empty → exits non-zero with `pdpp connect` guidance; `invalid_token` from RS → terminal MCP error.
- Tasks: package scaffolding; the five tools + one resource template; tests; README; `pnpm` workspace wire-up; agent-skill update mentioning the optional MCP install path; release script.

After tranche 1 ships and is exercised by real agents for a week or two, decide tranche 2 (Streamable HTTP) on evidence: do remote/hosted agent harnesses actually need it, and is the PAR-polling endpoint ready?

## Decision Log

- 2026-05-21: Captured initial research. Conclusion: stdio adapter in `packages/mcp-server`, read-only over existing RS, no spec deltas. Streamable HTTP and resource subscriptions deferred to later tranches with explicit OpenSpec gates. This note is the input to a `add-mcp-stdio-adapter` OpenSpec change that the owner should open before any implementation.

## Citations

Primary MCP sources (all 2025-06-18 spec):

- [Specification overview](https://modelcontextprotocol.io/specification/2025-06-18)
- [Transports (stdio, Streamable HTTP)](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
- [Authorization (OAuth 2.1, RFC 9728, RFC 8707, RFC 7591)](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)
- [Security best practices (confused deputy, token passthrough, session hijacking, SSRF, scope minimization)](https://modelcontextprotocol.io/specification/2025-06-18/basic/security_best_practices)
- [Resources and resource templates](https://modelcontextprotocol.io/specification/2025-06-18/server/resources)
- [Tools (annotations, structured content, error model)](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
- [Elicitation](https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation)
- [Sampling](https://modelcontextprotocol.io/specification/2025-06-18/client/sampling)
- [Roots](https://modelcontextprotocol.io/specification/2025-06-18/client/roots)

Referenced RFCs:

- [RFC 9728 — OAuth 2.0 Protected Resource Metadata](https://datatracker.ietf.org/doc/html/rfc9728)
- [RFC 8707 — Resource Indicators for OAuth 2.0](https://www.rfc-editor.org/rfc/rfc8707.html)
- [RFC 7591 — OAuth 2.0 Dynamic Client Registration](https://datatracker.ietf.org/doc/html/rfc7591)
- [RFC 9126 — OAuth 2.0 Pushed Authorization Requests](https://datatracker.ietf.org/doc/html/rfc9126)
- [RFC 9396 — OAuth 2.0 Rich Authorization Requests](https://datatracker.ietf.org/doc/html/rfc9396)
- [RFC 8628 — OAuth 2.0 Device Authorization Grant](https://datatracker.ietf.org/doc/html/rfc8628)
- [OAuth 2.1 draft-13](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-13)

SDK and implementation references:

- [Official TypeScript SDK (`@modelcontextprotocol/sdk`)](https://github.com/modelcontextprotocol/typescript-sdk) — v1.x is the recommended production target; v2 is pre-alpha.
- [TypeScript SDK v1 docs (`ts.sdk.modelcontextprotocol.io`)](https://ts.sdk.modelcontextprotocol.io/) — server class is `McpServer`; transports are `StdioServerTransport` and `StreamableHTTPServerTransport`; OAuth helpers exist as example clients.
- [Cloudflare Agents — MCP Transport docs](https://developers.cloudflare.com/agents/model-context-protocol/transport/) — hosted Streamable HTTP pattern via `McpAgent`/`createMcpHandler`.
- [Python SDK `mcp.server.auth` Resource Server example](https://github.com/modelcontextprotocol/python-sdk) — reference RS implementation.

Industry pattern surveys:

- [WorkOS — Everything your team needs to know about MCP in 2026](https://workos.com/blog/everything-your-team-needs-to-know-about-mcp-in-2026)
- [Stack Overflow Blog — Authentication and authorization in MCP](https://stackoverflow.blog/2026/01/21/is-that-allowed-authentication-and-authorization-in-model-context-protocol/)
- [Auth0 — Why MCP's move away from SSE simplifies security](https://auth0.com/blog/mcp-streamable-http/)

Internal PDPP sources cross-referenced:

- `spec-core.md` §8 (RS query interface — authoritative)
- `spec-data-query-api.md` (superseded but useful for endpoint shapes)
- `spec-auth-design.md` (two-bearer-kind decision)
- `docs/agent-skills/pdpp-data-access/SKILL.md` (current agent-facing flow this adapter inherits)
- `openspec/changes/add-agent-scoped-pdpp-access/design-notes/2026-04-25-reference-surface-audit.md` (existing surfaces, cache shape, PAR-status gap)
- `openspec/changes/add-agent-scoped-pdpp-access/design-notes/2026-04-26-skill-distribution-prior-art.md` (MCP-vs-skill division of labor)
- `design-notes/full-context-refresh.md` (Core/Collection/reference boundary that this design must preserve)
- `docs/personas/standards-editor-reviewer.md` (Dick Hardt on the OAuth/MCP pathology — relevant for the "don't bypass grants" framing)
