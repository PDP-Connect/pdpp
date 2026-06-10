## Context

`design-notes/mcp-server-design-research-2026-05-21.md` concludes that PDPP should support MCP as a local agent-facing adapter over existing grant-scoped RS reads. MCP is useful because agents can discover and call tools/resources consistently, but the PDPP authorization boundary must remain the grant and token that the RS already enforces.

Current repo state has PDPP CLI/connect cache concepts and RS read endpoints, but no shipped MCP server. There are archived notes about optional MCP bindings and current docs warning about MCP/OAuth security pitfalls; there is no implementation to preserve.

## Goals / Non-Goals

**Goals:**

- Ship a small `@pdpp/mcp-server` package that runs over stdio for local MCP clients.
- Reuse existing scoped client tokens from the PDPP credential cache.
- Map MCP tools/resources directly to existing RS reads.
- Keep stdout protocol-clean and make errors preserve RS authorization semantics.
- Prove the package boundary by avoiding `reference-implementation/` imports.

**Non-Goals:**

- No hosted Streamable HTTP MCP server in this tranche.
- No grant issuance, consent UI, Dynamic Client Registration, or token minting through MCP.
- No connector execution, local collection, scheduler control, or owner-control operations.
- No prompts, sampling, roots, subscriptions, or elicitation until a concrete need justifies them.
- No new PDPP query semantics beyond the RS contract.

## Decisions

### Stdio First

Use stdio first because the first target is local agent tooling. Stdio avoids adding another hosted OAuth-protected surface before there is a concrete remote-agent use case. Streamable HTTP remains a future change once resource indicators, protected-resource metadata, and remote-client authorization posture are designed explicitly.

Alternative considered: implement Streamable HTTP first. Rejected for this tranche because it would either duplicate PDPP authorization or tempt owner-token passthrough.

### Adapter, Not Data Plane

The MCP package is a client of the RS. It does not inspect the DB, import reference server code, or implement grant enforcement itself. Every data-bearing response comes from RS calls under the configured token.

Alternative considered: embed MCP routes inside the reference server. Rejected because it blurs the control plane with an agent adapter and makes future standalone package publication harder.

### Scoped Client Token Only

The adapter reads an existing scoped client token from the `pdpp connect` credential cache. It refuses owner tokens by default because owner self-export is broader than most agent grants and would make MCP a privilege-escalation footgun.

Alternative considered: allow owner tokens for convenience. Deferred until there is a separate explicit owner-mode UX and threat model.

### Minimal MCP Capability Set

Start with five tools and one resource template: schema, list streams, query records, search, fetch blob, and `pdpp://stream/{name}`. These map cleanly to RS reads. Do not add prompts, roots, sampling, subscriptions, or elicitation without a product need and a security review.

## Risks / Trade-offs

- **Credential cache mismatch** → Use existing CLI cache helpers or extract a shared helper, and test cache-empty/error cases.
- **Prompt-injection via schemas/metadata** → Keep tool descriptions static; treat manifest/stream metadata as data, not instructions.
- **Scope confusion** → Surface RS errors verbatim and never retry through broader credentials.
- **Blob exfiltration risk** → Fetch blobs only through RS `fetch_url`/blob endpoints with the same scoped token.
- **Overbuilding MCP** → Keep the first package stdio/read-only and require a new OpenSpec change for Streamable HTTP or owner mode.

## Migration Plan

1. Add `packages/mcp-server` as a private/beta workspace package.
2. Implement the stdio server and read-only tool/resource set.
3. Add unit tests for credential/cache/error mapping.
4. Add an integration test against a reference server fixture proving MCP output matches direct RS output under the same scoped token.
5. Document local use from MCP clients and update PDPP agent-skill guidance.

Rollback is removal of the package and workspace entries; no protocol or reference DB migration is introduced.

## Open Questions

- Exact credential-cache helper reuse: import from `@pdpp/cli`, move shared code to a small package, or duplicate a tiny read-only helper for tranche one.
- Whether the first published package should be `private: true` while validated locally or immediately beta-published under the existing PDPP package policy.
