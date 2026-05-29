# Design: connector schema-validation gate

## Problem framing

The audit's central question — "isolated bugs or construction gap?" — resolves
to construction gap. The shared `makeValidateRecord` factory is correct and the
canonical example (`amazon/schemas.ts`) is clear. The 20 schemaless connectors
are not individually broken; they predate the mandate, and nothing makes their
omission visible. A 32nd connector authored tomorrow would ship schemaless and
CI would stay green.

The SLVP standing principle applies directly: rather than authoring 20 schemas
(one-off fixes that do not prevent the next omission), identify the missing
construction boundary and install it. The boundary is: **declaring a stream in a
manifest is a promise about record shape; emitting records for that stream
without validating them silently breaks that promise.** The gate makes the
promise enforceable.

## Chosen approach: build-time inventory gate + justified allowlist

A `node:test` file in `src/` that, for every connector:

1. Reads `connectors/<name>/index.ts` and `manifests/<name>.json`.
2. Determines whether the manifest declares ≥1 stream (`streams[].name`).
3. Determines whether the connector wires emit-time validation. Detection
   signal: the `index.ts` references a `validateRecord` identifier (the wiring
   token passed into `runConnector({ ..., validateRecord })`). This exactly
   reproduces the audit's 11-wired / 20-missing split when run against the
   current tree, so it is a faithful proxy for "is validation wired."
4. If streams are declared and `validateRecord` is absent, the connector MUST be
   on the allowlist or the test fails with the connector name and the reason.

The allowlist lives in a typed module (`connector-schema-allowlist.ts`) as a
`Record<string, string>` of connector → justification. Two failure directions
are both caught:

- **Regression (new schemaless connector):** declares streams, no
  `validateRecord`, not on allowlist → test fails. The author must wire
  validation or make a reviewed allowlist entry.
- **Stale allowlist (connector since validated):** on the allowlist but now
  wires `validateRecord` → test fails, demanding the entry be removed. This is
  the ratchet: the allowlist can only shrink. As Lanes A–C author schemas, the
  gate forces the corresponding allowlist entries to be deleted, so the list is
  always an honest census of remaining gaps.

## Why a test, not a lint rule or `verify` step

- The existing precedent (`browser-manifest-honesty.test.ts`,
  `external-tool-manifest-honesty.test.ts`) is exactly this shape: a
  filesystem-scanning `node:test` asserting a manifest-vs-code invariant. Reusing
  the pattern keeps one enforcement mechanism, not two.
- `pnpm verify` is `typecheck && check` (no test run); `pnpm test` globs
  `src/**/*.test.ts`. CI runs `test`. Placing the gate in `src/` wires it into
  CI with zero plumbing.
- A custom lint rule would need an AST pass and a second config surface for the
  allowlist. The test is simpler, colocated with its allowlist, and already in
  the trusted path.

## Detection signal: token presence, not AST

The gate matches a `validateRecord` token in `index.ts` rather than parsing the
`runConnector(...)` call. Rationale:

- It matches the existing honesty tests' regex-on-source style (no new tooling).
- The canonical wiring is `import { ..., validateRecord } from "./schemas.ts"`
  followed by `runConnector({ name, validateRecord, ... })`. Any connector that
  has authored a schema and wired it will carry the token; any connector that
  has not, will not.
- False-positive risk (token present but not actually passed) is acceptable for
  a guardrail: it can only let a *validated-looking* connector through, and that
  connector still has a `schemas.ts` and a `validateRecord` export, which is the
  behavior we want. A connector cannot accidentally satisfy the gate without
  having done the schema work. If a future connector legitimately needs a
  different wiring name, that is a deliberate authoring choice and the gate
  comment documents how to extend detection.

This keeps the gate at the "is validation wired" altitude. It deliberately does
NOT assert schema *quality* (e.g. `pdppSafeText` usage, per-field bounds) — that
is the authoring guide's review-time concern and a separate audit rule, not a
binary build gate.

## Allowlist seed

The 20 connectors from the audit (F1), grouped by remediation lane:

- Lane A (higher risk — archive/parse): `google_takeout`, `twitter_archive`,
  `whatsapp`, `imessage`, `loom`.
- Lane B (medium risk — API): `anthropic`, `notion`, `oura`, `spotify`,
  `strava`, `pocket`, `linkedin`, `shopify`, `uber`.
- Lane C (lower risk — upload/trivial): `heb`, `ical`, `meta`, `apple_health`,
  `doordash`, `wholefoods`.

Each entry carries a one-line justification naming the lane. The allowlist is the
durable, machine-checked successor to the audit's prose inventory: it cannot
drift from reality because the gate cross-checks it both ways every CI run.

## Alternatives considered

- **Author all 20 schemas now (Lanes A–C).** Rejected as the SLVP boundary: it
  is the larger, connector-specific work the prompt explicitly warns against
  ("avoid boiling the ocean"), and it does not prevent the 32nd connector from
  regressing. The gate is the durable primitive; schema authoring is the backlog
  the gate measures.
- **Make `validateRecord` a required field on `runConnector`.** Rejected: the
  runtime is intentionally zod-free and must be able to run a zero-dep connector
  that has no schema (documented in `schema-registry.ts`). Forcing the field
  into the type would couple the runtime to validation and break the
  optional-by-construction property. The gate enforces policy *above* the
  optional API instead of removing the optionality.
- **A `pnpm verify` script step instead of a test.** Rejected: CI runs `test`,
  not a bespoke script; the test family already exists; colocating the allowlist
  with the test keeps one source of truth.

## Acceptance checks

- The gate test passes on the current tree (20 connectors allowlisted, 11
  validated, 0 unexplained gaps).
- Removing a connector from the allowlist while it is still schemaless makes the
  gate fail naming that connector.
- Adding `validateRecord` wiring to an allowlisted connector without removing its
  allowlist entry makes the gate fail demanding the stale entry's removal.
- A hypothetical new connector with manifest streams and no `validateRecord`
  (not allowlisted) makes the gate fail.
- No existing connector test changes behavior; the full package test suite stays
  green.
