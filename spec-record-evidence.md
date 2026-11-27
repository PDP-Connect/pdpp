# PDPP Record Evidence (draft)

Status: Draft for discussion. Not normative. Do not implement. Discussion: [#358](https://github.com/PDP-Connect/pdpp/issues/358).
Date: 2026-09-25

---

## 1. Introduction

This document defines how a PDPP record can carry evidence of its origin and integrity, so that a recipient can verify the record later without contacting the resource server that served it.

It has two parts. Section 5 describes a small change to Core that every implementation handles, even one that never produces evidence. Sections 6 to 8 describe proof mechanisms, which an implementation supports optionally and which would form a separate profile. Core carries typed evidence and does not choose a mechanism; the recipient's policy decides which evidence is sufficient, as in the split between evidence and appraisal in [RFC 9334](https://www.rfc-editor.org/rfc/rfc9334.html).

## 2. Evidence covers origin and integrity only

Evidence in this profile addresses the origin and integrity of a record, and it states what it does not prove, so that a recipient does not infer more than the evidence supports.

| Property | Question | Status in this draft |
|---|---|---|
| Origin | Who produced this record? | In scope |
| Integrity | Did anyone change it after that? | In scope |
| Subject binding | Is this record about the person it claims to describe? | Open |
| Freshness | Is this the current value? | Out of scope. Freshness has several clocks: source time, collection time, and emission time. |
| Completeness | Are records missing from this set? | Out of scope. See the separate coverage work. |
| Truth | Is the content correct? | Out of scope. No signature proves this. |

## 3. Three attesters make three different claims

Three parties can attest to a record, and each makes a different claim.

| Role | Claim | Example |
|---|---|---|
| Source | "We hold this record and issued these values." | A government agency, or a platform that serves its own data (`source.kind: provider_native`) |
| Collector | "Our runtime received these values from the source at this time." | A connector runtime that collects from a source that does not sign |
| Resource server | "We served these bytes." | The resource server that answered the request |

A collector claim depends on trust in the collector, so evidence must label it as a collector claim and never present it as a source claim. This keeps the separation that Core already makes between `connector` and `provider_native` sources.

## 4. Five Core properties rule out whole-record signatures alone

Five properties of PDPP rule out a design that only signs each whole record.

1. **Field projection.** A grant can remove fields from a record, and a signature over the whole record does not verify after projection. Mechanisms that support disclosure of individual fields avoid this, and Core's projection of top-level fields only matches the per-claim disclosure of SD-JWT. [SMART Health Cards](https://spec.smarthealth.cards/) met the same need by issuing several smaller signed cards.
2. **Normalization.** When a connector changes a source's data to fit a stream schema, the source's signature no longer covers the result. The normalized record needs its own attester, with a link to the original evidence where one exists.
3. **Linkability.** Two clients that receive the same signature or the same digests can use them to link one person across their records, which defeats per-client subject identifiers. Some mechanisms produce proofs that cannot be linked, at a higher implementation cost.
4. **Mutable records.** Because a `mutable_state` record changes over time, evidence must identify the version it covers, and tombstones need their own rule.
5. **Derived results.** The signatures on input records do not cover a summary or search result computed from them. A derived result needs its own attestation and a reference to its inputs, as [C2PA](https://spec.c2pa.org/) does with "ingredients".

## 5. Proposed evidence item and Core hook

A record can carry zero or more evidence items, each with the parts below. All names are placeholders.

| Part | Content |
|---|---|
| `type` | URI that identifies the mechanism, for example a detached JWS or an SD-JWT |
| `attester` | Role (`source`, `collector`, or `resource_server`) and an identifier |
| `covers` | Record key, record version, and the fields that the evidence covers |
| `verification` | Reference to the verification key, for example a `kid` in a published key set |
| `proof` | Mechanism-specific content |

The Core change that this needs has two parts. First, the RECORD envelope accepts an optional evidence member, which an implementation without support ignores. Second, a resource server delivers only evidence that verifies against the data it disclosed: when projection removes covered fields, the server either delivers evidence that supports field disclosure or omits the evidence.

## 6. Candidate mechanisms and their limits

| Mechanism | Fits | Limits |
|---|---|---|
| Detached JWS over the exact record bytes | Whole records that are delivered without projection | Fails after projection. Reused signatures are linkable. |
| SD-JWT ([RFC 9901](https://www.rfc-editor.org/rfc/rfc9901.html)) | Source-signed records with top-level field disclosure | Disclosed digests are linkable unless the issuer issues a separate copy for each recipient |
| BBS ([W3C VC Data Integrity BBS](https://www.w3.org/TR/vc-di-bbs/)) | Field disclosure with proofs that cannot be linked | Less deployed; more complex cryptography |
| Signed manifest over a set of records (hash list or Merkle root) | One export or batch of records | Shows membership in the signed set, not the completeness of the source |
| TLS provenance (for example [TLSNotary](https://github.com/tlsnotary/tlsn)) | Collector evidence when the source does not sign | Not production-ready, per the project itself |

## 7. Use cases

A mechanism choice must give a clear result for each use case.

| # | Use case | Expected result |
|---|---|---|
| 1 | A government agency signs a record with five fields. The grant discloses two. | Needs per-field disclosure (SD-JWT or BBS). |
| 2 | A connector collects bank transactions from a site that does not sign. | Only collector evidence is possible. The label must make the weaker claim clear. |
| 3 | Two clients receive the same source-signed record. | SD-JWT digests are linkable. The answer needs per-recipient issuance or BBS. Open. |
| 4 | A client receives a summary computed from signed records. | Input signatures do not transfer. Needs its own attestation and input references. Deferred. |
| 5 | A recipient verifies an exported record offline. | Works for use case 1 records when the verifier already holds the source's key. Key discovery and rotation are open. |

## 8. Open issues

- How does a verifier find and trust an attester's key? Options include a key set published at the source's URI, `did:web`, and a trust registry answer. Rotation and revocation of keys need a rule.
- Which record version does evidence cover in a `mutable_state` stream, and how does evidence apply to tombstones?
- Is a resource-server signature useful enough to define, given that it only moves trust from a live server to the server's key?
- Does subject binding belong in this profile or in identity work?
- What is the smallest first version? One candidate is source-signed SD-JWT records only.
