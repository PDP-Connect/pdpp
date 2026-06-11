# Proposal: prove-single-use-grant-consumption

## Why

The PDPP grant model exposes a `single_use` access mode that is central to the
protocol's safety story — it bounds the blast radius of a grant to one
retrieval session and prevents silent reuse. The reference implementation has
enforced this atomically since the initial grant implementation, but the
enforcement had no HTTP-boundary proof:

1. The consumption check and mark (`SELECT … FOR UPDATE` / `UPDATE consumed =
   TRUE`) existed inside `issueToken()` and was exercised only by the
   existing "token reuse" test — which proves the *already-issued token*
   survives pagination, not that a **second issuance** is rejected.
2. There was no test that called `issueToken()` a second time on the same
   consumed grant and asserted `grant_consumed`.
3. There was no copy-pasteable curl sequence in any doc showing the
   issue → use → re-issue → reject lifecycle.

An engineer reading `spec-core.md` or `grant-design.md` could not replay the
enforcement. A standards reviewer could not tell whether `single_use` was
protocol-level or advisory. Making it invisible undermined the spec's credibility.

## What Changes

1. **Test**: two new integration tests in `pdpp.test.js` form the HTTP proof:
   - `single_use grant: second token issuance is rejected with grant_consumed`
     — issues a single_use grant, verifies the issued token works on the RS,
     confirms the DB `consumed` flag is set, then calls `issueToken()` again
     and asserts `{ code: "grant_consumed" }`.
   - `continuous grant: repeated token issuances succeed (not consumed after
     first use)` — the control: a continuous grant is not consumed after first
     issuance, and a second call to `issueToken()` returns a fresh token that
     works for RS queries.
2. **Doc**: `grant-design.md` gains a "Replayable proof: single_use consumption"
   subsection under `access_mode` with a copy-pasteable curl sequence (PAR →
   approve → RS query → second issuance rejected) and a description of the
   enforcement mechanism (atomic transaction, `invalid_grant` at the HTTP
   boundary).
3. No enforcement code changes — the enforcement was correct and is now proven.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `reference-implementation-governance`: the `single_use` consumption guarantee
  is now proven at the HTTP boundary by integration tests, not just implied by
  the in-process enforcement path.

## Impact

- Affected files: `reference-implementation/test/pdpp.test.js` (2 new tests),
  `docs/agent-skills/pdpp-data-access/references/grant-design.md` (curl proof
  + enforcement narrative).
- No REST contract changes, storage changes, grant semantics changes, connector
  changes, dependency changes, or server logic changes.
