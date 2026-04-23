# Pre-existing test failure triage (2026-04-22)

Note for supervisor: these failures existed before the reference-local
third-party connect tranche and were triaged during that tranche to decide
what was safe to fix now vs. what belongs to later deferred work.

## Fixed in this tranche (mechanical)

- **Missing `@pdpp/reference-contract` workspace dep.** Added to
  `reference-implementation/package.json`. Unblocks four speculative test
  files that were failing at import time and fully greens
  `reference-implementation/test/hosted-ui.test.js` (8/8).
- **Stale hosted-UI markup assertion in `reference-implementation/test/pdpp.test.js`.**
  One regex expected `<strong>Connector:</strong> ...` but the current
  `hosted-ui.js` layer renders `<dt>Connector</dt><dd>...</dd>`. Regex
  updated. `pdpp.test.js` is now 112/112.

## Deferred (thoughtful — belong to later tranches, not this one)

All three are **untracked** test files in the repo — speculative tests for
features that don't yet exist on the reference.

- **`reference-implementation/test/control-actions.test.js`** (~13 failures)
  asserts a control-plane `/_ref/*` surface that the reference does not
  implement: `GET /_ref/connectors`, `GET /_ref/connectors/:id`,
  `GET /_ref/records/timeline`, `GET /_ref/approvals`,
  `POST /_ref/connectors/:id/run`, and a schedule lifecycle
  (upsert/list/pause/resume/delete). This is the broader control-plane
  runtime-control work tracked under the `control-plane-runtime-control-surface-audit-2026-04-21.md`
  design note and the still-open "broad storage abstraction" bullet in
  `tasks.md`. Making it green requires real endpoint and scheduler work,
  not test edits.

- **`reference-implementation/test/fastify-transport.test.js`** asserts
  that every `@pdpp/reference-contract` route manifest is served by a live
  Fastify route and that every registration names a contract op id.
  Requires porting (or adding a parallel) Fastify-native transport to the
  currently-Express server. Separate tranche.

- **`reference-implementation/test/query-contract.test.js`** (~11 failures)
  asserts record-query contract features that correspond 1:1 with the
  still-open design notes `record-query-contract-audit-2026-04-21.md` /
  `record-query-contract-proposed-direction-2026-04-21.md`: range filters
  on declared fields, freshness metadata on stream list + metadata,
  cursor sort semantics, `expand=` hydration for `has_many` relations with
  grant projection, and `blob_ref` fetch-URL injection. Needs real
  query-contract decisions and server implementation.

## Recommended framing

These three test files are an honest, in-tree specification of where the
reference is going next. Keeping them in the suite as red is useful — they
surface their tranches whenever `pnpm --dir reference-implementation test`
is run — but they should be tracked explicitly so an operator glancing at
the suite isn't surprised. A later tranche could either:

- split them into a separate `pnpm test:pending` target, or
- annotate them with `test.skip` plus a TODO referencing the driving design
  note, so the primary suite runs green while the pending contract stays
  discoverable

Either is a judgment call for the next control-plane / query-contract
tranche. No further action is required from the current reference-local
third-party connect tranche.
