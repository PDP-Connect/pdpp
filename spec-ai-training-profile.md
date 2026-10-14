# PDPP AI Training Profile

Status: Draft; not registered
Date: 2026-10-13

## 1. Scope, status, and conformance claim {#scope}

This profile defines self-expiring processing authority for artificial intelligence (AI) training under the reserved permission `https://pdpp.dev/processing/ai_training`. Its profile version is `0.1.0`. Its separate named conformance claim is **PDPP AI Training Profile 0.1.0**.

This is a normative draft for that claim, not an approved registration. Publication of this draft does not enable the permission. Until registration is publicly approved under Core [Processing permissions](spec-core#processing-permissions), every authorization server (AS) MUST treat the permission as unsupported. An AS MUST NOT advertise it or issue a grant carrying it before that approval. The OAuth binding MUST reject such a request with `invalid_authorization_details`, without substituting an ordinary grant.

A claiming implementation MUST satisfy applicable Core requirements and this profile's requirements for each role it performs. Its claim MUST identify the version, roles, AS issuer, covered training surfaces, and supported optional features. The client role includes its ingestion, transformations, queues, workers, and parties acting for it. A claim MUST NOT imply coverage of unlisted training surfaces.

Registration uses Core's Specification Required policy. The proposed registration is:

| Member | Value |
|---|---|
| Identifier | `https://pdpp.dev/processing/ai_training` |
| Operation | AI training as defined in Core [AI training](spec-core#ai-training) |
| Defining profile and version | PDPP AI Training Profile `0.1.0` |
| Status | Reserved and unsupported; registration not approved |
| Cessation tier | Self-expiring authority; at most 1 hour of real elapsed time, without message delivery |

Registry maintainers MUST bind an approved registration to one immutable published version, as Core requires. An AS MUST retain that version's authority and protections for every grant and subsequent lease renewal under the identifier. A different defining version needs a new permission identifier and fresh owner approval. Implementations MUST NOT treat a later draft, local extension, or purpose code as that approval.

**Registration test.** Learned parameters produced under valid authority can survive erasure and can retain or reveal owner data. Model outputs whose lineage has ended at the model can also survive; Section 3 defines that boundary. No other training result gains an erasure exclusion from this profile. Core's independently applicable erasure exclusions remain unchanged.

Training can run offline, including on disconnected workers and devices. The client MUST enforce cessation over the whole execution interval within 1 hour of a governing training grant ending or an acquisition-copy erasure taking effect. This bound MUST hold without delivery of a message to any recipient. Sections 4–8 define the signed authority, issuance ordering, acquisition checks, and worker enforcement that meet this test.

**Note (non-normative):** The distinctive combination is separate training consent, signed offline authority, acquisition-copy eligibility, and an owner-visible stop time. The hour is a PDPP protocol choice. It is not a legal grace period or proof that a recipient stopped.

## 2. Requirements language and terms {#terms}

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, MAY, and OPTIONAL are interpreted as described in BCP 14 (RFC 2119 and RFC 8174) only when capitalized. This document is normative except for notes, examples, and sections marked informative.

Core's actors, grants, PDPP data, held data, processing permissions, and erasure instructions retain their meanings. A **training grant** carries the AI training permission. An **acquisition grant** identifies the actual acquisition of an input copy. They can be the same grant.

A **lease** is an AS-signed processing credential that permits bounded training under a training grant. A **renewal credential** authenticates a public client's lease requests; it is not a lease. A **worker** executes training, including evaluation that selects a model. A **guard** is the worker or a trusted enforcement component that controls all its access to covered inputs and training steps.

A **lease-ending event** is a training grant ending or a lifecycle event that ends a covered acquisition copy's eligibility, including effective erasure. An ordinary acquisition grant's ending with eligible custody retained is not such an event. An advance erasure election alone is not a lease-ending event, although Core counts it among its broader terminal events ([Lifecycle durability](spec-core#lifecycle-durability)). All durations are real elapsed time, including suspension and power-off. A deadline includes queued and in-flight work.

## 3. Covered inputs and surviving results {#coverage}

The client MUST apply Core's [AI training definition](spec-core#ai-training) regardless of purpose label, model location, or training method. This includes fitting stored examples, fine-tuning, distillation, reinforcement learning, federated updates, and evaluation that selects a model, checkpoint, or configuration. Fixed-parameter inference, retrieval, embedding generation, and measurement that never informs selection retain Core's exclusions.

Before using an input, the client MUST establish valid authority for every contributing PDPP input. A training grant MUST cover each input's authenticated originating subject, source, stream, instance, fields, resources, and time constraint. Different grants MAY cover different contributors. Removing identifiers, aggregating, or declaring data anonymous MUST NOT remove this coverage requirement. An AS or resource server (RS) training on data it holds in that role MUST obtain authority as a client.

For earlier copies, the client MUST retain both the acquisition and training grant bindings. Later training approval MUST NOT change the original acquisition time, retention ceiling, erasure state, or custody eligibility. Relabeling or deduplicating a copy MUST NOT count as an independent acquisition.

Core's [learned-parameter exception](spec-core#held-data) applies only to parameters produced under valid authority before it ended. A client MAY retain and use those parameters for the reviewed purpose after grant ending or erasure. The exception covers learned-parameter values in weights or checkpoints. It does not exempt other checkpoint or optimizer contents merely because they are packaged with parameters. The client MUST keep stored examples, training-data copies, retrieval stores, and other derivatives subject to Core's held-data duties.

A model output is a derivative of an owner's PDPP data when that data was an input to producing the output. Earlier training of the model on that owner's data alone does not create that lineage. A client MAY continue inference or distillation from retained parameters when no covered PDPP input contributes to the new operation. If a prompt, retrieval result, label, synthetic example, or other PDPP input contributes, the client MUST apply coverage recursively to that contribution.

A lease confers no read access, onward-disclosure right, retention extension, or exemption from Core reconciliation and erasure. The client MUST apply the earliest applicable processing, acquisition-eligibility, retention, and erasure deadline. A Core lifecycle answer is not a lease. Keeping a training-only copy after its grant ends MUST NOT itself authorize ordinary use or further training. Limited continuation requires already-issued authority within Core's cessation exception and this profile's original deadlines and stop requirements.

The AS MUST preserve Core's distinct affirmative training approval and exact permission-set binding across review, consent evidence, grant, token result, and introspection. It MUST bind the reviewed training expiry into that evidence. Its approval surface MUST state the learned-parameter and stored-example consequences in Core [AI training consent](spec-core#ai-training-consent). The AS MUST NOT claim that withdrawal unlearns, that the model is anonymous, or that dataset erasure removes all personal information from the model.

## 4. Lease format and lifetime {#lease}

### 4.1 Signed format

The AS MUST issue each lease as a JSON Web Token (JWT, RFC 7519) in compact JSON Web Signature (JWS, RFC 7515) form. The protected header MUST contain `typ: "pdpp-processing-lease+jwt"`, a non-empty `kid`, and `alg`. The AS MUST use either `EdDSA` with an Ed25519 key or `ES256` with a P-256 key. The AS MUST support Ed25519 signing under `EdDSA`; it MAY also sign with `ES256`. The guard MUST support verification of both algorithms with those key types. A guard MUST reject `none`, symmetric algorithms, and every algorithm outside this set.

The AS MUST include the following claims with the stated types. The guard MUST reject a missing required claim, an incorrect type, an empty identifier, or duplicate claim names.

| Claim | Type | Meaning |
|---|---|---|
| `iss` | string | Exact AS issuer identifier, authenticated through discovery or pinned configuration |
| `aud` | string | Exact `client_id` of the training grant; arrays are not accepted |
| `jti` | string | Identifier unique among leases from this issuer |
| `grant_id` | string | Training grant |
| `permission` | string | Exactly `https://pdpp.dev/processing/ai_training` |
| `iat` | NumericDate | Conservative issuance time, in seconds since the Unix epoch |
| `exp` | NumericDate | Absolute expiry, in seconds since the Unix epoch |
| `acq` | array of strings, optional | Non-empty set of distinct acquisition grant identifiers from this issuer |

The AS MUST omit subject identifiers and input data from the lease. A guard MUST reject unsupported critical JWS headers. It MUST select keys only from the issuer trust path in Section 8, never from a lease-supplied key or URL. Unknown claims MUST NOT confer authority or widen an acquisition list.

### 4.2 Acquisition-list semantics

When `acq` is absent, the effective covered set is exactly `{grant_id}`. When `acq` is present, the effective covered set is exactly that list. The guard MUST check every contributing acquisition against that set, including acquisitions under the training grant itself. The guard MUST reject an empty explicit list. The AS MUST use the same effective set for issuance checks and history records.

Thus a lease for T with `acq: [A]` does not cover T's own acquired copy. Omitting `acq` does not cover an earlier copy acquired under A. A client MUST NOT substitute an acquisition identifier to evade an erasure or retention limit.

### 4.3 Issuer time and expiry

At the issuance decision, the AS MUST establish a trusted interval `[I_low, I_high]` containing current time on the lease timestamp basis. The AS MUST set `iat` to `floor(I_low)`. It MUST choose a nominal lifetime of at most 3,600 seconds and SHOULD choose at least 1,800 seconds. It MUST set `exp` to the earliest of `iat` plus that lifetime, the training grant's `expires_at`, and every known acquisition-eligibility deadline. Earlier grant or acquisition deadlines can make the resulting lease shorter than 1,800 seconds.

While a covered acquisition grant has a known future `expires_at`, the AS MUST also cap each lease at that time, even if no advance erasure election exists. This cap prevents outstanding authority from outlasting an election made later for that ending. After the acquisition grant ends, the AS MAY issue a new lease only if the acquisition copy remains eligible. The acquisition grant's ending alone does not prohibit that issuance.

**Note (non-normative):** This cap can briefly interrupt training at an ordinary acquisition expiry even when custody survives. New authority is needed to resume eligible training after that expiry.

The AS MUST refuse issuance if it cannot bound its clock uncertainty or establish `exp > I_high`. It MUST account for rounding conservatively. Every issuing node MUST use these rules, including after failover or clock correction. Checking only `exp - iat <= 3600` is insufficient: future-dating both claims would extend real authority.

A guard MUST reject a lease unless `0 < exp - iat <= 3600`. It MUST reject a lease whose `iat` is later than the upper bound of its trusted current-time interval. No verifier MAY add an expiry grace period. Renewal, delivery delay, a cache hit, or a restored checkpoint MUST NOT restart a lease's lifetime.

### 4.4 Renewal and outage budget

Renewal is required only while the client intends to continue training beyond a currently valid lease and the covered inputs remain eligible under its current knowledge. The renewal target is `iat + (exp - iat) / 2`, mapped conservatively to elapsed time. If those conditions hold at the target, the client MUST have started renewal by then. If the conditions first hold or become true again after the target while the lease remains valid, including on late receipt of a lease, the client MUST start renewal immediately. Jitter MAY move a required start earlier, never later. After a failed attempt, it MUST retry with bounded backoff while those conditions and existing authority remain, subject to `Retry-After`. A known lease-ending event or copy ineligibility MUST stop the affected lease requests as Section 5.4 requires. Ending an ordinary acquisition grant with eligible custody retained does not by itself stop renewal under another active training grant. No renewal is required when no further training is planned. Retry or server-directed delay MUST NOT extend a deadline.

**Note (non-normative):** Let `L` be lease lifetime, `e` early-renewal jitter, `r` worst retry, scheduling, and response delay after recovery, `u` clock margin, and `d` drain allowance. The available outage budget from the first attempt is `max(0, L/2 + e - r - u - d)`. Early jitter adds budget; delayed retries subtract it. With `e = u = 0`, `r = 2 min`, and `d = 3 min`, the budgets are 25 minutes for a 60-minute lease and 10 minutes for a 30-minute lease. These are examples, not unconditional uptime guarantees. An earlier acquisition deadline reduces the budget further.

## 5. Issuance, endings, and stop time {#issuance}

### 5.1 Eligibility

For each issuance, the AS MUST authenticate the requester and establish that the training grant belongs to it. The AS MUST establish that the grant carries this permission under the registered version, has not ended, and has an unexpired reviewed `expires_at`.

For every acquisition in the effective covered set, the AS MUST establish the authenticated issuer, subject, and client binding to the training grant. The AS MUST check the actual acquisition grant and its ordered lifecycle, not merely overlapping identifier strings. It MUST refuse a copy covered by an effective erasure instruction or one the client may no longer hold or process. It MUST cap expiry at a known future effective time of an advance erasure. The client and guard MUST additionally enforce copy-specific acquisition times, coverage, retention, and local instructions that the AS cannot observe.

This version permits an acquisition list only within the training issuer and audience client. The AS and guard MUST refuse cross-issuer or cross-client acquisition bindings under this contract. Multiple issuers MAY contribute separate inputs with independently valid leases and lineage; that does not authorize one issuer to assess another issuer's acquisition copy. Section 12 records the missing cross-issuer evidence contract.

A training grant's ending, whether by owner revocation, client-directed refresh-family revocation, security revocation, package disconnect, one-child withdrawal, or expiry, MUST stop the AS from issuing leases under that training grant. The AS MUST leave unaffected siblings unchanged. Refresh replay, access-token expiry, and closure of a `single_use` read window MUST NOT alone end processing eligibility. Access-token revocation follows Core Section 10: it can end a grant when no refresh family covers it.

An effective erasure of acquisition A MUST stop the AS from issuing leases naming A under any training grant of the same client. A lease excluding A MAY still issue for eligible acquisitions. A newly approved grant MUST have a new `grant_id`; the AS MUST NOT reactivate an ended grant. A new training grant MUST NOT resurrect an erased acquisition copy.

### 5.2 Ordered history and invariant T

**Invariant T:** Once the AS shows a confirmed “stops by T” for a training grant, no lease it has returned or will return for that grant has `exp > T`. For an acquisition erasure, the same invariant covers every lease whose effective acquisition set contains that grant. The AS MUST maintain this invariant across concurrency, crashes, restores, failover, and compaction.

The AS MUST keep a durable, append-only logical history of authority creation, lease issuance commitments, and lease-ending events. Every issuance commitment MUST bind `jti`, training grant, effective acquisition set, `iat`, and `exp`. The history MUST totally order each issuance against relevant lease-ending events. The AS MUST make the commitment durable before returning its lease. It MUST make a lease-ending event durable before acknowledging completion of that event.

The history MUST also record advance erasure elections and changes that introduce an earlier acquisition deadline. Issuance MUST be ordered against those events. An issuance ordered after such an event MUST apply its deadline, even before the erasure or earlier acquisition deadline takes effect.

Every issuing node MUST check current ordered history after recording its own issuance. The AS MUST refuse a lease whose issuance is ordered after a relevant lease-ending event. Its final eligibility check MUST include every lease-ending event acknowledged before that check. A history entry for a lease that might have escaped before a crash MUST remain in the stop-time calculation, even if delivery is unconfirmed.

The AS MUST compute T from the maximum committed `exp` that can still authorize the affected operation, never from a restorable cache alone. If there is no unexpired commitment, T is the effective ending time. Otherwise T is the later of that time and the maximum committed expiry. The AS MUST include commitments under other training grants when computing T for an acquisition erasure. Conservative inclusion of an unreturned lease is permitted; undercounting a possibly returned lease is not.

A backup restore or failover MUST NOT roll back this history. The AS MUST retain independent evidence sufficient to detect lost, truncated, rolled-back, or corrupted history before issuing authority. The AS MUST update that evidence before acknowledging each lease-ending event or returning a lease. A parse or integrity failure MUST remain a failure on subsequent reads until the AS re-establishes authoritative history.

An AS unable to establish current history MUST issue no lease. It MUST accept an authenticated owner's ending request as pending and apply it before any issuance resumes. It MUST NOT reconstruct live authority from an older grant database. These are storage properties, not a requirement to use a particular journal file, database, lock, or replication mechanism.

### 5.3 Withdrawal progress

Concurrent lease issuance MUST NOT delay or prevent the recording of an owner's ending. If the AS cannot record the ending at once, it MUST accept it as pending and apply it before any later issuance.

**Note (non-normative):** The reference prototype ([data-connect #352](https://github.com/PDP-Connect/data-connect/pull/352)) found these implementation hazards. A history store needs unambiguous record boundaries, so that a torn write cannot hide a later committed event, and a reader that cannot parse a complete record has to fail closed. A fencing epoch alone does not detect a truncated history. A withdrawal that waits on a lock held by issuers can starve under renewal load; recording it as one append, and having issuers re-check the history after their own append, avoids this. When grant state and processing history are in separate stores, recording the processing event first, and showing the ending as pending until both writes succeed, keeps a restored grant store from reviving authority.

### 5.4 Owner-visible state

For each completed lease-ending event, the AS MUST show the affected grant or acquisition scope and an absolute T, labeled as the deadline for conforming recipients. For example: “Training on this data stops by 21:40 for apps that follow PDPP.” The AS MUST NOT show completion or a confirmed T before the event and its stop-time basis are durable. A failed or uncommitted action MUST be shown as pending.

The AS MUST expose grant consent state separately from renewal availability on the authenticated owner surface. It MUST distinguish grant revocation or expiry from renewal-credential compromise, exhaustion, unavailable history, and signing-key failure. A credential failure MUST NOT silently record owner withdrawal or a deletion choice. The Core lifecycle operation remains a grant and erasure operation; this profile adds no processing state to its response.

The AS MUST show that already-produced learned parameters can remain and that stopping training is separate from deletion of copies. A lease can cover a copy acquired under a grant that the owner ends with `keep`. The AS MUST then state that training on that copy can continue under the training grant. Choosing `delete`, or ending the training grant, stops it. An owner's choice made in the client to end a training grant MUST stop new admission under that grant from the choice time, including when the AS is unreachable. A choice made in the client to delete an acquisition copy MUST stop new admission of that copy under every training grant from the choice time. Ending an ordinary acquisition grant with `keep` does not by itself stop otherwise authorized training on its eligible copies. Every path that requests, accepts, or distributes a new lease for those inputs MUST check a shared, durable client-side ending state. That check MUST be ordered against owner choices accepted by any client node. An isolated renewal node that cannot establish current state MUST NOT obtain or distribute replacement authority for the affected inputs. Workers MAY drain previously accepted authority only within its original deadlines. They MUST NOT renew independently of this boundary. The client's conformance claim MUST identify this boundary and its restore protection. Forwarding a stop message alone MUST NOT satisfy this requirement.

## 6. Lease endpoint and credentials {#endpoint}

### 6.1 Discovery and request

Once registered and supported, the AS MUST advertise these members in its RFC 8414 authorization-server metadata:

| Member | Value |
|---|---|
| `pdpp_processing_permissions_supported` | Includes the training permission only when the complete registered contract is supported |
| `pdpp_processing_lease_endpoint` | Absolute HTTPS URL for lease requests |
| `pdpp_processing_lease_jwks_uri` | Absolute HTTPS URL for the lease-signing JSON Web Key Set (JWKS, RFC 7517) |
| `pdpp_processing_lease_signing_alg_values_supported` | Non-empty array drawn from `EdDSA` and `ES256`, including `EdDSA` |

The AS MUST advertise `dpop_signing_alg_values_supported`. The advertised algorithms MUST be accepted at both the token exchange and lease endpoint. Public clients MUST select a proof algorithm from that list.

The client MUST use the authenticated issuer it retained from the OAuth exchange that delivered the training grant, or the same issuer provisioned through trusted configuration ([Protected resource metadata](spec-core#protected-resource-metadata)). It MUST require the discovered metadata's `issuer` to match it exactly before using either URL. A lease-supplied `iss`, endpoint, or key URL MUST NOT establish initial issuer trust. A client MUST NOT request leases from unadvertised endpoints. These endpoint and metadata requirements are normative requirements of this profile's AS and client claims.

The client MUST send an HTTP `POST` with an `application/x-www-form-urlencoded` body. The request parameters are:

| Parameter | Required | Meaning |
|---|---|---|
| `grant_id` | yes | One non-empty training grant identifier |
| `acquisition_grant_ids` | no | JSON-encoded non-empty array of distinct, non-empty acquisition grant identifiers; omitted means the training grant alone |
| `client_id` | yes | Audience client |
| `renewal_request_id` | for public-client renewal | Non-empty identifier unique for each logical renewal within the authenticated issuer-and-client namespace; unchanged across retries. A client MUST NOT reuse an identifier for a different logical renewal, including on another credential chain. |
| `client_assertion_type`, `client_assertion` | with assertion authentication | RFC 7523 client authentication |
| `client_secret` | with registered `client_secret_post` authentication | RFC 6749 client authentication |

The AS MUST copy an explicit acquisition list into `acq` without substitution or implicit additions. The AS MUST reject malformed bodies, duplicate scalar parameters, empty or duplicate acquisition entries, and unknown parameters with HTTP 400 `invalid_request`. The client MUST NOT place renewal credentials or leases in URLs. The AS MUST document request-size and acquisition-list limits. The AS MUST enforce those limits.

On success, the AS MUST return HTTP 200 with `Content-Type: application/json`, `Cache-Control: no-store`, and `Pragma: no-cache`. The body MUST contain `lease`, the compact JWS. For public-client renewal it MUST also contain `lease_credential`, the successor credential. The AS MUST NOT return data, access tokens, refresh tokens, or a reopened read window from this endpoint.

An unknown, ended, ineligible, or other client's grant MUST receive the identical HTTP 400 body `{"error":"invalid_grant"}` after authentication. This includes a failed acquisition-eligibility check, without identifying the failed acquisition. Invalid authentication MUST receive HTTP 401 `{"error":"invalid_client"}` without grant details. The AS MUST apply the same authentication checks before inspecting grants in these cases.

A missing or unacceptable required DPoP nonce is an exception to the generic authentication error. The AS MUST return HTTP 400 `{"error":"use_dpop_nonce"}` with one `DPoP-Nonce` header and `Cache-Control: no-store`. The client MUST retry the same logical renewal with a fresh proof containing that nonce. A nonce challenge MUST NOT rotate a credential or inspect grant eligibility. For browser clients, the AS MUST expose `DPoP-Nonce` through CORS.

If current history or bounded issuer time is unavailable, the AS MUST return HTTP 503 `{"error":"temporarily_unavailable"}` with `Retry-After`. The AS MUST rate-limit lease requests; HTTP 429 responses MUST carry `Retry-After`. All error responses MUST carry `Cache-Control: no-store`. No failure response grants or extends authority.

The AS MUST apply a pre-authentication rate limit keyed by a server-observed caller signal. A caller-supplied `client_id` alone MUST NOT identify that limit.

### 6.2 Confidential clients

A confidential client MUST authenticate using its registered token-endpoint authentication method. The AS MUST reject multiple authentication methods or a `client_id` inconsistent with the authenticated client. A client using a JWT assertion MUST set `aud` to the exact advertised lease endpoint URL, not the token endpoint or issuer URL. It MUST include a non-empty, unique `jti`. The AS MUST reject reuse of an accepted assertion identifier until its `exp`, across all nodes. The AS MUST otherwise validate assertions under RFC 7523. Client authentication alone MUST NOT authorize another client's grant.

### 6.3 Public-client delivery and proof

The AS MUST deliver a public client's initial per-grant renewal credential in the token response that first delivers the training grant. The response member is `pdpp_processing_lease_credentials`, an array of objects containing `grant_id`, `credential`, `expires_at`, and `cnf: { jkt }`. `expires_at` is the grant's RFC 3339 training expiry; `jkt` is the bound key's JSON Web Key (JWK) thumbprint. Each entry MUST correspond to a training grant in the same authorization result. Package responses MUST deliver a separate entry for each training child.

The public client MUST supply a Demonstrating Proof of Possession (DPoP, RFC 9449) proof at that token exchange. The AS MUST bind the credential to the proof's key and to the issuer, client, and training grant. A re-delivered initial token response MUST NOT create a second credential chain or reactivate a retired credential. The AS MUST keep each chain usable until training expiry unless it is revoked or disabled under this section. The credential confers neither client identity nor data access; it is a sender-constrained capability for that grant's lease endpoint.

The client MUST present the credential as `Authorization: DPoP <credential>` with a fresh `DPoP` proof for each lease request. The proof MUST bind `htm: POST`, the endpoint `htu`, and `ath` computed over that credential as RFC 9449 computes an access-token hash. The AS MUST validate key binding, signature, proof freshness, and any required nonce. It MUST reject proof-`jti` reuse across nodes throughout the proof's acceptance window. A retry MUST use a fresh proof; replaying the same proof is never a recovery mechanism.

A credential presented with the wrong key MUST be refused without revoking the legitimate chain or declaring theft. The AS MUST validate proof possession before treating credential reuse as compromise. Revocation of an ordinary access token or refresh replay MUST NOT alone disable this independent credential.

### 6.4 Rotation and compromise

Each renewal credential MUST have at most one successor. A public client MUST serialize logical renewals for each credential chain. All retries of one logical renewal MUST use the same `renewal_request_id` and a fresh DPoP proof. The AS MUST index that identifier within the authenticated issuer-and-client namespace. It MUST durably bind the identifier to the predecessor, client, grant, effective acquisition set, successor, and original successful lease response. The AS MUST apply authentication and grant/acquisition eligibility checks before resolving a recorded identifier: authentication failures and ineligible grants retain Section 6.1's errors. Within that namespace, a remaining request-binding mismatch MUST fail with HTTP 400 `invalid_request`. An eligible matching retry, including concurrent retries, MUST return the original response and MUST NOT create new authority. A client MUST NOT replace its current credential with a retired predecessor or successor received in a delayed response.

After the successor's first authenticated use, an authenticated retry of a recorded logical renewal MUST NOT be treated as theft. An authenticated predecessor use with a previously unrecorded `renewal_request_id` MUST revoke the chain as suspected theft. The AS MUST record that failure and notify the owner on the authenticated owner surface. Revocation of the chain MUST prevent all later renewals with any member. It MUST NOT retroactively extend or replace an existing lease. Rotation and compromise state MUST survive crashes and restores without resurrecting a retired chain.

The AS MUST store credential digests rather than plaintext credentials. It MAY derive reproducible successors with a hash-based message authentication code (HMAC), provided the key remains secret and the derivation separates issuer, grant, chain, and predecessor. Reproducibility MUST NOT create a second successor after restart or key rotation.

This version defines no automatic replacement chain for an exhausted, lost-key, or compromised public credential. The AS MUST require fresh owner approval and a new training grant for replacement authority. A public `single_use` client can therefore lose renewal permanently while the grant's consent record remains unrevoked. The AS MUST show that distinction and the last-lease stop time. Recovery MUST NOT reopen the old read window or erase existing lifecycle duties.

## 7. Authenticated lineage and worker enforcement {#enforcement}

### 7.1 Trusted ingestion boundary

The client MUST define an ingestion boundary whose authenticated identities and integrity controls are part of its conformance claim. That boundary MUST obtain the complete acquisition and training grants through authenticated AS exchanges. It MUST obtain input records through the authenticated, grant-scoped RS path. The boundary MUST bind each admitted byte sequence to a protected manifest containing:

- authenticated issuer, client-scoped subject, client, and acquisition-grant bindings;
- source, stream, instance, record and version identity, disclosed fields and resources, and the time-constraint evidence;
- a content commitment, acquisition time, original retention basis, and the authenticated grant evidence;
- for a derivative, its producing activity and every contributing parent manifest, or the conservative union of all possible contributors.

The client MUST specify the content-commitment algorithm and byte representation in its claim. The guard MUST verify the commitment against the actual bytes before admission. A boundary MAY identify a record version by its acquired content commitment when the source provides no separate version identifier. Manifest integrity MUST bind the origin evidence and content commitment together. Protection MAY use authenticated storage within one trusted boundary or signatures verified through an explicitly trusted boundary identity across components.

The client MUST retain this binding through transformations, joins, deduplication, synthetic data, embeddings, queues, batches, and checkpoints. If the client cannot enumerate exact contributors, it MUST use the union of possible contributing PDPP inputs. It MUST refuse training when it cannot establish even that conservative set. A copied grant tag or a signature from an untrusted component MUST NOT qualify as authenticated lineage.

### 7.2 Admission and scope validation

Before admission and before each training step, the guard MUST validate every contributing lease's signature, protected header, `iss`, `aud`, `permission`, `grant_id`, effective acquisition set, and expiry. The guard MUST compare these bindings with the authenticated grants and manifest, including subject, source, stream, instance, fields, resources, record version, and time coverage. The guard MUST reject missing, unsigned or unprotected, contradictory, substituted, or unverifiable evidence.

The guard MUST verify that its worker acts for the audience client under Section 10. Matching pairwise identifier strings across clients or issuers MUST NOT establish subject identity. A valid lease for another grant, client, subject, or acquisition MUST NOT authorize the input. The client MUST start the Core reconciliation query and apply Core overdue-disposal rules before admitting restored or resumed data. A Core query is attempt-only for ordinary use; for training, admission also needs valid lease authority and eligible inputs under this profile. A valid lease MUST NOT make a locally known erased, expired-retention, or otherwise ineligible copy usable.

### 7.3 Trusted time, admission stop, and drain

The guard MUST establish a bounded trusted current-time interval before using a lease. It MUST measure elapsed time with a clock that counts suspension, or cross-check trusted elapsed time before every admission and training step. A process-monotonic clock that omits system suspend is insufficient.

The guard MUST derive an execution deadline from `exp` using the upper bound of trusted current time. It MUST subtract clock uncertainty, scheduling allowance, and a bound for cancellation or completion when setting its admission-stop time. The guard MUST account for every earlier applicable deadline from Section 3. If time uncertainty exceeds the reserved margin, or bounded completion or cancellation cannot be established, the guard MUST stop admission and prevent further training steps.

The guard MUST persist a trusted-time high-water mark at each checkpoint and at least once per declared drain interval while running. The persisted state MUST be protected against rollback with the checkpoint or dataset. On restart, the guard MUST reconcile that mark with fresh bounded time before allowing any step. A high-water mark alone MUST NOT substitute for fresh time when unobserved elapsed time could extend authority.

The guard MUST revalidate time, authority, lineage, and applicable lifecycle facts on every resume. An unobserved suspend or clock rollback MUST NOT extend a deadline. The guard MUST refuse admission when a step cannot finish or be aborted before its execution deadline. Every queued or in-flight step MUST complete or abort before that deadline. Completing a step after expiry and discarding its result MUST NOT satisfy this requirement.

Once the client or guard learns that a training grant ended, it MUST stop admitting work under that grant and end work relying on it as soon as practicable within the existing deadline. Ending an ordinary acquisition grant with eligible custody retained does not by itself stop training under another active training grant. On learning of an effective acquisition erasure or other copy ineligibility, the guard MUST prevent further processing of that copy. A lease MUST NOT override a known erasure. Checkpoints, restored queues, and renewal responses received after expiry MUST NOT authorize work retroactively.

### 7.4 Outage and mixed inputs

When the AS is unreachable or renewal fails, the guard MAY use existing authority only until the earliest applicable deadline. It MUST then stop training on the affected inputs. Resumption MUST require new valid authority, fresh time, and eligible inputs.

For a mixed-owner batch, the guard MUST drop every affected contribution, including queued examples and accumulated intermediate results, before continuing under remaining authority. If removal cannot be shown to exclude the contribution, the guard MUST pause or abort the affected work. It MAY regenerate the batch without that input under remaining authority. The parameter exception in Section 3 applies to completed, valid steps; it does not excuse an in-flight step that crosses a deadline.

## 8. Signing keys and offline verification {#keys}

The guard MUST obtain the lease JWKS through an authenticated issuer trust path: an HTTPS fetch using authenticated AS metadata, or an issuer-bound pinned key set provisioned by a trusted administrator. A client-supplied JWKS without that trust path MUST be rejected. A relay MAY carry a key set only when the guard can verify its issuer binding and original freshness independently of the relay.

The AS MUST publish a non-empty `kid` for each lease-verification key. It MUST NOT reuse a `kid` for different key material. The guard MUST reject ambiguous key matches and algorithm/key mismatches. The AS MUST retain a normally retired key until every lease signed with it has expired. On emergency withdrawal, the AS MUST remove the key from the authoritative JWKS at once.

The AS MUST set a JWKS cache lifetime no greater than 3,600 seconds. The guard MUST limit every key set's freshness to at most 3,600 real elapsed seconds from its original freshness origin. The guard MUST also apply any shorter authenticated lifetime. For a direct fetch, the guard MUST use a freshness origin no later than the original request's send time. It MUST also subtract any HTTP response age from the advertised remaining lifetime. Delivery delay MUST NOT restart freshness. Cached, relayed, and pinned sets MUST carry authenticated evidence of their original freshness origin and lifetime. A guard unable to establish that evidence MUST obtain a fresh issuer assessment or refuse the set. Restoration, HTTP revalidation, and restart MUST NOT restart freshness without a new authenticated issuer assessment. The guard MUST enforce the resulting deadline using conservative elapsed-time bounds that include suspension and clock uncertainty.

The guard MUST stop using the key set when freshness expires unless it obtains a fresh authenticated assessment. If a refreshed set omits a relied-on key, the guard MUST stop admitting work under that key and abort affected work before any further training step. Unknown `kid` or an unavailable fresh key set MUST fail closed. A key-set deadline is an additional execution deadline under Section 7; it never extends a lease.

**Note (non-normative):** A worker can operate without contacting the AS while its lease, key set, and other required authority remain valid. A compromised signing key can forge authority until the worker learns of withdrawal or its authenticated key-set freshness expires. The withdrawal bound assumes an uncompromised issuer and trusted guard. Cache expiry bounds stale-key use; it does not prove that a malicious signer or recipient obeys this profile.

## 9. Records {#records}

For each job, the client MUST keep an audit record linking admitted input commitments and lineage to the job and its governing acquisition and training grants. The record MUST include the following evidence:

- relied-on lease `jti` values, their issuer and expiry, and the effective acquisition sets;
- relied-on key evidence with its authenticated freshness origin and enforced deadline;
- renewal attempts, successes, failures, and receipt times;
- trusted-time source, uncertainty and scheduling margins, persisted high-water marks, and drain allowance;
- admission-stop, actual completion or abort, resume, and cessation times;
- downstream identities, forwarded authority and deadlines, acknowledgements, and unresolved failures.

The client MUST preserve enough authenticated grant, lease, key, and manifest evidence to audit those decisions. It MUST keep audit evidence separate from reusable training inputs. The client MUST NOT retain erased source payloads as audit evidence. Input commitments and identifiers remain subject to applicable retention and minimization duties.

The AS MUST keep authority-creation records, issuance commitments, lease-ending events, pending actions, credential-chain compromise facts, and the basis of every displayed T. It MUST retain each potentially outstanding issued expiry until that expiry has passed. Compaction MAY replace past issuance entries with an equivalent protected summary only after their authority has expired. Compaction MUST preserve terminal facts, covered acquisition associations needed for future checks, and restore detection. The AS MUST retain terminal facts while any grant, copy, or recovery path could rely on them.

The client and AS MUST make these records available for conformance audit. The AS SHOULD minimize renewal logs beyond the evidence needed for issuance safety and accountability. Records support attribution; they are not proof that a malicious recipient stopped or deleted a copy.

## 10. Downstream parties and optional features {#downstream}

### 10.1 Subprocessors

A client that passes covered data to a party acting for it MUST impose this profile's duties by contract. It MUST provide the relevant grants, leases, protected lineage, and issuer trust roots through an authenticated channel. It MUST bind the party's worker identity to authority to act for the audience client, limited to the approved job and purpose. The guard MUST verify that delegation before accepting an `aud` that names the client rather than the worker.

The client MUST forward stop, retention, and erasure deadlines as absolute times. A party MUST NOT start a new period on receipt or relay. The client MUST obtain and record acknowledgements or record the missing acknowledgement as an unresolved downstream failure. The party MUST enforce the same admission and whole-step deadlines. A lease MUST NOT become a transferable bearer right for an independent downstream controller; such a controller needs its own authority.

### 10.2 Batching (optional)

An AS MAY offer a documented batch binding for grants from that AS. A claiming batch implementation MUST cap request size and item count. It MUST authorize and apply all issuance checks to each item independently. Its failures MUST be indistinguishable among unknown, foreign, ended, and ineligible grants. A public-client batch MUST establish each item's credential and key possession. Batching MUST NOT combine authority, extend expiry, or delay a withdrawal. This version defines no common batch wire format.

### 10.3 Push (optional)

An implementation MAY use authenticated, signed events to prompt earlier stopping or renewal. A separate event binding can use Security Event Tokens (RFC 8417) and their push delivery (RFC 8935). This version registers no event type. A client MUST NOT treat an unsigned or untrusted event as authority. Push receipt, absence, delay, replay, or failure MUST NOT extend any deadline or replace lease validation. Authenticated terminal information remains subject to Section 7's stop rules.

## 11. Conformance cases {#conformance}

A conformance report MUST identify the implementation revision, claimed roles, time model, storage backend, and execution boundary tested. It MUST exercise each applicable case below, including its stated variants. A report MUST label an unimplemented optional feature not applicable, never passed. While registration remains unapproved, [Core C7](spec-core#held-data-cases) MUST remain not applicable; experimental evidence MUST be labeled as such. After registration, implementations supporting this permission MUST pass C7 through this profile's acquisition-erasure case.

### 11.1 Authority, lifecycle, and storage

| Case | Setup | Required observation |
|---|---|---|
| A1. Reserved permission | Request training before registration; vary purpose labels and legacy training purpose code. | No advertisement or training authority; permission requests fail with `invalid_authorization_details`, without ordinary-grant substitution. |
| A2. Read versus training state | End a `single_use` read window; expire or revoke a family-covered access token; trigger refresh replay. | Eligible processing renewal continues without new read access. Token revocation that ends a training grant instead stops issuance under that grant. |
| A3. Ending paths | Exercise owner and security revocation, client-directed family revocation, package disconnect, one-child withdrawal, grant expiry, and reapproval. | Affected grants issue no later lease; siblings survive child-only withdrawal. No lease outlasts grant expiry. Reapproval has a new grant ID. Dispositions remain Core choices. |
| A4. Race and no-wait withdrawal | Concurrent issuers race withdrawal; block one issuer during signing and response delivery. | Withdrawal completes without releasing the blocked issuer. Every returned lease is covered by T. A commitment ordered after the ending is refused. |
| A5. Restore and stale nodes | Issue after a backup, then restore it; retain a node on the replaced store; skew its clock; crash after appending a lease-ending event before projection update. | T includes possibly returned leases after the backup. No stale node renews ended authority. Pending projections cannot resurrect grants. |
| A6. History failure | Lose, truncate, roll back, or corrupt history, including a suffix of lease-ending events whose epoch survives; retry twice and reopen the store. Also place a torn write before a committed terminal record. | Failure remains closed across reads and restart. No lease issues. Owner actions remain pending until applied. Independent evidence detects lost acknowledged events and issuance commitments. A torn write never hides the later committed terminal record. |
| A7. Dual-store failure | Fail the authority write, then the read-store write; restore only the main database. | Pending is shown; authority is recorded first. Neither an active token nor a restored grant row overrides terminal history. |
| A8. Acquisition erasure (Core C7) | Acquire under A; train under T. Erase A while T stays live, including an issuance race and AS outage. | No later issuance covers A. Existing authority ceases within 1 real hour of effective erasure. Owner T covers all affected leases across training grants. |
| A8a. Client-local erasure with asymmetric connectivity | The owner chooses delete in the client. Block that client's paths to the AS and worker, while leaving another renewal node's AS path available. Drop every forwarded stop message. | No lease request, acceptance, or distribution decision ordered after the owner's choice authorizes affected inputs. A lease response already in flight at the choice may still arrive, but it does not bypass the durable client-side ending check or extend accepted authority. Affected work ends within one real hour of the choice. Restoring client-side renewal state does not remove the ending. |
| A9. Acquisition-list regression | Lease T has `acq: [A]`; attempt T's own copy. Omit `acq` and attempt A; send `acq: []`. | All are refused. Explicit lists replace the fallback. Each named acquisition receives eligibility checks. |
| A10. Earlier copies and advance erasure | End an ordinary acquisition with keep; issue a covering training grant. Then schedule erasure, exhaust retention, or erase the acquisition. | Keep alone does not end otherwise eligible custody. Known future effective times cap leases. No lease renews an erased or ineligible copy or resets original retention. Repeat the keep ending at the AS and in the client: after the client learns of it, eligible renewal and new admission under the separate training grant remain permitted. |
| A10a. Late advance-erasure election | Issue a lease before the owner elects deletion at a covered acquisition grant's known expiry. Make that expiry earlier than the nominal lease expiry. Keep the worker offline. | Existing and subsequent leases end no later than the acquisition expiry. Repeat with the election racing issuance. |
| A11. Compaction and partial package endings | Compact after expiry; restore older projections; fail one package child ending. | Lease-ending events and T remain valid. Complete disconnection is not reported while a child remains pending. |

### 11.2 Credentials and keys

| Case | Setup | Required observation |
|---|---|---|
| K1. Lease validation | Verify valid EdDSA/Ed25519 and ES256/P-256 leases. Vary signature, `typ`, `kid`, algorithm, issuer, audience, permission, grant, lifetime, and required-claim types. | The guard accepts both valid algorithms. It rejects each invalid variant, including `none`, symmetric signing, and a wrong grant or audience. |
| K2. Delivery and capability | Obtain a public training grant and a package with two training children; close read windows before renewal. | Initial responses deliver separate bound credentials. Renewal still works; neither credential nor lease reads data or reopens a window. |
| K3. Lost and concurrent responses | Lose a renewal response; retry with a fresh proof after the first proof expires. Send concurrent retries with the same `renewal_request_id`; delay one until after successor use. | Recorded retries return the original successful lease response without revocation or new authority, after current authentication and eligibility checks. A delayed response never replaces the client's current credential with a retired credential. Repeated proof `jti` is rejected. No same-proof exception exists. |
| K3a. Logical renewal bindings | Within one authenticated client namespace, reuse `renewal_request_id` with a different predecessor, eligible grant, or eligible effective acquisition set. Repeat an identifier independently for two authenticated clients. Retry after acquisition erasure or training-grant ending, including with changed bindings. | Eligible changed bindings fail with `invalid_request`. Independent clients do not collide. Authentication and current ineligibility retain Section 6.1's errors; a recorded response never bypasses a lease-ending event. |
| K4. Credential theft | Use a predecessor after successor use with the right key and a previously unrecorded `renewal_request_id`; repeat with a wrong key; restore old rotation state. | Right-key reuse revokes the chain and notifies the owner. Wrong-key use only fails authentication. Restore never revives the chain. |
| K5. Renewal loss versus consent | Exhaust or disable a public `single_use` credential after its read window ends. | Renewal ends by last-lease expiry; consent state is not silently revoked. Recovery needs new approval and a new grant, without a second old read window. |
| K6. Request authentication | Present a token-endpoint or issuer-audience assertion, replay an assertion across nodes, omit `ath`, swap credentials under a proof, or replay DPoP across nodes. | Every attempt fails. A fresh assertion with lease-endpoint `aud` and a fresh bound proof succeeds when grants remain eligible. |
| K6a. Nonce recovery and algorithm discovery | Omit a required nonce, then retry with a fresh proof. Change the required nonce and retry again, including in a browser. Select proof algorithms from discovery for token exchange and lease requests. | Each challenge returns HTTP 400 `{"error":"use_dpop_nonce"}`, one browser-visible `DPoP-Nonce` header, and `Cache-Control: no-store`. Challenges leave credentials unchanged and do not inspect eligibility. Retries retain the logical renewal identifier and use the supplied nonce. Advertised algorithms work at both endpoints. |
| K7. Uniform refusal and rate limits | Authenticated caller names unknown, foreign, ended, and ineligible grants, individually and in a supported batch. An unauthenticated caller varies `client_id` across repeated requests. | Refusals have the same status and body. No item authorizes another. Request limits and rate limits apply. Varying `client_id` does not bypass the pre-authentication limit. |
| K8. Key distribution | Supply an attacker JWKS; rotate normally; withdraw a key; expire a cached or pinned set while offline. | Untrusted sets fail. Retired keys remain through last expiry. Observed withdrawal stops use; stale key sets cannot authorize work. |
| K8a. Freshness origin | Delay direct JWKS delivery; supply a cached response with nonzero `Age`, a pin with unknown provisioning age, and restored freshness metadata. | Direct freshness starts no later than request send time. Response age reduces remaining lifetime; delivery and restore never restart it. Unknown pin freshness requires a fresh issuer assessment or refusal. Audit key evidence records the origin and deadline, enforced across suspension and clock uncertainty. |
| K8b. Universal freshness ceiling | Provision a trusted pin with authenticated origin and a 24-hour lifetime. Keep the guard offline, including across suspension and restore. | The guard stops accepting the set within 3,600 real elapsed seconds of its original freshness origin. A shorter authenticated lifetime stops acceptance earlier. |

### 11.3 Time, lineage, and execution

| Case | Setup | Required observation |
|---|---|---|
| W1. Whole-step expiry | A queued or in-flight step would cross expiry; attempt to discard its output afterwards. | Admission stops early; each step finishes or aborts before its deadline. Late result discard fails conformance. |
| W2. Suspend and restart | Resume after expiry; simulate an unobserved system suspend; roll back wall time during execution and across restart. | No extension. Guard checks fresh bounded time and its persisted high-water mark. A process-only monotonic clock fails the suspend case. |
| W3. Restored checkpoint | Restore data, queue, manifest, and checkpoint from before withdrawal or disposal; use a rollback smaller than the last persistence interval. | Fresh time and terminal facts apply before any use. The checkpoint supplies no authority; overdue disposal completes first. |
| W4. Issuer uncertainty | Move an issuer ten minutes ahead while keeping `exp - iat` at one hour; remove the trusted-time bound. | No future-dated lease extends real authority. Unbounded issuer time refuses issuance. Worker uncertainty beyond its margin stops use. |
| W5. Outage and renewal | Plan training beyond the current lease with inputs still eligible under the client's knowledge. Inject failures shorter and longer than the measured budget, delayed responses, retry backoff, and earlier jitter. | Renewal starts by half-life. Earlier jitter adds budget. Delay subtracts it. No response or retry extends authority; late recovery requires new authority before resumption. |
| W5a. Renewal after stopping | Receive a lease, then before half-life finish the only job; repeat with an owner choice in the client to end a training grant or delete an acquisition copy. | No renewal is required after job completion. No subsequent request is made under a locally ended training grant or covers a locally erased or otherwise ineligible acquisition copy, and existing work observes its original stop deadline. |
| W6. Mixed owners | Withdraw one contributor in a batch, accumulated gradient, join, deduplicated input, embedding, or synthetic example. | Remove every affected contribution or pause. Remaining owners continue only if exclusion is established. |
| W7. Lineage substitution | Swap a tag with another valid same-client grant; substitute subject, source, stream, instance, field, resource, version, time evidence, or bytes. | Admission refuses every mismatch even when the lease signature is valid. Missing or unprotected manifests fail closed. |
| W8. Earlier-copy bypass | Erase A while T remains live; relabel A as T, or compare pairwise strings across issuers or clients. | No authority or independent acquisition is fabricated. An unsupported cross-issuer binding is refused. |
| W9. Parameters versus examples | End training; retain learned parameters, optimizer accumulators, stored examples, retrieval data, and a checkpoint containing examples. | Valid parameters can remain for reviewed use. Other optimizer state, inputs, and examples obey Core disposal. New PDPP inputs still require authority; outputs with no such input do not inherit historical training lineage. |
| W10. Downstream and optional push | Relay work to a subprocessor; delay its receipt; lose a stop event; supply an unrelated worker identity. | Worker verifies delegation, grants, lineage, keys, and original absolute deadlines. No relay or push extends authority. Unrelated workers fail admission. |
| W11. Records and owner statement | Run renewal, failure, withdrawal, drain, resume, and a missing downstream acknowledgement. | Audit evidence reconstructs relied-on authority and actual stop times. Owner sees durable T or pending, separate consent and credential facts, and no claim of proven remote deletion. |
| W12. Minimum lifetime and caps | Use nominal lifetimes of 1,800 and 3,600 seconds. Vary grant expiry and acquisition deadlines before and after the nominal expiry. | `exp` equals the earliest of `iat` plus the chosen lifetime and the applicable deadlines. Without an earlier deadline, the AS does not shorten the chosen lifetime. Issuance fails when `exp` is not later than `I_high`. |

## 12. Open issues and limits (informative) {#open-issues}

- **Lineage interoperability.** Section 7 defines a testable admission boundary, but no common manifest serialization, transformation vocabulary, or ingestion-boundary certification exists here. A deployment must document its concrete format and trust roots to test that boundary. A trusted component's dishonest omission of a parent remains an accountability limit, not a cryptographic proof problem solved by its signature.
- **Cross-issuer earlier copies.** This draft refuses an acquisition assessed by a different training issuer. Supporting it needs authenticated acquisition evidence, subject/client binding, and eligibility freshness that preserves the one-hour ceiling. An ordinary Core lifecycle answer does not establish another issuer's acquisition eligibility within the one-hour bound. New bindings cannot weaken the registered version's protections.
- **Distributed durability.** The required ordering, loss detection, compaction, and no-wait withdrawal need evidence on the actual multi-node storage and recovery system. A single-host append-only prototype alone does not establish those properties. A service halt after loss is safer than reconstruction from stale consent.
- **Availability and credential recovery.** The minimum lifetime, maximum lifetime, cache bound, and renewal schedule need operational validation for personal servers. This draft chooses new owner approval after public-credential compromise; it defines no same-grant recovery protocol. Optional batching and push also lack common wire bindings.
- **Malicious recipients and signing-key compromise.** A recipient can copy plaintext, falsify lineage, or ignore expiry. A compromised issuer can sign false authority. The contract sets duties for conforming parties and records for audit; it cannot guarantee universal cessation, anonymity, or unlearning.
