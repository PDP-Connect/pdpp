# Design: connector configuration schema

## Status

**Review-gated.** The additive `START.connector_options` field is low-risk and
landed in this change. The manifest `options_schema` / `credentials_schema`
fields and the runtime validation requirement need close RI-owner + PDPP-owner
review before archive, because they expand the manifest surface that other
implementations may rely on.

## The three authorship layers (the core distinction)

Config is not one thing. It splits cleanly by *who authors it*:

| Layer | Who authors | Where it lives | Example | Already handled? |
| --- | --- | --- | --- | --- |
| **Scope** | client, per-run | `START.scope` | time_range, resources, fields | Yes (runtime enforces) |
| **Options** | manifest declares the knob, user/operator authors the value | `START.connector_options`, validated vs manifest `options_schema` | Slack lookback days, HPI module list | Partially (`readOptions` reads it; no schema yet) |
| **Credentials** | user authors the secret value; manifest declares the shape | credential path (env today, grant-injected later), shape in manifest `credentials_schema` | `GMAIL_APP_PASSWORD`, `SLACK_TOKEN` | env today; no declared shape |

The load-bearing principle: **manifest authors the knob; the user authors the
value.** This lets the console / consent card render options as toggles without
the manifest ever embedding a user's actual values.

## Why options ride on START (not a sibling channel)

`START.scope` already governs *what data comes back*. Options govern *how the
connector gets there* (IMAP host, project-dir exclude, pagination, which HPI
module). They are connector-private — the runtime can't semantically validate
them beyond shape — so they ride alongside `scope` on START and are validated
against the manifest-declared `options_schema` (shape only) before spawn.

## Why credentials do NOT ride on START

Credentials are secrets. They must never appear in `connector_options` (which is
captured/frozen in the run spine for audit). Credentials travel the dedicated
credential path: env today; grant-injected into the connector's env/stdin at
START time in the multi-tenant future. The manifest declares only their *shape*
(`credentials_schema`), never their values.

## Leakage boundary (normative intent)

- `connector_options` is captured in `spine_events` for run reproducibility.
- Credentials are NEVER persisted to `spine_events.data_json` or logged.
- The runtime rejects a connector whose `credentials_schema` field names collide
  with `options_schema` field names (prevents a secret being smuggled as an
  option).

## Alternatives considered

1. **Leave it as env vars (status quo).** Rejected: blocks the agent-authored
   connector and the OSS adapter kit; no UI/consent rendering possible.
2. **Put config in the Collection Profile spec (wire-normative).** Rejected for
   now: the Profile is about AS/RS↔connector message shape and validation; how
   secrets materialize inside a connector process is orchestrator-specific. We
   scope these as reference/polyfill authoring metadata, with an explicit
   promotion path to a companion spec if cross-implementation interop is needed
   (mirrors how `refresh_policy` hints are scoped today).
3. **One combined `config_schema`.** Rejected: collapses the secret/non-secret
   boundary that is the whole point.

## Acceptance checks

- `StartMessage.connector_options` is an optional declared field; existing
  connectors and tests are unaffected (backward compatible).
- A connector with a manifest `options_schema` has its `START.connector_options`
  shape-validated before spawn; an out-of-shape option fails fast with a named
  error, not a silent drop.
- A manifest-honesty test asserts that no `options_schema` field name overlaps a
  `credentials_schema` field name.
- Credentials never appear in captured `connector_options`.
