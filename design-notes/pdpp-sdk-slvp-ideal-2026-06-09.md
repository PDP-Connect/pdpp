# PDPP SDK SLVP Ideal

Status: researching
Owner: RI owner
Created: 2026-06-09
Updated: 2026-06-09
Related: `design-notes/full-context-refresh.md`, `openspec/specs/reference-implementation-architecture/spec.md`, `packages/cli`, `packages/reference-contract`, `packages/local-collector`

## Question

Should PDPP expose an ergonomic, feature-complete SDK as a first-class consumable product surface alongside MCP, CLI, and REST? If yes, what is the SLVP ideal SDK shape?

## Context

The current user-facing setup page focuses on agent connection. That is correct for Claude Code, Codex, ChatGPT-style clients, and other MCP/local-agent entrypoints, but it does not answer the developer question: "How do I use PDPP from my own code?"

The repo currently has:

- `@pdpp/cli`: public CLI package.
- `@pdpp/local-collector`: public beta package for local collection/exporter paths.
- `@pdpp/reference-contract`: private route manifests, validators, OpenAPI artifacts, and typed helpers.
- `@pdpp/mcp-server`: private MCP adapter.
- `@pdpp/operator-ui` and `@opendatalabs/remote-surface`: private/internal UI and browser-surface packages.

There is no public, ergonomic PDPP read/write SDK that gives application developers a stable client library over the PDPP REST/resource-server and AS flows.

## Stakes

- Product clarity: "Connect agents" should not absorb every entrypoint. Agents, humans using CLI, and developers embedding PDPP in code are distinct setup jobs.
- SLVP parity: MCP should not be the only excellent integration path if REST/CLI/SDK are intended first-class surfaces.
- Contract quality: a real SDK would force stable typed errors, pagination/cursor ergonomics, grant/discovery handling, and typed stream/query primitives into a coherent developer experience.
- Maintenance risk: shipping an SDK too early could freeze incomplete semantics or duplicate logic already owned by `reference-contract`, CLI, and MCP adapters.

## Current Leaning

An SDK is likely an important missing consumable surface, but it should not be slipped into the agent setup page as copy-only documentation. The SLVP ideal is probably a separate developer entrypoint and package built from the same reference-contract/OpenAPI/source-of-truth as REST, CLI, and MCP.

Initial shape to research:

- A small TypeScript SDK first, because the repo and current packages are TS/JS-first.
- Generated or schema-driven types from `@pdpp/reference-contract`, not hand-maintained duplicate request/response models.
- High-level helpers for discovery, OAuth/PAR/PKCE/device flows, grants/packages, read schema, query/search/fetch/aggregate, pagination, `changes_since`, and typed errors.
- Low-level escape hatch for raw REST calls.
- Clear separation between provider/operator/admin APIs and grant-scoped client/RS APIs.
- Examples that are runnable against a local reference instance and `pdpp.vivid.fish`.

## Promotion Trigger

Promote to OpenSpec before implementation if any of these are true:

- The SDK becomes a public package, package export, CLI command, or docs page.
- We choose SDK scope, package name, authentication helpers, generated-code strategy, or compatibility guarantees.
- The Connect/Setup IA is changed to include a developer-code entrypoint.
- REST/MCP/CLI behavior is modified to improve SDK parity.

## Decision Log

- 2026-06-09: Captured after CIMD/agent setup work revealed that the dashboard Connect page answers agent setup but not developer-code setup. No implementation approved yet. Prior art research required before claiming SLVP ideal.
