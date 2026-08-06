## Context

This change ("PR1") is the B-intersect-C-invariant subset of a larger architecture
decision under consideration for PDPP's authorization model (Stage 3 synthesis and
architecture decision, the red-team addendum, and the author's controlling response,
all dated 2026-08-04, in `local/refactor/`). That decision proposes decomposing the
specification into separate Core / OAuth-binding / owner-profile documents and closing
nine common 0.2 schemas. The author's controlling response accepts the direction but
rejects publishing that decomposition and those schemas as settled normative text before
a seam-spike experiment runs: doing so would make the experiment's own fallback option
(reverting to a less mechanism-separated design) fictional, since a failed experiment
would then require undoing already-published normative surfaces.

This change is scoped to the subset of hardening and migration requirements that hold
**regardless of that experiment's outcome** — the separated-RS authorization-context
hole, the credential-lifecycle gaps (authorization-code reuse, refresh replay, keyless
recovery), the credential-security floor, the 0.1 migration profile, and the two
canonicalization prerequisites the experiment itself depends on. It runs in parallel
with the seam-spike, not after it.

`spec-core.md` today has no OAuth-flow-mechanics text in its normative sections at all
(Sections 4-10) beyond a relationship-table mention and one informative note. This is
deliberate: Core is meant to stay binding-independent. Several requirements below are
therefore new normative text rather than edits to existing OAuth prose, and are phrased
as binding-neutral security invariants (e.g., "a credential exchange step SHALL be
one-time-use") rather than OAuth-specific phrasing, reserving fully OAuth-specific
mechanism text for a future OAuth-binding document.

## Goals / Non-Goals

**Goals:**

- Close the separated-RS authorization-context hole so an RS can run PDPP's own
  enforcement algorithm from what introspection is specified to return.
- Repair three credential-lifecycle gaps (authorization-code reuse, refresh-replay
  open-endedness, keyless recovery) with unconditional, testable rules.
- Give a source a normative way to declare and enforce a minimum credential-security
  floor, with mandatory disclosure of a permitted weaker mode.
- Deliver a normative v0.1 migration profile so an implementer upgrading an RS has a
  defined outcome for every live credential kind.
- Pin the two canonicalization prerequisites (JSON Schema dialect, timestamp/duration
  profile) the seam-spike and any future grant-digest computation depend on.
- State, once, that the Core/binding decomposition and closed 0.2 schemas remain gated
  on the seam-spike, replacing scattered and partially inconsistent statements of that
  gate.

**Non-Goals:**

- Deciding or drafting the three-document Core/binding decomposition.
- Closing any of the nine 0.2 common schemas (`PDPPSelection`, `PDPPApprovedSelection`,
  `PDPPRequesterIdentity`, `PDPPConsentEvidence`, `PDPPGrant`, `PDPPGrantState`,
  `PDPPCredentialFamily`, `PDPPAuthorizationContext`, `PDPPError`).
- Defining the multidimensional requester-identity structure or the canonical grant
  digest algorithm as fixed, cross-binding-stable objects — both are exactly what the
  seam-spike is meant to validate.
- Any normative GNAP binding or GNAP conformance label.
- Deciding DPoP's mandatory-to-implement status. This change specifies the DPoP duty
  split and the security-floor mechanism conditionally ("when a deployment uses DPoP",
  "when a source declares a floor") without deciding whether DPoP adoption itself is
  required.
- Minting `urn:pdpp:...:0.2` identifiers, a "v0.2" version label, or any part of the
  full conformance-claim label taxonomy. Those remain gated on unresolved registry
  governance.
- Editing any root `spec-*.md` file. This proposal is the OpenSpec change; root spec
  edits follow after acceptance.

## Key Decisions

### Change-class labeling: three labels, used consistently

Every requirement in this change carries exactly one of three labels, stated inline as
**Change class:** immediately before its scenarios:

- **formalizes an existing v0.1 semantic requirement** — restates an obligation v0.1
  already implied, without adding new enforceable surface.
- **repairs an existing interoperability/security hole** — closes a gap in already-
  presupposed or already-partially-specified behavior.
- **introduces a genuinely new normative capability** — adds normative surface with no
  v0.1 precedent.

This labeling exists so the change is honestly described as a bounded hardening and
migration change containing some genuinely new normative capability, not merely a
small extraction of already-existing structure. Every requirement in this change is
labeled either "repairs an existing interoperability/security hole" or "introduces a
genuinely new normative capability" (the credential-security floor's declaration
requirement and the two canonicalization pins); none is labeled "formalizes an existing
v0.1 semantic requirement," since v0.1 has no prior text on any of these questions to
formalize.

### The authorization context uses the standard RFC 9396 carrier, not a proprietary shadow copy

RFC 9396 §9.2 registers `authorization_details` as a top-level member of the RFC 7662
introspection response, and §14.3 profiles its IANA registration. The prior design
draft used essentially this shape but treated more of the introspection transport as
PDPP-proprietary than necessary, risking a second, competing schema for data RFC 9396
already carries.

This change requires the normalized, approved selection (the streams/fields/time_range/
resources projection a grant actually authorizes) to travel in `authorization_details`,
the same carrier already normative for the client's authorization request. A small,
separate `pdpp` supplementary member carries only what `authorization_details` cannot
express: immutable grant identity, grant lifecycle state, a consent-evidence reference,
and the security/binding profile in effect. The `pdpp` member is explicitly prohibited
from duplicating any field `authorization_details` already carries — a reviewer checking
for a shadow copy of streams/fields/time_range/resources should find none.

**Alternative considered:** a single PDPP-proprietary introspection response shape
carrying all context fields, avoiding a second reference into RFC 9396. Rejected: this
would mean PDPP defines its own transport for data an existing, IANA-registered OAuth
extension already carries, and gives two implementations no shared, standards-derived
contract to converge on for the RAR-carriable fields.

### Authorization-code reuse: no idempotency carve-out, of any kind

An earlier draft allowed a token-endpoint response to be idempotent for retransmission
"only if it can return the same credential value... an implementation optimization, not
an interoperability requirement." A subsequent review proposed narrowing that allowance
to same-DPoP-key retransmission only. The controlling author response rejects that
narrower carve-out outright: "Same-key proof does not repeal the authorization code's
one-use rule."

This change states the rule unconditionally: a redeemed authorization code denies any
second presentation with `invalid_grant` (or the binding's equivalent), independent of
whether the same DPoP-bound key is presented. Lost-response recovery, if a binding
chooses to support it, must be a separately named transaction-result or idempotency
extension bound to the original committed issuance — never a second code redemption.
This composes with the existing `single_use` atomic-consumption pattern (`spec-core.md`
line 596: the AS marks a credential consumed atomically with issuance) by extending the
same atomicity guarantee to the code-redemption step that precedes it.

**Alternative considered:** the same-DPoP-key idempotency carve-out. Rejected per the
controlling author response; including it would directly contradict the hard constraint
this change operates under.

### Refresh-replay responses: a closed enumeration, not an open clause

The prior "revoke the active family or trigger an explicitly documented equivalent
response" language fails a basic interoperability test: two conformant
implementations could respond to the same compromise signal in materially different
ways, and neither would be wrong. This change requires the permitted replay-response set
to be closed, metadata-declared, and discoverable, with each response's effects on the
credential family precisely defined, and requires conformance tests to assert each
declared response.

This change does not enumerate the specific named responses (e.g., a hypothetical
`revoke_family` vs. `revoke_family_and_require_reauthorization`) as fixed protocol
constants. Picking the exact response vocabulary is downstream drafting work once the
full OAuth-binding prose is written; inventing specific values here would add scope
beyond what any work item's acceptance criteria requires. What this change fixes is the
*shape* of the fix — closed, not open-ended — and the parallel requirement that
refresh-endpoint retransmission after a lost response has a defined outcome, distinct
from replay of an already-superseded generation.

### Keyless recovery: security-critical policy left unspecified, not a demonstrated bypass

A prior review characterized an undefined "AS policy event" key-replacement path as a
confirmed bypass. The controlling author response narrows this: it is "security-critical
recovery policy left unspecified," not an existing or demonstrated bypass. This change
follows the narrower, controlling framing throughout — the keyless-recovery requirement
states plainly that it identifies unspecified policy, not an exploited defect, and it
does not assert that any deployment has exercised an undefined recovery path.

The substantive rule has three parts, mapped directly from the author's three-bullet
formulation: (1) possession of the current key permits ordinary rotation under the
conditions already required for key/instance replacement; (2) recovery without the old
key requires either a fresh, user-facing authorization interaction, or suspension of
issuance followed by an owner-authenticated recovery process and owner notification with
a revocation window — no third path; (3) a public or unregistered client whose only
persistent authenticator was the lost key cannot self-qualify via its own
(re-)authentication. A fourth scenario closes a specific gap: entering a replay-detected
state does not suspend these requirements or license a policy-event bypass.

The mechanics of "owner-authenticated recovery process" (specific factors, channels) are
deliberately left undefined here — that is deployment/operational detail no work item's
acceptance criteria requires pinning at the protocol level, and pinning it would add
scope beyond what was requested.

### A minimum credential-security-profile floor is new normative surface

Prior design discussion presupposed a "minimum credential-security profile" as a grant
fact (a supersession trigger) without ever defining it as a declarable, enforceable
floor. Since `spec-core.md` and `spec-auth-design.md` have no defined term for a
security-profile floor today, the floor's *existence* as a declarable fact is genuinely
new normative surface (labeled "introduces a genuinely new normative capability"), while
the AS-refusal, RS-rejection, and mandatory-disclosure rules that follow from it repair
a real gap already implied by the presupposed grant fact (labeled "repairs an existing
interoperability/security hole").

The floor is a manifest-level (source-level) field, not a per-stream field: credential-
security posture is a property of the resource server guarding a source's data, not of
any individual stream's schema. The four resulting requirements are deliberately kept
separate — declaration, AS-refusal, RS-rejection, mandatory disclosure — because each is
independently testable and each obligates a different party (source author, AS, RS,
consent UI); collapsing them into one requirement would obscure who is obligated to do
what.

This change deliberately does not mint the binding-specific profile identifiers a future
OAuth binding would need (for example, a DPoP-only label or a bearer-compatibility-mode
label). The requirements are written in binding-neutral vocabulary ("presentation mode,"
"reduced theft-resistance," "sender-constrained" vs. "weaker mode") so the mechanism is
meaningful today under bearer-only presentation without deciding DPoP's
mandatory-to-implement status or minting a profile-identifier registry this change does
not own.

**Alternative considered:** leaving the floor as informative guidance (as the current
Section 10 "Sender-constrained tokens" note does) rather than a MUST-level mechanism.
Rejected: informative guidance gives a declaring source no enforceable guarantee, which
is exactly the gap the controlling author response calls "more than an editorial
correction."

### The 0.1 Migration Profile: named-weaker-mode acceptance, not silent or indefinite

Prior design discussion cited a "PDPP OAuth 0.1 Migration Profile" without ever
delivering it as a normative artifact, leaving an unresolved conflict between the
hardened, fail-closed common enforcement algorithm and a `legacy_0_1` context whose
issuer, audience, proof-mode, and source-digest fields are marked "unavailable — not
invented." Five candidate resolutions were on the table: reject outright; accept under
v0.1 bearer rules; accept only under a named weaker conformance mode; require operator
approval; or refuse after a stated date.

This change adopts "accept under a named, discriminated weaker mode (`legacy_0_1`),
bounded by an explicit discovery flag and an operator-controlled sunset." A pure
fail-closed default would strand every pre-existing v0.1 credential the moment an RS
adopts the hardened algorithm — an unacceptable side effect for a migration-ready
profile. Silent, indefinite acceptance is exactly the failure mode a discoverable
legacy-acceptance flag exists to prevent. Operator approval and a stated sunset date are
not alternatives to naming the mode; they are folded in as the disable/sunset mechanism,
since the requirement is for a bounded mechanism as one component of the profile, not a
competing top-level outcome.

A key structural move: the fields Section 15.9-style migration discussion marks
"unavailable — not invented" (issuer, exact audience, proof/binding mode, security
profile, source-declaration digest) are kept textually separate from fields already
present on a v0.1 grant today (client, subject, source, grant-ID/digest, lifecycle
state). This lets the profile state two clean, non-overlapping rules instead of a long
per-field table: unavailable-by-design fields are accepted without fabrication under
`legacy_0_1`; every other field keeps its existing fail-closed obligation, unchanged.

This change does not mint any `urn:pdpp:...:0.2` identifier or a `"0.2"` version string,
per the hard scope constraint. Where the profile needs to distinguish `legacy_0_1` from
everything else, it uses binding-neutral phrasing ("the current binding," "a context not
discriminated as `legacy_0_1`," "sender-constrained (key-bound) security profile")
rather than any specific profile-identifier string.

The migration inventory is extended beyond grants, bearer tokens, `manifest_version`,
and clients to explicitly name a rule for owner device-flow tokens, null-expiry
continuous-grant client access tokens, non-rotating legacy refresh tokens, and extension
token kinds (package-scoped tokens and similar) — every credential kind the credential
inventory confirms exists in the reference implementation. Every "current behavior"
claim in this change is grounded in that credential inventory's file:line evidence, not
in any assertion about a specific live deployment's grant counts or failure modes; this
change does not require, and does not perform, independent verification of any live
deployment's grant inventory.

**Alternative considered:** fail-closed by default for any context missing a
current-binding field. Rejected: this treats every pre-existing v0.1 grant as broken the
moment a hardened RS is deployed, which contradicts the goal of a migration-ready
profile.

**Alternative considered:** accept `legacy_0_1` contexts silently and indefinitely with
no discovery signal. Rejected: this is the specific failure mode ("silent,
indefinite acceptance") this change's discovery-flag requirement exists to close.

### Why the security floor mechanism ships without deciding DPoP MTI status

The credential-security-floor requirements (declaration, AS refusal, RS rejection,
disclosure) are written to apply *conditionally* — "when a source declares a floor,"
"when a deployment permits both a stronger and a weaker mode" — precisely so they do not
themselves decide whether any sender-constrained presentation mode is mandatory to
implement. A source may declare a floor today even though bearer-token presentation is
the only implemented presentation mode in the current reference, and may equally choose
not to declare one. This lets the floor mechanism (and the parallel DPoP duty-split
requirement) land now, while the separate question of whether DPoP adoption itself is
required for any class of deployment remains an experiment prerequisite deferred to the
decomposition gated on the seam-spike.

### DPoP duty split and private_key_jwt: precision fixes, not new adoption mandates

RFC 9449 §§4-7 already assign per-request DPoP proof validation (`htm`, `htu`, `iat`,
`ath`, replay/freshness via `nonce`/`jti`) to the resource server, validated against the
actual request. This change makes that division explicit rather than leaving it
implicit behind an unelaborated RFC 9449 citation, and names `ath` explicitly as a
validated claim (previously absent from any explicit list). The introspection response
is limited to supplying `status` and `cnf`; it does not itself validate a request-
specific proof, because the request-specific proof only exists at the point of the
concrete HTTP request, never at the introspection endpoint. Any resolver contract
signature carrying a `presentation_proof` parameter alongside the credential is
misleading under this duty split unless it is dropped, or retained with an explicit
statement that the resolver forwards it only for logging/diagnostic purposes.

`private_key_jwt` as the client-authentication method for an RS acting as an
introspection caller is attributed to OpenID Connect Core §9 (which defines the method
name and semantics) and the IANA OAuth client-authentication-method registry, not to RFC
7523 alone — RFC 7523 defines only the underlying JWT-bearer assertion mechanism, not
the named method. The profile for an RS using `private_key_jwt` pins the required
assertion audience, required claims, and the RS's credential-registration mechanism with
the AS, so two implementers cannot both claim conformance while producing
non-interoperable assertions.

### Canonicalization: pin string representation, not the digest algorithm

RFC 8785 (JSON Canonicalization Scheme) canonicalizes JSON structure but treats string
values as opaque: `...00Z` and `...00.000Z` represent the same instant but canonicalize
to different bytes. "Byte-identical digest" is undefined without pinning exactly one
timestamp string representation, and similarly for durations. This change pins both a
JSON Schema dialect (draft 2020-12 — chosen because nothing in the current spec commits
to an existing dialect, so there is no existing-behavior constraint to preserve, and
2020-12 has the broadest current tooling support) and a canonical timestamp/duration
string profile.

This change deliberately does **not** define grant-digest computation (which RFC 8785
application, which hash algorithm, which fields are excluded). That is explicitly
reserved for the decomposition gated on the seam-spike. This change adds only the
string-representation prerequisite that any future digest computation depends on.

The timestamp profile allows zero or exactly three fractional-second digits (not
mandating always-three) because the spec's own existing timestamp examples already use
a bare `Z` suffix with no fractional seconds; mandating always-three would be a larger
behavior change than the ambiguity requires. The duration profile does not mandate a
single calendar designator (always-days vs. always-months); it requires only that a
producer represent a given duration length consistently within one deployment, since
resolving `P90D` vs. `P3M` canonically would require a real calendar-arithmetic
normalization rule that is closer to the digest-computation surface this change
deliberately excludes.

### The seam-spike gate: one cross-referenced statement, not several inconsistent ones

Multiple locations in the prior design discussion describe the seam-spike experiment
with three subtly inconsistent framings (a one-adapter framing, a two-implementation
trigger, and a separate phase-sequencing statement). This change requires exactly one of
those locations to state the experiment definition normatively, with every other
reference cross-referencing it rather than restating a possibly-different definition.

The repaired protocol itself must: add a 13th corpus vector (a v0.1 grant served through
`legacy_0_1` by a current-binding RS, directly testing this change's migration profile
against the experiment); define "independent" for any two-implementation/two-AS/two-RS
threshold as a separate team or an off-the-shelf product, disallowing oracle
substitution (the same implementation or team serving as both the object under test and
its own evaluating oracle) for the commitment decision; and either give the GNAP adapter
leg real, binding pass/fail criteria (unambiguous partial-approval result, exactly-once
`single_use` behavior, full context resolution) or explicitly declare that leg
non-gating — a mapping-completeness report alone cannot be the GNAP leg's pass criterion
if that leg is declared gating. The seam-spike's first phase depends on the two
canonicalization pins above already being resolved.

This change states the gate itself as a normative requirement (the decomposition and
schemas are not settled, deferred pending the spike) but does not inline the spike's own
corpus/protocol write-up into spec text; that planning artifact belongs alongside the
existing decision-record documents, not in a normative capability spec.

## Acceptance Checks

1. Every requirement below has at least one **WHEN/THEN** scenario and exactly one
   **Change class:** line using one of the three approved labels.
2. No requirement asserts a fact about any live deployment (no `pdpp.vivid.fish` claims,
   no grant-inventory counts); every "current behavior" claim traces to the credential
   inventory's file:line evidence or to a named RFC/OIDC citation.
3. No requirement mints a `"0.2"` version label or a `urn:pdpp:...:0.2` identifier.
4. No requirement reintroduces a same-DPoP-key (or any other) idempotency carve-out for
   authorization-code reuse.
5. The `pdpp` supplementary introspection member carries no field already expressible in
   `authorization_details`.
6. The keyless-recovery requirement's prose states plainly that it identifies
   unspecified policy, not a demonstrated bypass.
7. The floor, DPoP-duty-split, and migration-profile requirements are each phrased
   conditionally ("when a source declares...", "when a deployment uses DPoP...", "when
   the OAuth binding supports refresh tokens...") and do not themselves decide DPoP's
   mandatory-to-implement status.
8. `openspec validate harden-pdpp-authorization-and-0-1-migration --strict` passes.

## Deferred to PR2 (gated on the seam spike)

The following remain out of scope for this change and are not settled normative text
until the seam-spike protocol defined in this change's `pdpp-authorization-hardening`
capability has run and passed:

- The three-document Core/binding decomposition (`spec-core.md` /
  `spec-oauth-binding.md` / `spec-owner-profile.md` split).
- The nine closed 0.2 common schemas (`PDPPSelection`, `PDPPApprovedSelection`,
  `PDPPRequesterIdentity`, `PDPPConsentEvidence`, `PDPPGrant`, `PDPPGrantState`,
  `PDPPCredentialFamily`, `PDPPAuthorizationContext`, `PDPPError`), each at 0.2.
- The multidimensional requester-identity structure (`protocol_client` /
  `accountable_entity` / `software_product` / assurance dimensions) and the canonical
  grant digest, as fixed, cross-binding-stable objects.
- Any normative GNAP binding or GNAP conformance label.
- Final DPoP mandatory-to-implement status.
- The full conformance-claim label taxonomy beyond what this change's migration profile
  and security fixes require.
- URN registries and public URN minting, pending unresolved registry-governance
  questions.
