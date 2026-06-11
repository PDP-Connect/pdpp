# Tasks — prove-single-use-grant-consumption

## 1. OpenSpec

- [x] 1.1 Write `proposal.md` — enforcement gap, fix, scope.
- [x] 1.2 `openspec validate prove-single-use-grant-consumption --strict`.
- [x] 1.3 `openspec validate --all --strict`.

## 2. Tests

- [x] 2.1 Add `issueToken` to the import list in `test/pdpp.test.js`.
- [x] 2.2 Add `single_use grant: second token issuance is rejected with
      grant_consumed` — issue grant → confirm RS query → confirm DB consumed=1
      → assert second `issueToken()` call throws `{ code: "grant_consumed" }`.
- [x] 2.3 Add `continuous grant: repeated token issuances succeed (not consumed
      after first use)` — control path: continuous grant DB consumed=0 after
      first issuance, second `issueToken()` returns a fresh token, RS query
      with second token returns HTTP 200.

## 3. Documentation

- [x] 3.1 Add "Replayable proof: single_use consumption" subsection to
      `grant-design.md` under `### access_mode` with a copy-pasteable curl
      sequence (PAR → approve → RS query → second issuance rejected) and a
      plain-English description of the enforcement mechanism (atomic SELECT FOR
      UPDATE / UPDATE, `invalid_grant` at the HTTP boundary).

## 4. Verification

- [x] 4.1 Both new tests pass (`✔ single_use grant: second token issuance …` and
      `✔ continuous grant: repeated token issuances …`).
- [x] 4.2 Existing `single_use grants issue one token but allow reuse …` test
      still passes (no regression to pagination behavior).
- [ ] 4.3 `tsc --noEmit` clean for changed files.
- [ ] 4.4 Full pdpp.test.js suite green.
