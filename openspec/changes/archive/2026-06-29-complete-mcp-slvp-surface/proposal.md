# Complete MCP SLVP Surface

## Why

The current MCP closeout proves the ChatGPT Slack evidence path: search can show bounded evidence, `read_record_field` can return an inline field window, and projected fetch avoids file materialization for ordinary messages.

That is not the full SLVP bar. The full bar is a best-in-class agent data surface: compact discovery, visible evidence, explicit continuations, deliberate export escalation, and no client-visible dead ends across MCP clients, REST, and CLI.

## What Changes

- Define a hostile-client conformance matrix for MCP hosts and content/resource visibility modes.
- Make visible handle semantics unambiguous: a visible record or field/window handle is either model-callable or not shown as a readable continuation.
- Extend bounded evidence semantics beyond the Slack happy path to small text, large text, JSON fields, blobs, stale handles, and export escalation.
- Add REST and CLI parity for the evidence ladder so MCP is not the only first-class surface.
- Tighten setup, README, server instructions, and tool descriptions so agents know the intended ladder without relying on prior chat context.
- Add journey-level gates that fail on invisible-only evidence, dead-end continuations, grant leakage, invented matches, accidental file materialization, and ambiguous setup.

## Capabilities

Modified:

- `mcp-adapter`

## Impact

- Affects MCP tool output, resources/handle behavior, REST evidence envelopes, CLI read commands, package/operator docs, and conformance tests.
- Does not change PDPP Core grant semantics.
- Does not authorize MCP to run connectors, mutate source data, or use owner tokens.
- Deployment requires a live-stack mutex and client retests after local gates pass.
