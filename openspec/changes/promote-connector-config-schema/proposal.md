# Promote connector configuration schema (credentials_schema + options_schema)

> **OWNER REVIEW REQUIRED — DO NOT ARCHIVE WITHOUT CLOSE REVIEW.**
> This change promotes a long-parked open question (the archived
> `connector-configuration-open-question.md`). It touches the manifest surface
> and the START wire shape, so it needs sign-off from both the RI owner and the
> PDPP owner before it is treated as settled. It is written so the *additive,
> backward-compatible* parts (the `START.connector_options` field, already
> consumed by `readOptions`) can land immediately while the *normative manifest*
> parts (`options_schema`, `credentials_schema`) stay clearly review-gated.

## Why

Every connector grows its own ad-hoc env-var namespace (`SLACK_LOOKBACK_DAYS`,
`CLAUDE_CODE_PROJECT_INCLUDE`, `GMAIL_IMAP_HOST`, …). Credentials and tuning
knobs share the same `process.env` layer, with no machine-readable declaration.
Consequences:

- Orchestrators, the console, and consent cards cannot surface options as UI,
  CLI flags, or consent detail — there is no schema to render.
- Credentials leak into every child process via `process.env` with no declared
  boundary between secret and non-secret config.
- Two upcoming features are blocked on this: (1) the **agent-authored connector**
  needs a declared way to carry user preferences into a synthesized connector,
  and (2) the **OSS adapter kit** needs per-connector option declarations
  (e.g. HPI module selection, export paths) to be portable.

`packages/polyfill-connectors/src/connector-options.ts#readOptions` already reads
`START.connector_options` and falls back to env, so the runtime half is built and
waiting; only the wire-field declaration and the manifest schema fields are new.

## What changes

- **Additive (safe to land now):** declare `connector_options` as an optional
  field on the canonical `StartMessage` protocol type. No behavior change — it is
  already read defensively.
- **Manifest (review-gated):** add two OPTIONAL manifest fields,
  `options_schema` (JSON-Schema of operator tuning knobs with defaults) and
  `credentials_schema` (JSON-Schema of required secrets). Both are
  reference/polyfill *authoring + validation* metadata, NOT PDPP Core protocol.
- **Runtime (review-gated):** the runtime SHALL validate `START.connector_options`
  against the manifest `options_schema` before spawning a connector, and SHALL
  keep credentials out of `connector_options` (credentials travel the credential
  path only). Options are captured/frozen in the run spine; credentials never are.

## Impact

- Specs: `polyfill-runtime` (new requirements; all scoped as
  reference/authoring metadata, explicitly not Core/Collection-Profile).
- Code: `connector-runtime-protocol.ts` (additive field — landed in this change),
  `connector-options.ts` (doc/pointer refresh — landed), plus a future
  `validateConnectorOptions` runtime hook and a manifest-honesty test (tasked).
- No breaking change: connectors using env vars keep working; the field and
  schemas are optional everywhere.
