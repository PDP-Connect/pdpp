## Why

`spec-core.md` Section 8's separated-RS introspection contract omits facts its own
grant-enforcement algorithm requires. The current extension-fields table (`active`,
`pdpp_token_kind`, `subject_id`, `grant_id`, `client_id`, `exp`) does not carry issuer,
exact audience, presentation/proof mode, security-profile provenance, or the projected
streams/fields/time_range/resources the enforcement steps in the same section already
assume the RS has. A resource server in a separated AS/RS deployment cannot run PDPP's
own enforcement algorithm from what introspection is specified to return today. This is
a context hole, not a hypothetical one: Section 8's steps 3-4 reference constraints the
current response table never supplies.

Alongside the context hole, PDPP's credential lifecycle has three normative gaps: no
stated rule against authorization-code reuse, an open-ended ("or equivalent response")
refresh-replay clause that two conformant implementations could satisfy in materially
different ways, and no rule distinguishing key rotation (old key held) from key recovery
(old key lost) for a continuous credential family. None of these are edge cases; each is
a live decision an implementer must make today with no normative guidance.

Finally, PDPP v0.1 has no migration profile. `legacy_0_1` authorization contexts are
referenced in prior design discussion as marking issuer, audience, proof-mode, and
source-digest fields "unavailable," but no text reconciles that with the fail-closed,
complete-context enforcement algorithm this change also hardens. Without a migration
profile, an implementer upgrading a resource server has no defined outcome for a
pre-existing v0.1 grant.

This change hardens PDPP's authorization/credential rules and defines that v0.1
migration profile. It deliberately does **not** settle the three-document Core/binding
decomposition (`spec-core.md` / `spec-oauth-binding.md` / `spec-owner-profile.md`) or
the nine closed 0.2 common schemas as normative text. Those remain provisional pending a
seam-spike experiment that has not yet run; publishing them now would make that
experiment's fallback option fictional. This change is scoped to the requirements that
hold regardless of the seam-spike's outcome.

## What Changes

- Require a complete, authenticated authorization context from separated-RS
  introspection: the RFC 9396 `authorization_details` carrier for the approved
  selection, plus a minimal `pdpp` supplementary member for grant identity, lifecycle
  state, and security profile. Prohibit unauthenticated introspection callers.
- Split DPoP proof-validation duties between the resource server (request-specific
  proof: `htm`/`htu`/`iat`/`ath`/`nonce`/`jti`) and the introspection response
  (`status` + `cnf` only), and correct the `private_key_jwt` citation to OpenID Connect
  Core plus the IANA client-authentication-method registry.
- Require authorization codes to be single-use with no idempotency carve-out, including
  no same-DPoP-key exception for retransmission.
- Replace the open-ended refresh-replay response clause with a closed, discoverable
  enumeration of permitted responses, and define the refresh-retransmission-after-lost-
  response case.
- Define a keyless-recovery rule for continuous credential families: old-key rotation
  proceeds under existing conditions; recovery without the old key requires fresh
  authorization or a suspend-and-owner-authenticated-recovery path; a public client
  cannot self-qualify using only the lost key.
- Add a normative minimum credential-security-profile floor a source can declare, with
  mandatory AS refusal and RS rejection below the floor, and mandatory (not optional)
  consent disclosure of a permitted weaker presentation mode.
- Define a normative PDPP OAuth 0.1 Migration Profile: dual-mode RS enforcement for
  `legacy_0_1` contexts, a discovery flag signaling legacy acceptance, an
  operator-controlled disable/sunset mechanism, legacy refresh-token treatment, and a
  migration inventory naming every live credential kind.
- Pin one JSON Schema dialect and one canonical timestamp/duration string profile for
  schemas and objects that a conformant implementation validates or canonicalizes.
- State, as a single gating fact, that the Core/binding decomposition and the nine 0.2
  common schemas are not settled normative text and remain deferred pending a seam-spike
  experiment; specify the corpus, independence definition, and pass/fail criteria that
  govern that gate.

## Capabilities

### New Capabilities

- `pdpp-authorization-hardening` — the authorization-context completeness, credential-
  lifecycle, security-floor, and 0.1-migration requirements introduced by this change.

### Modified Capabilities

- None. This proposal does not modify any existing OpenSpec capability spec.

### Removed Capabilities

- None.

## Impact

- This is a specification-only change. It adds one new OpenSpec capability
  (`pdpp-authorization-hardening`) and does not edit any root `spec-*.md` file. Root
  spec edits (`spec-core.md` Sections 7-10 and 12, and a new migration-profile
  document) follow in a subsequent change after this proposal is accepted, per this
  repository's convention of proposing before editing root specs.
- Out of scope, deferred to a subsequent change gated on the seam-spike's outcome: the
  Core/binding document decomposition, the nine closed 0.2 common schemas, the
  multidimensional requester-identity structure, the canonical grant digest algorithm,
  any normative GNAP binding, final DPoP mandatory-to-implement status, the full
  conformance-claim label taxonomy, and public URN minting.
