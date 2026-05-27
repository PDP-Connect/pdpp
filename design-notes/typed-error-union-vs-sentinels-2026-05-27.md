# Typed Error Union vs `err.code` Sentinels

Status: captured
Owner: project owner
Created: 2026-05-27
Updated: 2026-05-27
Related: `tmp/workstreams/code-quality-deep-audit-report.md` (Finding #9), `openspec/changes/wire-route-contract-validation`, `design-notes/server-index-split-and-js-to-ts-2026-05-27.md`

## Question

Should the 136 `err.code = '<sentinel>'` assignments across `reference-implementation/server/` (down from 188 at audit time, still concentrated in `auth.js` 37, `index.js` 26, `records.js` 20, `postgres-records.js` 13) be replaced by a typed `PdppError<Code extends string>` discriminated union — and if so, in what shape and order?

## Context

- The current pattern is a homegrown discriminated union expressed by mutating `Error.code` after `new Error(message)`, then `switch (err.code)` at the call site. TypeScript cannot see the relationship.
- The pattern is reachable but invisible to `tsc` because `checkJs: false` in `tsconfig.json` (see `design-notes/server-index-split-and-js-to-ts-2026-05-27.md`). Even after JS→TS migration lands for `index.js` and others, the `err.code = '...'` assignments remain anys.
- The contract validation tranche (`wire-route-contract-validation`) now emits structured `pdpp_error` envelopes at the transport boundary with `code: 'invalid_request'`. The space of error codes the transport produces is small and known; the much larger space lives in business logic in `auth.js`, `records.js`, and the OAuth surfaces.
- `as unknown` casts (76 repo-wide per the audit) cluster around these untyped error paths, so the codes' opacity to the type system actively widens the `any` blast radius.

## Stakes

- Per the audit, this is P2 — important but not blocking. Sentinel-by-string is functionally correct; the cost is invisibility to the compiler, not runtime defect risk.
- A new `PdppError` shape interleaves with the in-flight protocol-level error envelope work (`harden-reference-auth-surfaces`, `wire-route-contract-validation`). A wrong abstraction here would force a second migration when those land.
- The `code` strings ARE part of the on-wire contract — they appear in `pdpp_error.code`. Changing them is a protocol-observable change; changing only the type of the in-process value is not.

## Current Leaning

Defer a generalized `PdppError<Code>` until the server `index.js` split and JS→TS migration (see related design note) brings the largest sentinel files (`auth.js`, `records.js`, `index.js`) under `tsc`'s visibility. Until then, the `err.code` sentinels are typed-as-any, and there's no compiler benefit to invent the union shape upstream of the type checker even being able to see the call sites.

Once those files are .ts:

- Define a single `PdppError` class with `code: PdppErrorCode` (a string-literal union) in `reference-implementation/lib/pdpp-error.ts`.
- Source-of-truth for the union: enumerate codes by grepping `err.code = '...'` and `switch (err.code)` across the migrated server tree, then pin the union in one file. Do NOT generate the union from the contract package's AJV errors — those are a different surface (`invalid_request` is one shape; business codes like `connector_paused`, `consent_required`, `device_code_expired` are others).
- Migration order: the file that READS `err.code` for control flow first (so the union enforces exhaustiveness on `switch`), then the files that WRITE `err.code`.
- Keep the wire payload identical. The class swap is a refactor, not a protocol change.

## Promotion Trigger

Promote into OpenSpec when both of these are true:

1. The relevant server files are TypeScript and seen by `tsc --noEmit`.
2. The owner approves treating the error-code union as a durable, audit-able surface (since the codes ARE part of the wire envelope).

Specifically, promotion is justified because:

- the code set is part of the public PDPP error envelope shape;
- the migration touches every handler that reads or writes a sentinel (≥ 5 files);
- the type union becomes a shape future contributors can extend mechanically.

## Non-Goals

- This note does NOT propose adopting `neverthrow`, `effect-ts`, `fp-ts`, or any other Result/IO abstraction. The error sentinel problem is local; the existing throw/catch flow stays.
- This note does NOT propose changing wire-level error codes.
- This note does NOT propose collapsing the OAuth error envelope into the PDPP one — they are intentionally distinct, as `contract-validation.js` already encodes via `pickRequestErrorEnvelope(manifest)`.

## Decision Log

- 2026-05-27: Captured. Sentinel count down from 188 → 136 since audit. Deferred behind `server-index-split-and-js-to-ts-2026-05-27.md` because the largest sentinel files are not yet .ts; building the union now would not improve type safety until those files participate in the type checker.
