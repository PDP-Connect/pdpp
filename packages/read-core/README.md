# @pdpp/read-core

`@pdpp/read-core` contains pure, adapter-agnostic primitives for shaping PDPP
read results into bounded previews, continuation descriptors, handle metadata,
and deliberate escalation paths.

It is the shared core consumed by independently-installed read adapters
(`@pdpp/mcp-server`, `@pdpp/cli`, and future REST/SDK adapters). Given records,
record-sets, or field reads, it returns structured, bounded descriptors that
any adapter can render — the adapter decides how to present them.

## Boundary (what belongs here, and what does not)

**In scope** — pure read shaping only:

- Bounded previews of records and record-sets.
- Content ladders and field-window evidence (progressive disclosure).
- Continuation descriptors and opaque content handles (encode/decode).
- Binary/blob field metadata.
- Deterministic truncation and stable inline JSON.
- Stable record identity for evidence.

**Out of scope** — keep these in the adapter or server layers:

- No authorization, grants, or token semantics.
- No HTTP, transport, or networking.
- No filesystem or export I/O.
- No CLI parsing or flag handling.
- No UI rendering beyond minimal stable descriptors.
- No connector-specific or source-specific business semantics.
- No single-client quirks baked in as core semantics (client workarounds
  belong in the adapter that needs them).

The package keeps a deliberately small, stable public API so adapters can build
against it safely.
