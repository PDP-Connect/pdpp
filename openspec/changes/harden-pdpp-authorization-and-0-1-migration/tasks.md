## 1. Separated-RS Authorization Context (Introspection)

- [ ] 1.1 Update `spec-core.md` Section 8 `### Token introspection` (current extension-
      fields table) to replace the six-row extension-fields table with the complete
      authenticated context: `iss`, `aud`, `authorization_details` (RFC 9396 §9.2/§14.3),
      and the `pdpp` supplementary member (`grant_id`, `grant_digest`, `status`,
      `consumed_at`, `superseded_by`, consent-evidence reference, security/binding
      profile, cache bound).
- [ ] 1.2 Update `spec-core.md` Section 8 `### Grant enforcement` to reference the
      complete context object instead of the current six fields, and add the
      fail-closed rule for missing/unrecognized mandatory context fields.
- [ ] 1.3 Update `spec-core.md` Section 9 AS conformance and RS conformance items that
      reference introspection/`pdpp_token_kind` to point at the complete-context
      requirement.
- [ ] 1.4 Update the illustrative `PDPPIntrospectionResponse` TypeScript interface in
      Section 12 in lockstep with the new introspection response shape.
- [ ] 1.5 Add the authenticated-introspection-caller requirement (no bearer-only
      unauthenticated introspection) to `spec-core.md` Section 8 or Section 10.

## 2. DPoP Duty Split and private_key_jwt Citation

- [ ] 2.1 Add a DPoP duty-split note to `spec-core.md` Section 10 `### Token security`
      (informative): RS validates `htm`/`htu`/`iat`/`ath`/`nonce`/`jti` per RFC 9449
      §§4-7; introspection supplies `status`+`cnf` only; do not mandate DPoP as MTI in
      this pass.
- [ ] 2.2 Add the `private_key_jwt` citation fix (OIDC Core §9 + IANA
      client-authentication-method registry, not RFC 7523 alone) with pinned assertion
      audience/claims/registration mechanism, near `spec-core.md` Section 10
      Authentication material.
- [ ] 2.3 Resolve `presentation_proof` in any resolver/introspection contract
      description touched by this change: drop it or add the non-validation caveat.

## 3. Authorization-Code One-Time Use

- [ ] 3.1 Draft the OAuth-binding normative text for authorization-code one-time use in
      `spec-core.md` (new subsection; no existing text to supersede); explicitly state
      there is no same-DPoP-key idempotency carve-out.
- [ ] 3.2 Add or update the RS/AS error-code table entry for authorization-code reuse
      (`invalid_grant` or the binding's named equivalent) alongside the existing
      error-code conventions in `spec-core.md` Section 8/9.

## 4. Refresh-Token Rotation and Replay

- [ ] 4.1 Draft the refresh-token rotation-on-use, family-lineage, and closed
      replay-response enumeration text replacing the current single SHOULD-level
      sentence on refresh tokens in `spec-core.md` Section 10.
- [ ] 4.2 Enumerate the closed set of permitted replay responses with precise
      per-response effects as binding-declared metadata, not open-ended prose.
- [ ] 4.3 Define the refresh-endpoint retransmission rule (lost-response retry)
      distinct from replay-of-superseded-generation, giving the existing lost-response
      conformance test class an oracle.

## 5. Keyless Recovery

- [ ] 5.1 Draft the new key-recovery subsection in `spec-core.md` Section 10, after
      Token security and before Grant integrity: rotation-with-old-key vs.
      keyless-recovery vs. public-client non-self-qualification.
- [ ] 5.2 Cross-check the keyless-recovery text against the prior design discussion's
      credential-family lifecycle state transitions so the new rule composes with (does
      not contradict) the existing state-machine language.
- [ ] 5.3 Add negative-test placeholders/pointers for: authorization-code reuse denial,
      refresh-replay enumerated response assertion, refresh-retransmission oracle, and
      keyless-recovery rejection absent old-key proof/fresh authorization/suspend+owner-
      recovery.

## 6. Minimum Credential-Security-Profile Floor

- [ ] 6.1 Add a `minimum_credential_security_profile`-equivalent manifest field to the
      Section 7 Manifest fields table, scoped at the manifest/source level (not
      per-stream), documenting that absence means no floor and bearer presentation
      remains acceptable.
- [ ] 6.2 Add a new normative subsection under Section 10, Security and Privacy
      Considerations (after Trust boundary responsibilities, before Data minimization)
      stating: (a) the AS MUST refuse to issue below a declared floor, (b) the RS MUST
      reject a resolved context below its source's declared floor, (c) consent
      disclosure of a reduced-theft-resistance presentation mode is MUST-level when such
      a mode is permitted for the source.
- [ ] 6.3 Cross-link the new Section 10 subsection to the existing Sender-constrained
      tokens informative note and to the Trust boundary responsibilities table,
      clarifying that this requirement upgrades the refusal/rejection obligation to
      MUST while leaving concrete binding-specific profile identifiers to the OAuth
      binding document (deferred).
- [ ] 6.4 Update the Authorization Server conformance and Resource Server conformance
      sections (Section 9) to reference the new floor-refusal and floor-rejection
      obligations as conformance items.
- [ ] 6.5 Add negative conformance/test cases: AS rejects below-floor authorization
      request; RS rejects below-floor resolved context; consent surface renders the
      reduced-theft-resistance disclosure before completing issuance of a permitted
      weaker mode.
- [ ] 6.6 Verify no OAuth-binding-specific profile identifier (e.g. a DPoP-only or
      bearer-compat label string) is minted in this delta; confirm the mechanism is
      described in binding-neutral terms only.

## 7. PDPP OAuth 0.1 Migration Profile

- [ ] 7.1 Define the `legacy_0_1` authorization-context discriminator and its
      field-availability contract (issuer/audience/proof-mode/binding-security-profile/
      source-digest marked unavailable; client/subject/source/grant-ID-digest/state/
      cache-freshness still enforced) in the new PDPP OAuth 0.1 Migration Profile
      document.
- [ ] 7.2 Specify the dual-mode RS algorithm: path selection solely from the resolved
      context's discriminated kind, never from token syntax or headers; both paths
      enforce the same per-grant constraint narrowing.
- [ ] 7.3 Define the discovery flag (naming convention consistent with existing
      `pdpp_*_supported`-style fields) signalling active legacy acceptance and the
      associated sunset boundary, and specify absence/false as "off."
- [ ] 7.4 Define the operator-controlled disable/sunset mechanism, including its
      interaction with null-expiry continuous grants and non-rotating legacy refresh
      tokens, and the immutability of historical grant bytes after disabling.
- [ ] 7.5 Define legacy refresh-token treatment: legacy/bearer-profile-only processing,
      no silent reclassification to sender-constrained mode, no silent upgrade, and
      rejection once legacy acceptance is disabled.
- [ ] 7.6 Extend the migration inventory to explicitly name rules for owner device-flow
      tokens, null-expiry continuous-grant client access tokens, legacy refresh tokens,
      and extension token kinds, citing the credential inventory's file:line evidence
      per kind.
- [ ] 7.7 Specify the fully determined expected result for the required
      backward-compatibility conformance test (byte-identical v0.1 grants; legacy
      context marks missing fields; rejection under common-algorithm fail-closed
      handling; rejection after legacy acceptance is disabled; no sender-constrained-
      profile claim).
- [ ] 7.8 Cross-reference the new Migration Profile from `spec-core.md`'s version-
      layering table (Section 6) and out-of-scope table (Section 11), without
      introducing v0.2 version labels or `urn:pdpp:...:0.2` identifiers in `spec-core.md`
      itself.

## 8. Canonicalization Pins

- [ ] 8.1 Add a JSON Schema dialect declaration (`$schema`: draft 2020-12) requirement
      to `spec-core.md` Section 7 (Manifest Format), amending the `streams[].schema`
      field description to name the pinned dialect.
- [ ] 8.2 Add a canonical timestamp/duration profile subsection to `spec-core.md`
      Section 4 (Record Model) near the existing Timestamps subsection, pinning the
      Z-suffix / zero-or-three-fractional-digit rule and the calendar-designator
      duration rule, and cross-reference it from the retention `max_duration` field and
      the grant `issued_at`/`expires_at` fields.
- [ ] 8.3 Add a short normative note that this canonicalization pin is a prerequisite
      for any future grant-digest computation, without defining grant-digest computation
      itself (that remains deferred/decomposition scope).

## 9. Seam-Spike Gate

- [ ] 9.1 Write the repaired seam-spike protocol as a standalone planning document
      (sibling to the existing decision-record documents), capturing the 13-vector
      corpus, the independence definition, the GNAP pass/fail criteria, and the single
      cross-referenced experiment definition — this is a planning/gating artifact, not
      spec-`*.md` prose.
- [ ] 9.2 Add the single gating statement (Core/binding decomposition and nine 0.2
      common schemas are not settled, deferred pending the spike) to this proposal, and
      consider a short cross-reference note in `spec-core.md`'s introduction alongside
      its existing companion-document references, without inlining decomposition
      content itself.
- [ ] 9.3 Reconcile the prior design discussion's three separate experiment-definition
      statements into the one seam-spike document produced above; update the other two
      locations, as later non-PR1 editorial work, to cross-reference it.

## 10. Labeling and Validation

- [ ] 10.1 Confirm every requirement in `specs/pdpp-authorization-hardening/spec.md`
      carries exactly one of the three approved change-class labels
      (`formalizes an existing v0.1 semantic requirement`,
      `repairs an existing interoperability/security hole`,
      `introduces a genuinely new normative capability`).
- [ ] 10.2 Confirm every requirement has at least one `#### Scenario:` block.
- [ ] 10.3 Confirm no requirement asserts a fact about any live deployment and no
      requirement mints a `"0.2"` version label or `urn:pdpp:...:0.2` identifier.
- [ ] 10.4 Run `openspec validate harden-pdpp-authorization-and-0-1-migration --strict`.
- [ ] 10.5 Run `openspec validate --all --strict`.
