# Hypothetical Connector Author Handoff

This memo is a hypothetical handoff for a colleague who wants to fork the PDPP reference implementation and begin building a large set of connectors for use with a personal coding agent.

It is **not** a canonical plan or steering document. The canonical program tracker is in `openspec/`.

## Short answer

Yes: a colleague could fork the current `reference-implementation/` and start building real connectors now for sources like:

- USAA
- YNAB
- local Codex logs on disk
- email exports
- CSV / JSONL file drops
- SaaS dashboards with session-based browser auth

The current reference is strong enough for an internal connector-authoring alpha. It already has:

- a real runtime
- a real CLI
- real AS/RS enforcement
- real grant and token paths
- a stable enough Collection connector protocol
- black-box coverage around the runtime and disclosure surface

What is still moving is mostly higher-level semantic convergence, not the basic connector authoring contract.

## What a connector author should treat as stable enough

Use the current `reference-implementation/` contract as the target:

- Connector manifest registration through `POST /connectors`
- Runtime `START` input with:
  - `collection_mode`
  - scoped stream selection
  - prior `state` for incremental runs
- Connector output envelopes:
  - `RECORD`
  - `STATE`
  - `DONE`
  - `INTERACTION`
  - `PROGRESS`
  - `SKIP_RESULT`

Important current expectations:

- Every stream manifest should include a valid `primary_key`.
- `DONE(status)` and process exit code must agree.
- `STATE` is checkpoint input, not an automatic commit signal.
- The runtime behaves like a checkpointed streaming system today.
- Connectors should not assume any legacy/demo flow exists.

## What connector authors should ignore

Do **not** build against removed or non-canonical surfaces:

- deleted demo shells
- deleted demo bridge routes
- old `e2e/` naming
- old flat or envelope-shaped request/grant inspection formats
- any legacy scalar binding assumptions

The latest approach only is the supported path.

## Practical guidance for a colleague

If I were handing this to a colleague today, I would tell them:

1. Fork the repo and work inside `reference-implementation/`.
2. Use existing connectors and runtime tests as templates.
3. Treat the Collection runtime protocol and manifest validation as the hard contract.
4. Prefer connectors that emit clean `RECORD` / `STATE` / `DONE` flows before adding richer `INTERACTION` behavior.
5. Add connector-specific tests early so runtime/protocol drift is visible immediately.

Suggested early connector classes:

- file-backed connectors
  - local logs
  - exported JSON/CSV
  - browser download artifacts
- API connectors with stable HTTP auth
  - YNAB
  - simple banking or budgeting APIs
  - internal SaaS tools
- browser-automation connectors for hard targets
  - USAA-style sites
  - session-heavy consumer apps

## What might still change

These areas are still being hardened:

- deeper Collection Profile semantics
- some native/polyfill internal convergence
- final launch-shape decisions around the broader provider-connect surface

But those should not block basic connector authoring.

The right posture is:

- start building connectors now
- keep them aligned to the current runtime/test contract
- expect some tightening around semantics, not a reinvention of the connector authoring model

## Bottom line

If the question is:

> Could a colleague start implementing a bunch of connectors now and expect them to be usable when the reference is finalized?

My answer is:

**Yes, for an internal alpha.**

I would not yet present the current fork as a fully frozen external SDK/platform, but it is already a credible substrate for building and validating real connectors.
