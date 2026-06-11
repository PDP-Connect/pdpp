# Tasks — render-three-class-consent-authorship

## 1. OpenSpec

- [x] 1.1 Write `proposal.md` — the violation, the fix, capability target.
- [x] 1.2 Write `specs/reference-implementation-architecture/spec.md` — normative
      delta pinning the three-class consent presentation.
- [x] 1.3 `openspec validate render-three-class-consent-authorship --strict`.
- [x] 1.4 `openspec validate --all --strict`.

## 2. Consent render path

- [x] 2.1 Extend the renderer's `PendingGrantRequest.selection.streams[]` type to
      carry `client_claims` so the per-stream claims are visible to the renderer.
- [x] 2.2 Add a `renderAuthorshipBlock(authorship, …)` helper that wraps each
      block with a `data-authorship` attribute + an authorship eyebrow.
- [x] 2.3 Split `buildConsentClientDisplay` into PROTOCOL identity facts (CIMD
      origin / metadata document) and CLIENT self-described display.
- [x] 2.4 Add `buildClientClaimsBlock` rendering per-stream `client_claims`
      (purpose + commitments) as a disclaimed CLIENT block; omit when empty.
- [x] 2.5 Rewrite `renderPendingGrantConsentHtml` to emit distinct PROTOCOL,
      MANIFEST, and CLIENT blocks instead of one flattened key/value list.
- [x] 2.6 Apply the same three-class split in `buildBatchSourceCards` and the
      batch client-identity surface.
- [x] 2.7 Add authorship-class CSS (left-rule tier colors; dashed rule + italic
      disclaimer for client) to `hosted-ui.js`.

## 3. Tests

- [x] 3.1 Add `test/security-consent-authorship-classes.test.js`: an HTTP-level
      consent request carrying `client_claims` + `purpose_code` renders all
      three classes distinctly; client claims appear only in the CLIENT block,
      never in the PROTOCOL block; the "not enforced" disclaimer is present.
- [x] 3.2 Add a no-`client_claims` case asserting the three classes still render
      and no empty claims scaffold leaks.
- [x] 3.3 Existing consent/hosted-ui suites stay green.

## 4. Verification

- [x] 4.1 `tsc --noEmit` clean for the changed reference-implementation files.
- [x] 4.2 `biome check` clean for the changed files.
- [x] 4.3 Focused consent/hosted/device-auth suites green.
