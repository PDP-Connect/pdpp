# PDPP Consent Artifacts: Persistence, Sharing, and Relationship to OAuth — Analytical Brief

**Date:** 2026-06-23
**Status:** Neutral assessment brief. Describes the question, the evidence gathered, the current specification state, and open issues. No recommendation is made.
**Audience:** External reviewer assessing the design question on its merits.

---

## 1. The question

In a review of the PDPP whitepaper / Lab proposal, an external reviewer (a systems/security academic) raised the following, paraphrased:

> Traditional OAuth2 usually has no need to store a token for a long period. The PDPP material, however, appears to anticipate scenarios in which a user — or an application acting on a user's behalf — would want to **share a user's PDPP consent artifacts with other users or applications**. What are concrete examples of such scenarios? PDPP describes data transfers as "auditable," so perhaps persistent audit trails are one reason the consent artifacts are not ephemeral.

The question bundles three separable sub-questions:

- **(A) Persistence.** Why are PDPP consent artifacts ("grants") durable rather than ephemeral?
- **(B) Sharing.** What scenario justifies sharing a grant with another user or application?
- **(C) Storage location.** Where does a durable grant live, and does PDPP still function if the user alone stores it? *(Out of scope for this brief; noted for completeness.)*

The reviewer's "sharing" framing is his own inference from the artifact's stated properties (immutable, cryptographically bound, auditable); the Lab proposal does not itself describe a sharing scenario. A text search of the proposal found no occurrence of "delegate," "transfer" (of a grant), "on behalf," "third party," or "shared" in the sense of sharing a consent artifact.

---

## 2. Terminology

- **OAuth 2.0 grant state:** the authorization server's private, server-side record that a client holds a given scope for a given user. Backs refresh tokens; read via token introspection (RFC 7662). Implementation-internal; content is a coarse scope string; mutable.
- **PDPP grant:** PDPP's consent artifact. A structured, normative object recording what a user authorized — streams, fields, purpose, access mode, expiry. The spec calls the grant "the consent artifact" and "the portable core of PDPP."
- **Access token vs. grant:** PDPP access tokens are RFC 6750 bearer tokens bound to a specific grant. The token is the access credential; the grant is the consent record. (spec-auth-design.md L29; spec-core.md L1311.)

---

## 3. What the PDPP specification currently states (verified against `spec-core.md`)

Grant fields are normative (§6, "Grant fields"). Relevant fields:

| Field | Note (verbatim / paraphrased from spec) |
|---|---|
| `access_mode` | enum, protocol-enforced: `single_use` or `continuous`. (L532) |
| `streams` | StreamGrant[]; always expanded, no wildcards. (L533) |
| `purpose_code` | URI, machine-readable purpose. (L530) |
| `expires_at` | ISO 8601 or null; null means no expiry. (L536) |
| `retention` | Policy commitment by the recipient; not technically enforced by PDPP. (L535, L606) |

Lifecycle and enforcement provisions:

- **Standing authorization.** "Grants freeze stream names at consent time. Within a granted stream, future records are included for `continuous` grants (subject to `time_range` constraints)." (L594)
- **Immutability / no in-place change.** "Grant narrowing (reducing the scope of an existing grant) is not supported in v0.1. Scope reduction is achieved via revoke-and-reissue." (L598) Grants are bound to the resolved field set at issuance; view evolution never silently widens an existing grant; re-consent is required for new fields. (L872)
- **Revocation.** "Revocation stops future access only. Records already delivered to the client before revocation are governed by the grant's `retention` policy and applicable legal obligations. PDPP does not retroactively reach into client-side data stores." (L602)
- **Retention parallel to OAuth.** "This is consistent with how OAuth 2.0 treats scope compliance: the protocol makes the commitment legible and machine-readable; external mechanisms enforce it." (L606)
- **Binding to client.** A grant identifies a client by `client_id` (L65). The spec defines no mechanism to transfer, delegate, or reassign a grant to another party. The spec is silent on transferability — it neither provides a mechanism nor states a prohibition.
- **Enforcement substrate.** Access tokens are bound to specific grants and carry PDPP introspection extension fields (L1311). Positive introspection results MUST NOT be cached longer than `min(token_exp, 60s)`; self-contained JWTs are allowed as an optimization but MUST NOT be the sole revocation mechanism (L925).
- **Foundation.** Built on OAuth 2.0 + RFC 9396 (Rich Authorization Requests). A comparison note flags GNAP (RFC 9635) as a candidate foundation for a future version (key-bound grants, built-in grant management) — marked "TODO for v0.2." (L51)

---

## 4. Sub-question A — why grants are durable

Four candidate justifications were identified. They divide into two structural reasons (mechanism-driven, domain-independent) and two institutional reasons (regulatory / high-stakes, context-dependent).

**Structural (hold in any deployment):**

1. **Enforcement of standing access.** A `continuous` grant authorizes ongoing reads. The resource server must check each future request against what was authorized; this requires the grant to persist. This is a property of standing authorization, not of PDPP specifically — OAuth's own grant state persists for the same reason. A `single_use` grant is the ephemeral case (consumed at first token issuance).
2. **User management.** A user who has issued many grants across many sources and clients needs a durable, inspectable set of grant records to review and revoke them. PDPP's multi-source / multi-client scope makes this more salient than in single-institution contexts.

**Institutional (deployment-dependent):**

3. **Legal "demonstrate consent."** GDPR Art. 7(1): a controller "shall be able to demonstrate that the data subject has consented." This is a retrospective evidentiary obligation that an ephemeral credential cannot satisfy. PDPP is not itself a regulated party; the durable grant is a capability that lets regulated *adopters* satisfy such obligations, not a mandate PDPP is under.
4. **Audit / dispute resolution.** An immutable record of what was authorized supports resolving "I never authorized that" disputes and third-party verification. Value is real where institutional counterparties exist; may be unused in lightweight deployments.

**Distinction surfaced during analysis (relevant to assessment):** persistence and enforcement are *not* novel to PDPP — OAuth persists grant state and enforces it per request. The distinguishing properties of the PDPP grant are (i) **resolution** (field/stream/purpose level vs. coarse scope string), (ii) **standardization** (a defined, interoperable object vs. implementation-internal state), and (iii) **inspectability / tamper-evidence** (immutable, designed to be read vs. mutable internal state). The grant's *richness*, not its persistence, is the differentiator; durability follows independently from standing access.

---

## 5. Sub-question B — sharing a consent artifact

Two readings, with different risk profiles:

- **Artifact as record** (present the grant as proof of what was authorized; recipient gains no data access). Consistent with the artifact's immutable/auditable design and with the client-bound model. No new access conferred.
- **Artifact as credential** (hand the grant to another party so they can access the data). This is delegation/transfer of access. Not defined in v0.1; raises scoping, revocation, and accountability questions. Inconsistent with the current `client_id`-bound model absent a new mechanism.

Candidate scenarios, assessed:

| # | Scenario | Reading | Notes on strength |
|---|---|---|---|
| 1 | **Delegation of a scoped subset to another person** (e.g., user grants a derived, narrowed slice to an accountant or assistant, revocable by the user). | Credential | The only scenario literally matching "share with other **users**." Concrete, everyday need. **Requires delegation, which v0.1 does not define** (grants are client-bound; no transfer mechanism). Best fit to the reviewer's wording but explicitly a deferred extension. |
| 2 | **Proof of authorization without access** (user/agent presents the immutable grant to an auditor, regulator, or own dashboard to show what was authorized). | Record | Safe; matches artifact design; precedented (FHIR Consent, GDPR Art. 7). **Caveat:** in practice the party compelled to demonstrate consent is usually the *controller*, not the user; the "user presents to auditor" framing is often inverted. v0.1 does not specify a present/verify-grant flow. |
| 3 | **Cross-party consent reconciliation** (an agent or consent-manager reads the set of grants to detect redundancy/over-broad access or drive bulk revocation). | Record | Single-user; "sharing" is loose (reading one's own grant set). Useful for management; not a between-parties scenario. |
| 4 | **Trust/diligence signaling between apps** (an app presents a grant as proof it holds legitimate scoped authorization before a downstream party interoperates). | Record | Plausible; depends on an ecosystem of parties that check such proofs. Not defined in v0.1. |

Observation: the scenario that best matches the reviewer's literal wording (other **users**) is #1 (delegation), which is precisely the capability v0.1 declines to define. The scenarios that are safe and v0.1-consistent (#2–#4) are "share as record," and most are single-user or institutional rather than user-to-user.

---

## 6. Relationship to OAuth 2.0 (as relevant to A and B)

- OAuth 2.0 persists authorization state and enforces it on every request; PDPP reuses this. The claim "OAuth cannot persist/enforce" is not accurate.
- OAuth's default authorization content is a coarse, provider-specific scope string. RFC 9396 (Rich Authorization Requests) provides a structured `authorization_details` envelope but leaves the *content* to domain profiles. PDPP defines that content for personal data (record model, field selection, purpose, enforcement rules).
- Precedent for the pattern "OAuth for access + a separate, durable, standardized consent object": SMART on FHIR (the FHIR `Consent` resource, with lifecycle `status` and designed for indexing/retrieval); UK Open Banking (an `account-access-consent` resource with its own create/status/delete lifecycle, distinct from short-lived access tokens, plus a mandated consent dashboard); Australia's Consumer Data Right (consent records with revoked-consent states). In each case the consent object was standardized within a regulated vertical.
- Open question of fact (not resolved here): horizontal (cross-domain) standardized consent artifacts do not currently exist. Whether this is because the need is real but unmet for incentive/coordination reasons (OAuth deliberately scoped consent semantics out; platforms lack incentive to make consent portable; no neutral body wrote a general profile), or because demand outside regulated verticals is weak, is itself a matter for assessment.

---

## 7. Open issues for assessment

1. **Is the persistence justification primarily structural or institutional?** If structural (enforcement of standing access) is accepted as sufficient, the durability claim does not depend on the contested audit-value claim.
2. **`single_use` retention.** A `single_use` grant is consumed at first token issuance; enforcement no longer needs it afterward. The spec does not state whether a consumed `single_use` grant is deleted or retained as a record. Retaining it implies weighting the audit/record rationale; deleting it implies weighting minimization. Currently unspecified.
3. **Transferability.** The grant is `client_id`-bound with no transfer/delegation mechanism, and tokens are bearer (RFC 6750). The spec neither defines transfer nor explicitly prohibits it. Whether to state an explicit non-transferability boundary, or to define a delegation mechanism (cf. scenario #1), is open. Note the GNAP comparison flags key-bound grants and built-in grant management as a v0.2 consideration.
4. **Present/verify-grant flow.** Scenarios #2 and #4 (sharing as record) presuppose a way to present a grant to a third party and verify its integrity. v0.1 defines the grant as a structured object but does not specify a disclosure/verification flow.
5. **Demand thesis.** The case for a horizontal consent artifact rests partly on a forward-looking claim that AI agents acting on users' behalf constitute a new demand-side actor able to consume a standardized consent layer. This is a thesis about future adoption, not a present-state fact.

---

## 8. Sources consulted

- PDPP `spec-core.md` (grant fields, standing authorization, grant narrowing, revocation, retention, enforcement/introspection, OAuth/RAR/GNAP comparison) — line references inline above.
- PDPP `spec-auth-design.md` (bearer tokens at both boundaries; access tokens bound to grant; RFC 6750).
- PDPP Lab proposal (`17jHAJ3…`) — consent-artifact and "auditable" language; OAuth 2.0 + RFC 9396 foundation statement.
- HL7 FHIR `Consent` resource (build.fhir.org/consent.html; fhir.hl7.org R5) — lifecycle `status`; "indexing, searching, and retrieval"; Security Work Group ownership.
- UK Open Banking AISP Account Access Consents (openbankinguk.github.io) and consent dashboard guidance (standards.openbanking.org.uk); Nordea Open Banking FAQ (consent duration vs. access-token validity) — note: the specific duration figures were read from a search snippet and were not confirmed against a fully rendered source.
- GDPR Art. 7(1) (gdpr-info.eu) and UK ICO guidance on recording consent.
- Data Transfer Project / DTI documentation (dtinit.org) — for the separate DTI/PDPP boundary discussion (not central to this brief).
