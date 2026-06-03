# OSS Connector Adapter Kit (scale OOTB connectors by wrapping maintained OSS)

Status: decided-promote
Owner: project owner (the owner) + RI owner
Created: 2026-06-03
Updated: 2026-06-03
Related: openspec/changes/add-oss-connector-adapter-kit/ (this change),
  spec-connector-ecosystem.md (root, informational prior-art catalog),
  connectors/slack/* (the proven precedent), openspec/specs/polyfill-runtime/spec.md

## Question

How do we scale PDPP's out-of-the-box connector coverage reliably by reusing
what OSS projects already build and actively maintain — so that, e.g., if HPI
keeps an Apple Notes module up to date, we build a thin adapter and delegate to
upstream-maintained complexity instead of authoring + testing + getting an
account for each source ourselves?

## Context

The Slack connector already proves the pattern: it subprocess-wraps `slackdump`
(AGPL, arms-length), declares the tool in
`manifest.runtime_requirements.external_tools[]`, and an honesty test
(`external-tool-manifest-honesty.test.ts`) enforces the declaration. But the
spawn + binary-resolution + missing-binary-error plumbing is hand-rolled inside
the Slack connector. There was no reusable adapter, so each new OSS wrap would
re-implement it.

The root `spec-connector-ecosystem.md` (informational) already catalogs the
candidates with wrap-difficulty ratings: slackdump, Timelinize, HPI/rexport,
DiscordChatExporter, tg-archive, Plaid/Terra aggregators, archive parsers.

## Research finding (why HPI is the flagship wrap)

Evidence-based, not faith-based:

- HPI (karlicoss/HPI, MIT) exposes a first-class CLI: `hpi query
  my.<module>.<fn> -o json --stream [--order-key ...] [--after ...]
  [--before ...] [--limit ...]` that emits JSON/JSONL on stdout — the exact
  shape our adapter consumes (cleaner than slackdump, which routes via SQLite).
- Its `--order-key/--after/--before/--limit` map ~1:1 onto PDPP `cursor_field`
  + `START.scope.time_range` + limit.
- `hpi modules` enumerates installed modules (discovery for future mappings).
- Most HPI modules read user-provided exports (`my.config` export_path), so an
  HPI-backed connector is a **filesystem-binding, offline** connector — no
  live-account brittleness, the opposite of the hostile-walled-garden trap.
- HPI is a connector **family**: one adapter + a thin per-module mapping
  (HPI function → stream, order-key → cursor_field) yields many PDPP streams.

Alternatives, for the record:
- **Timelinize** (Go, Apache-2.0, 13+ sources): a full app (localhost server +
  SQLite timeline + web UI), not a stdout-JSONL CLI. Higher coverage but
  "medium" wrap difficulty (drive import API + read its DB). Good SECOND target.
- **DiscordChatExporter** (C#/.NET, GPL): clean `export -t <token> -f Json`,
  "easy" but narrow + needs a live user token. Good quick win, less instructive.
- **rexport/tg-archive**: single-source; rexport is subsumed (HPI my.reddit uses
  it under the hood).

## Current Leaning

Ship a reusable **external-tool adapter** + prove it with a real HPI connector.

1. `external-tool-adapter.ts` — the generalized kernel of the slackdump wrap:
   - `ExternalToolSpec` (name, binEnvVar, defaultBin, installHint, timeout knobs)
     where `name` MUST match the manifest `external_tools[].name` (honesty test).
   - `resolveToolBin` (env override → PATH), `formatMissingToolError`
     (install-hint error), `runExternalTool` (arms-length spawn, timeout,
     ENOENT-translated + exit-code errors), `parseToolRecords` (JSON or JSONL).
2. `hpi-adapter.ts` — the HPI layer: `buildHpiQueryArgs` (the exact CLI
   contract, asserted in tests so a flag move is caught without a live run),
   `windowFromScope`, `queryHpiStream`.
3. `connectors/hpi/` + `manifests/hpi.json` — a real filesystem-binding HPI
   connector with a default per-module mapping (reddit_saved/reddit_comments/
   commits), overridable via `HPI_STREAMS` (and `START.connector_options.STREAMS`
   once options_schema lands). Per-stream skip isolation: a missing/unconfigured
   module skips that stream, never aborts the run. `validateRecord` wired (zod
   `looseObject` so upstream-shaped fields pass through). `hpi` declared in
   `external_tools` and added to the honesty gate.

### Honesty + licensing posture

- External tools are spawned arms-length (subprocess), never imported as
  libraries — same posture that keeps slackdump's AGPL at arm's length. Each
  wrapped tool's license is declared in the manifest `external_tools[].license`.
- `public_listing.status` stays honest: the HPI connector ships
  `listed:false, status:needs_human_auth` because it needs host-side `my.config`
  + exports before it can collect; it is not a turnkey proven connector.
- The reference Docker image does NOT bundle these tools; deployments that want
  them install/mount the binary and set the `*_BIN` env var (same as slackdump).

## Promotion Trigger

Promoted concurrently with `add-oss-connector-adapter-kit` because it adds a
reusable runtime/authoring abstraction (the adapter) and a new connector — both
cross the promotion rule. Future wraps (Timelinize, DiscordChatExporter,
tg-archive) reuse the adapter and only need their own per-tool spec + mapping +
manifest, with no further spec change.

## Decision Log

- 2026-06-03: Created. Generalize slackdump → external-tool adapter; flagship
  wrap = HPI (evidence-based: native JSONL CLI, cursor-mappable flags, connector
  family, offline filesystem binding). Timelinize = second target. Arms-length
  subprocess + declared license + honest public_listing.
