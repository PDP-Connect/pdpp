# PDPP Write Profile (draft)

Status: Draft for discussion. Not normative. Do not implement. Not part of v0.1.
Date: 2026-09-30

---

## 1. Introduction

This document describes how PDPP could let a party other than the owner write records into the owner's store under its own grant.

Three cases motivate it:

| Case | Example | Today |
|---|---|---|
| Source push | A platform or a public body pushes its own users' data into each user's store, so the owner does not need to collect it again | No authorized way for a third party to write |
| App writes | A notes app writes records that it creates into the owner's store | Not expressible |
| Derivative writes | An app writes a result that it computed from records it read | The derived sources draft proposes a separate source with lineage |

Core defines no normative ingest path. Core Section 3 states that ingest and sync state are outside Core, and that a profile that defines an ingest or write interface also defines its endpoints and errors. No current normative document defines one. This draft sketches such a profile.

The draft relies on three Core extension points. A profile can define a token kind (Core Section 8, Token introspection). A profile can define an RFC 9396 authorization-details type with its own grant contract (Core Section 7). A profile can define a provenance class (Core Section 6, Source kinds).

This profile also needs the proposed Core rules for record evidence, response compatibility, and instance identity. It requires one Core revision that contains both those rules and the extension points above. Neither set alone supplies the contract.

All member names, URIs, and error codes below are placeholders.

## 2. Terms

| Term | Meaning |
|---|---|
| Writer | The authenticated client, identified by `client_id`, that sends a write. |
| Source authority | The declaration authority that the authorization server has accepted for a `source.id` (Core Section 5, Declaration acceptance). |
| Delegate | A party that the source authority has explicitly authorized to write under its source. |
| Designated collector | The party that the owner has chosen to collect data for a source, for example a connector runtime. It writes collected data in that role only. |
| Write grant | The owner's authorization for one writer to write into one source, its streams, and resolved instances, for a bounded lifetime. |

## 3. Write authorization

A write is a separate permission from a read. Every surveyed system that splits verbs grants write separately from read (Section 11).

The profile would define three things:

- A distinct RFC 9396 authorization-details type, for example `https://pdpp.dev/data-write`. It is not a variant of `data-access`.
- A token kind, for example `writer`, that introspection reports in `pdpp_token_kind`. A resource server that implements the profile lists the kind in `pdpp_token_kinds_supported`.
- A write endpoint on the resource server.

A server that does not implement the profile fails closed:

- Its authorization server rejects the unknown detail type (RFC 9396 Section 5).
- Its resource server treats the unknown token kind as unauthorized for all Core operations (Core Section 8, Token kind extensibility).

A write grant confers no read. A writer that must read records back asks for an ordinary Core `data-access` grant, which the owner approves separately. Write-only is the default.

## 4. The target rule

A write grant binds one authenticated writer to one `source.id`, its streams, and resolved instances. The authorization server would issue it only when the writer is one of these:

1. The source authority.
2. A delegate whose authorization the authorization server has verified, through an authenticated assertion from the accepted source authority or through explicit provisioning at the authorization server. The authorization binds the delegate `client_id`, the `source.id`, the permitted streams and operations, an expiry, and a revocation status. Without it, the authorization server denies the grant.
3. The owner's designated collector for that source.

A writer cannot place its own records in a source that another authority answers for. A wildcard write scope over another party's source, for example all streams of a chat service, is available only to that source's authority, its delegate, or the owner's collector.

An app that writes its own content, or content derived from records it read, onboards its own source, with its own declaration, streams, and schemas. It is then the authority for that source and writes there. Onboarding follows Core Section 5, Declaration acceptance, and stays separate from the write grant. A client cannot introduce a new source authority during authorization.

A designated collector writes collected data in the collector role only. Its writes cannot give records provider-native provenance.

**Provenance for source push.** Core binds `provider_native` to the protected-resource identifier of the provider's own resource server (Core Section 5, Declaration acceptance). A provider that pushes into a store that is not its own resource server cannot use that class. The profile would define a new provenance class for source push, for example `provider_push`. An authorization server recognizes it only when it implements the profile, and an implementation that does not recognize it does not read it as a known class (Core Section 6, Source kinds).

**Two authorizations for source push.** They are separate objects, not one bearer credential:

- Source acceptance. The authorization server accepts the declaration authority for the source, once, under its discovery and trust policy.
- The owner's write grant. It names the writer, the source, and the streams, and has a bounded lifetime.

Whether source acceptance needs a registry or relies on liability is authorization-server policy (Section 12).

## 5. Writer attribution

`source.id` names a data surface, not every writer. A collector and a delegate can both write under one source. So the resource server would do three things:

- It records the authenticated writer and the write grant on every write. It never takes them from the request body.
- It keeps the creator of each record and each later writer, not only the last one. Otherwise removal by writer fails after an overwrite.
- It shows this to readers in a profile-defined record member, for example `write_attribution`. Owner reads may show the full writer history. Client reads show only the attribution that the frozen read grant permits. A write that touches only fields hidden from the reader changes neither the visible attribution nor the record's `changes_since` eligibility (Core Section 4, Incremental sync).

```json
{
  "write_attribution": {
    "created_by": { "client_id": "https://notes.example/client", "grant_id": "wg_18c2" },
    "later_writers": [
      { "client_id": "https://sync.notes.example/client", "grant_id": "wg_2a90", "at": "2026-09-30T06:00:00Z" }
    ]
  }
}
```

A client that predates the profile does not know this member and does not read it. So the member cannot carry a safety guarantee alone. The guarantee comes from the target rule (Section 4). Only the source authority, its delegates, and the owner's collector write into a source. Those are the parties that a reader already trusts when it trusts the source. Admission to a source does not make every writer equally trusted, or its content safe (Section 10).

The stamp makes two owner operations possible:

- **Remove by writer.** The owner removes what one writer created, what it contributed, or both. The profile defines which of these it offers. Each removal is a tombstone (Section 6).
- **Per-writer quota.** The resource server limits the storage that one writer uses. Persistent quota exhaustion, an oversized request (413), and a temporary rate limit (429) are distinct errors. Quota accounting covers replacement, deletion, and grant renewal.

Neither operation was found in the reviewed platforms. Both are proposals.

## 6. Updates and deletes

- A writer other than the source authority may update or delete only records it created, addressed by `{instance_id, stream, key}`. A later contribution alone grants no right to delete the whole record. Broader contribution rights need an explicit grant rule.
- A response for a key that does not exist and a response for a key the writer did not create are indistinguishable, because a write grant confers no read.
- The source authority may manage all records in its source.
- A designated collector may delete records that it collects, as it does today.
- A delete is an ordinary tombstone in the `changes_since` feed (Core Section 4, Incremental sync).
- A write to an `append_only` stream only inserts (Core Section 4, Stream semantics). A repeated key changes neither the stored data nor its attribution. A writer cannot update or delete a record in such a stream. The owner's own delete operation still applies.

The profile may add an append-only grant, which permits inserts only, as Solid `Append` does. No surveyed consumer platform offers one (Section 12).

## 7. Write lifecycle

A profile token kind does not inherit Core's grant lifecycle. Core states that a profile defines its grant shape, its token response, and its introspection members, and that companion profiles define how their active work ends. The profile would define these obligations:

- **Grant shape.** The grant records the writer `client_id`, the `source.id` and its provenance class, the streams, the permitted operations, the resolved instances, and the expiry.
- **Binding before issuance.** The authorization server resolves the writer, source, stream, and instance bindings before the final approval surface, as Core requires for `data-access` details. It rejects an approval that has become stale.
- **Introspection context.** Introspection for the write token kind returns the complete binding. A separated resource server enforces from that response and makes no second authorization-server lookup (Core Section 8).
- **Continuity and refresh.** Core's access modes describe reads. The profile states whether a write grant can be continuous, and whether its tokens can belong to a refresh-token family.
- **Revocation.** Revocation stops future writes within Core's 60-second propagation bound (Core Section 10, Revocation). Each accepted write commits or fails. A request first authorized after the propagation bound fails. A response can be lost after a commit, and a revoked token may not retrieve a stored idempotency result. So the profile defines an authenticated, read-only outcome lookup that works after revocation. Without one, a writer may be unable to learn the result of an in-flight request. It erases nothing already written. Removal is a separate owner action (Section 5).

## 8. Payload signatures

An RS stamp and a source signature give different guarantees:

- An RS stamp shows that the resource server accepted a write under a credential. A reader must trust the resource server.
- A source signature lets a reader check the signed values itself, without trusting the resource server. Provider origin for the served record also needs a verified direct record binding, or a trusted composed mapping from the resource server to the reader's record context.

The profile would apply this policy:

- A source-push profile that promises verifiable provider origin must require a source signature on each pushed record.
- For ordinary app writes, where the resource server is inside the declared trust boundary, a signature is optional.

A signature would be carried as a record evidence item, with the attester role `source` or a profile-defined `writer`, under the evidence hook proposed for Core ([record evidence proposal](https://github.com/PDP-Connect/pdpp/issues/358)). The hook is necessary but not sufficient. The profile must also define:

- **Canonicalization.** The exact byte form that is signed.
- **Key-authority binding.** How a verifier knows that a key belongs to the source authority, for example by key discovery from the authority's origin.
- **Replay protection.** How a verifier detects a signed record copied into another store, source, or stream.
- **Retention.** How long the resource server keeps each signature and the key material needed to verify it.
- **Projection-compatible proofs.** A whole-record signature cannot accompany a filtered record without revealing the hidden fields. Selective-disclosure schemes could help. This draft does not choose one.

A `provider_push` provenance class alone does not attest every record, because a collector can also write under the source. The profile defines which projections can carry verifiable evidence, and what a reader does when valid evidence cannot be delivered.

## 9. Mechanics

- **Idempotency.** A request carries an `Idempotency-Key` header, separate from record identity. The resource server stores the full result and returns it for a retry with the same key. It rejects a request that reuses a key with a different payload.
- **Batches.** A batch returns one result for each record. One rejected record does not fail the others, because a batch can mix streams and operations.
- **Conditional writes.** A writer may send `If-Match` with a record version. On a mismatch, the resource server returns 412 and changes nothing.
- **Validation.** The resource server validates each record against the declared stream schema. It rejects a record whose `data` key fields disagree with its `key`, as Core already requires (Core Section 4, Record identity). Each operation is a Core RECORD envelope plus `stream` and `instance_id`: it carries `emitted_at`, and a delete carries every primary-key field in `data`.
- **Limits.** An oversized request fails with 413. A rate limit fails with 429 and `Retry-After`. Limits are deployment settings. A server may advertise them, as JMAP does in its session object.
- **Visibility.** Written records reach readers only through Core reads and `changes_since`, under a grant that covers them. There is no separate write feed.

A batch request and its result could look like this:

```http
POST /v1/writes
Authorization: Bearer wt_4f1c
Idempotency-Key: 5d0e2a
Content-Type: application/json

{ "operations": [
  { "op": "upsert", "stream": "notes", "instance_id": "notes-main", "key": "n1",
    "data": { "id": "n1", "text": "Call the bank" }, "emitted_at": "2026-09-30T09:00:00Z" },
  { "op": "delete", "stream": "notes", "instance_id": "notes-main", "key": "n0",
    "data": { "id": "n0" }, "emitted_at": "2026-09-30T09:00:01Z" }
] }
```

```json
{ "results": [
  { "key": "n1", "status": "committed", "version": "v7" },
  { "key": "n0", "status": "rejected", "error": { "code": "not_found_or_not_permitted" } }
] }
```

## 10. Readers and agents

Written content is untrusted input for any reading agent, whoever wrote it. Attribution tells a reader who wrote a record. It does not make the content safe (Core Section 10, Record content and automated agents).

- An MCP binding should return the source and the writer with each tool result. Hosts should keep tool results isolated from their instructions. This points to host practice and is not a protocol control.
- PDPP defines no prompt-injection defense. Defenses belong in the reading agent.
- The write controls in this draft limit who can write and how much, and let the owner remove what a writer wrote.

## 11. Prior art

| System | What it contributes |
|---|---|
| [Apple HealthKit](https://developer.apple.com/documentation/healthkit/hksourcerevision) | Separate share and read authorization. A platform-stamped source revision that an app cannot forge. An app deletes only objects that it saved. |
| [Android Health Connect](https://developer.android.com/reference/androidx/health/connect/client/records/metadata/DataOrigin) | Separate write and read permissions per data type. A platform-stamped `DataOrigin`. Delete confinement was not verified. |
| [SMART on FHIR scopes](https://hl7.org/fhir/smart-app-launch/scopes-and-launch-context.html) | Create, update, and delete scopes. Write access does not imply read access. Cross-app writes are left to server policy. |
| [FHIR Provenance](https://hl7.org/fhir/provenance.html) | An optional writer record per resource. `meta.source` is recommended, not required. |
| [Solid WAC](https://solidproject.org/TR/wac) | Write, Append, and Control modes. No concept of origin. |
| [Google Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth), [Dropbox](https://docs.dropboxapi.com/dropbox-api/docs/oauth), [CloudKit](https://developer.apple.com/icloud/cloudkit/) | Confinement by app-owned namespace, such as an app folder. `drive.file` is narrower than full access but also covers files the user picks. |
| [Stripe](https://docs.stripe.com/api/idempotent_requests), [IETF Idempotency-Key draft](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/) | A request-level idempotency key with the result cached and a payload mismatch rejected. The IETF draft expired unpublished. |
| [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html) | `If-Match` and 412 for conditional writes |
| [JMAP, RFC 8620](https://www.rfc-editor.org/rfc/rfc8620.html) | Per-item `/set` results. Limits advertised in the session object, with suggested minimums. |
| [FHIR batch and transaction](https://www.hl7.org/fhir/http.html) | Both batch models: per-entry results and all-or-nothing |
| [Microsoft Graph delta query](https://learn.microsoft.com/en-us/graph/delta-query-overview) | Deletes reported as `@removed` in the ordinary changes feed |
| [India Account Aggregator](https://sahamati.org.in/what-is-account-aggregator/), [SMART Health Cards](https://spec.smarthealth.cards/) | Signed payloads: provider-signed data with a signed consent artifact, and issuer signatures with key discovery and no pre-registration |
| [DTI Trust Registry](https://dtinit.org/trust), [EU Data Act](https://eur-lex.europa.eu/eli/reg/2023/2854/oj) | Recipient admission by registry, and the contrasting model of liability with verification no more than necessary |
| [OWASP LLM01](https://genai.owasp.org/llmrisk/llm01-prompt-injection/), [CaMeL](https://arxiv.org/abs/2503.18813), [Spotlighting](https://arxiv.org/abs/2403.14720) | Injection defense sits at the reading agent, not in the data source |

## 12. Open questions

- Should the profile add an append-only grant tier, which permits inserts but no update or delete? No surveyed consumer platform offers one.
- Should source acceptance for source push need a registry entry, as the DTI Trust Registry and India's regulated-recipient rule do? Or should it rely on liability, as the EU Data Act does, or be left to authorization-server policy? These recipient-vetting systems are an analogy for admitting source writers, not evidence of that practice.
- What is the unit of a per-writer quota: bytes, records, or both? How do replacement, tombstones, and grant renewal count against it?
- How does this write authorization compose with the lineage pointer of the derived sources draft?
- What portable assertion format should a source authority use to authorize a delegate?
