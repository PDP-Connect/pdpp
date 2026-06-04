# Add OSS connector adapter kit

## Why

PDPP can scale OOTB connector coverage far faster by wrapping OSS projects that
already build and maintain personal-data extraction for a source, instead of
hand-authoring + testing each connector. The Slack connector proves the pattern
(subprocess-wraps `slackdump`, declares it in `external_tools`, honesty-tested),
but its spawn + binary-resolution plumbing is hand-rolled, so every new wrap
would re-implement it. We generalize that plumbing into a reusable adapter and
prove it by wrapping HPI (karlicoss/HPI) — a maintained "personal data in a
Python package" layer whose `hpi query … -o json` CLI emits exactly the JSONL
the adapter consumes.

## What changes

- A reusable **external-tool adapter** (`external-tool-adapter.ts`): binary
  resolution (env override → PATH), arms-length spawn with timeout + clear
  missing-binary error (install hints), and JSON/JSONL stdout parsing. The
  generalization of slack's `runSlackdump`.
- An **HPI adapter** (`hpi-adapter.ts`): maps a per-stream HPI mapping + a PDPP
  scope window onto the exact `hpi query` CLI contract, and runs + parses it.
- A real **HPI connector** (`connectors/hpi/` + `manifests/hpi.json`): a
  filesystem-binding connector exposing HPI modules as PDPP streams (default
  reddit_saved/reddit_comments/commits; overridable), with per-stream skip
  isolation and emit-time record validation.
- Honesty wiring: `hpi` declared in the manifest `external_tools` and added to
  the `external-tool-manifest-honesty` gate.

## Impact

- Code: `packages/polyfill-connectors` (new adapter modules + HPI connector +
  manifest + orchestrator registration + honesty-gate entry).
- Specs: `polyfill-runtime` (a requirement formalizing the external-tool wrap
  pattern: arms-length subprocess, declared tool + license, JSONL readback).
- No change to PDPP Core or Collection Profile wire semantics — a wrapped tool's
  connector is a normal connector. Reference Docker images do not bundle the
  tools; deployments install/mount them and set the `*_BIN` env var.
- Backward compatible: slackdump keeps working; the adapter is additive and
  reused by future wraps (Timelinize, DiscordChatExporter, tg-archive) without a
  further spec change.
