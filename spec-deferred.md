# Spec v2: Deferred Concerns

Status: Informative
Date: 2026-09-03 (revised)

Issues identified during design and review that are intentionally out of scope for v0.1. Each item is named precisely so it can be referenced from the core spec and tracked for future versions.

This document mixes three kinds of entries, now split into three sections:

- **Open design questions**: unresolved concerns. The spec should be designed so these can be added later without breaking changes, but no v0.1 design constraint has been adopted yet.
- **Decided (recorded for history)**: concerns that were raised during design and review and were resolved by adopting an explicit v0.1 design constraint. These are recorded here for the rationale trail, not because they are still open.
- **Implementation TODOs (v0.2 candidates)**: concrete, scoped work items that don't require resolving a semantic design question first.

Dated batch attributions (`Newly deferred (...)`, `Finding (independent review)`, etc.) are preserved inside each entry as originally written.

---

## Open design questions

### Predicate-Based Grant Scoping (Subset Templates)

_Newly deferred (2026-04-07)._

**Description:** A mechanism for expressing semantically bounded consent narrower than a whole stream without using specific resource IDs. Example: "only messages from sender amazon.com," "only transactions from merchant X," "only Spotify history tagged as rock." In v0.1, grants can narrow access only by stream name, named view/field projection, time range, and explicit resource IDs. Arbitrary semantic predicates over stream contents are not supported as grant parameters.

**Why deferred:** Predicate-in-grant requires solving, simultaneously: a predicate grammar; type semantics across arbitrary connector schemas; normalization and canonical equivalence; AS validation rules; RS enforcement rules; interaction with field projection and time-range semantics; and a consent rendering model that does not lie to the user. This is effectively a second protocol embedded in the most sensitive part of the first. Prior art (OAuth RAR, SMART on FHIR, HIPAA research systems) shows that generic free-form predicates over heterogeneous schemas do not have a strong track record as reviewable consent artifacts. SMART on FHIR's constrained search-parameter scopes work only because FHIR has a standardized resource type and search-parameter ontology — PDPP spans arbitrary connectors and does not have that shared vocabulary.

**v0.1 posture:**
- `filter[{field}]` query parameters narrow a retrieval result, not the grant scope. A client authorized for a stream may query a filtered subset; the grant remains a grant to the stream as issued.
- Semantically bounded subsets should be modeled as named streams in the connector manifest (e.g., a connector exposes both `messages` and `amazon_messages`). Whether a stream is source-native or derived is connector-internal; the grant authorizes by stream name either way. This uses the existing stream abstraction without introducing a new protocol primitive.
- Stream names MUST NOT encode predicate logic (e.g., `messages?sender=amazon` or `messages_where_sender_eq_amazon` as a synthesized name). Derived subset streams must have stable, human-readable names documented in the manifest.

**Recommended future direction:** Manifest-declared parameterized subset templates. The connector manifest declares subset templates with typed bound parameters and human-readable consent display strings. Example shape (non-normative):

```json
{
  "name": "messages",
  "subset_templates": [
    {
      "id": "by_sender_domain",
      "label": "Messages from a sender domain",
      "parameters": [
        { "name": "domain", "type": "string", "format": "hostname" }
      ],
      "consent_display": "Messages from {{domain}}"
    }
  ]
}
```

The grant carries the template ID and bound parameter values, not the predicate. The connector defines the semantics; the AS validates types and renders the consent display string; the RS enforces the resolved constraint. Parameters are strongly typed (string with format, enum, date, numeric range) — no boolean composition, nested expressions, or arbitrary field references in the first version.

**Open questions to resolve before specifying:**
1. **Temporal semantics:** Does a subset-template grant cover only currently matching records, or future matching records too? Must interact with `access_mode` and `time_range` — the interaction rules are non-obvious and must be specified precisely to avoid interop divergence.
2. **RS enforcement model:** The RS currently enforces grants using pre-resolved embedded constraints (fields, time_range, resources). Subset templates either require the AS to pre-resolve the template into an embedded constraint the RS can enforce blindly (clean, limited), or require the RS to evaluate the template predicate at query time (flexible, new enforcement surface). This choice must be made before specifying the wire format.
3. **Manifest versioning:** If a subset template's underlying predicate changes across manifest versions (e.g., the connector changes how it identifies "Amazon messages"), does prior consent still apply? Likely: template predicates are immutable within a manifest version; changing a predicate requires a new template ID.
4. **Parameter type vocabulary:** What parameter types are allowed in v0.2? Strong preference for a minimal first set (string/hostname, enum, date) over a general-purpose expression language.

**Design constraint:** The subset template approach must not become a backdoor for arbitrary predicate-in-grant. Per-request or per-user subset-stream synthesis (where the client or user supplies the predicate at runtime) is not the goal. The manifest is the trusted, versioned artifact; the grant binds typed parameters against a connector-defined template.

### Active Erasure Signal

_Newly deferred (2026-04-11)._

**Description:** A standardized signal from the personal server or authorization server to the recipient indicating that revocation has been paired with a deletion request. This is distinct from revocation itself: revocation stops future access, while erasure asks the recipient to delete already received data.

**Why deferred:** A real erasure signal requires more than a new event name. It needs recipient authentication, delivery and retry semantics, acknowledgment behavior, auditability, and a clear relationship to legal obligations that may override deletion. Those choices cross AS, RS, and client boundaries and should not be improvised into v0.1.

**v0.1 posture:** State explicitly that revocation is not deletion. Do not overload revocation responses or introspection state to imply downstream erasure.

### Re-Interaction / Session Refresh

_Newly deferred (2026-04-11)._

**Description:** A standardized way for a runtime or personal server to signal that a `continuous` collection path needs fresh user interaction: login renewal, MFA, consent refresh, or other source-side reauthentication.

**Why deferred:** This is not just a runtime message. It crosses the connector runtime, the user's notification surface, the authorization server, and potentially the app that depends on the grant. It needs asynchronous interaction semantics rather than the current foreground `INTERACTION` request/response pattern.

**v0.1 posture:** A `continuous` grant may remain valid while collection fails or pauses because source-side session state has decayed. Implementations should surface this honestly as an operational failure, not reinterpret it as grant revocation or successful freshness.

### Request-Side Freshness Requirements

_Newly deferred (2026-04-11)._

**Description:** A client-specified freshness requirement such as maximum acceptable age for data returned under a grant or query.

**Why deferred:** Request-side freshness creates a new promise surface. A personal server may know that data is stale, but still be unable to refresh it because the connector is unavailable, the user is offline, or the source throttles access. Before standardizing a request field, the protocol must decide whether unmet freshness is a hard error, a best-effort hint, or a negotiation mechanism.

**v0.1 posture:** Prefer response-side freshness metadata first. Let the server report what it knows (`captured_at`, `status`, `last_attempted_at`) before asking it to promise collection behavior it may not be able to deliver.

### Source Lifecycle Actions

_Newly deferred (2026-04-06)._

**Description:** The ability for a connector to perform write operations on a source platform after collection. Examples: deleting exported videos from a hosting platform to free up quota, archiving records at the source, or triggering source-side cleanup.

**Why deferred:** PDPP v0.1 covers collection, storage, and disclosure. Outward writeback to source platforms introduces new trust concerns (irreversible actions, platform API variability) and is architecturally distinct from the read-oriented protocol.

**Design constraint for future version:** Source lifecycle actions should be a separate, explicitly authorized action class in the grant. They must not be conflated with collection scope.

### Event-Driven Collection Triggers

_Newly deferred (2026-04-06)._

**Description:** Triggering connector collection runs in response to push notifications or webhooks from source platforms (e.g., "run the connector when the platform notifies us of new data").

**Why deferred:** Event-driven triggers are architecturally distinct from the pull-based Collection Profile. They require a separate subsystem: subscription lifecycle management, callback delivery, replay, retry, ordering guarantees, and expiry/renewal. This is not a minor extension to the current model.

**Design constraint for future version:** Event-driven triggers should be specified as a separate profile. The grant's `access_mode` field is designed to accommodate this without breaking changes (a future `event_driven` value alongside `single_use` and `continuous`).

### Canonical View Naming Vocabulary

_Newly deferred (2026-04-06)._

**Description:** A standardized set of view names (e.g., `basic`, `standard`, `full`) with consistent semantics across connectors, enabling portable consent UX.

**Why deferred:** The right canonical names cannot be determined without implementation experience across diverse connectors. Premature standardization risks names that fit few real use cases.

**Design constraint for future version:** The view mechanism in v0.1 (connector-suggested views, monotonically additive, no default) is designed to accommodate canonical names as a non-breaking addition.

### Authorization Server Interface

_Newly deferred (2026-04-06)._

**Description:** A normative specification of the authorization server's HTTP interface: endpoints for grant issuance, revocation, status queries, and token introspection.

**Why deferred:** Authorization flows are deployment-specific in v0.1. The reference implementation uses standard OAuth flows: the authorization code flow with RFC 9396 authorization_details for client grants, and OAuth device authorization for owner tokens. Standardizing the authorization server interface requires more implementation experience.

### Point-in-Time Reconstruction

_Newly deferred (2026-04-06)._

**Description:** Reconstructing the full state of a `mutable_state` stream at a past timestamp (e.g., "what did the profile look like on March 1?").

**Why deferred:** Requires the resource server to materialize historical state from version history. Expensive to implement and not required for the core incremental sync use case.

### Privacy-hostile defaults

_Historical corrections (mostly resolved): the main still-live issue from the March 2026 review pass._

Many of the March 2026 naming and semantic-precision corrections identified during early review have since been incorporated into the live v0.1 draft: URI-based `type`, `connector_id`, `access_mode`, inclusive/exclusive `time_range`, START `state` as a per-stream map, `StreamRequest`/`StreamGrant` separation for `necessity`, compound-key ordering, and field-allowlist behavior.

The main still-live issue from that pass is not terminology but default posture: whether v0.1 remains too permissive when selectors are omitted.

**Finding (independent review):** Omitting selectors means "all available data", `necessity` defaults to `required`, `"name": "*"` means all streams. These defaults favor maximum data collection.

**Semantic question:** Should the spec default to maximum or minimum data? Open Banking defaults to minimum (you must explicitly list permissions). OAuth defaults to maximum (scopes grant broad access). For personal data portability, the Open Banking approach (explicit, minimal) is more defensible.

**Options:**
1. Keep current defaults (maximum) but require explicit opt-in for wildcards — already somewhat true since `"*"` must be specified
2. Change defaults to minimum — no streams means no data, every stream must be listed
3. Keep as-is but document the rationale

This is a design philosophy question, not just a technical one.

### Derivative Data

_Newly deferred (2026-09-02)._

**Description:** Data produced by computing over data a grant already covers — an embedding, a summary, a classification, a model fine-tuned on the records, an inference about the owner. PDPP today authorizes reads of declared streams. It says nothing about what a client may do with the output of compute over what it read, and nothing about whether that output is itself owner data requiring its own grant.

**Why it is open:** Answering it means deciding at least five things. Whether derivative data is in scope for PDPP at all. Whether producing it needs its own grant or is implied by the read. Whether it is a distinct semantic class or a source in its own right. How revocation of the underlying grant reaches an artifact already derived. And whether the answer differs for a reversible transformation, such as an index, and an irreversible one, such as trained weights. `purpose_code`, and the explicit protocol-level consent rule for `ai_training`, are the only places v0.1 touches this, and they constrain declared purpose, not derived artifacts.

**v0.1 posture:** Out of scope, and unresolved. Nothing in v0.1 asserts that derivative data is authorized, and nothing asserts it is not. The question is open, and this specification states no default either way; a future version answers it as a normative decision rather than as an inference from this silence.

**Design constraint for a future version:** A derivative-data model should be addable without redefining the existing grant, most plausibly as an additional semantic class or an additional grant kind rather than as a change to `StreamGrant`.

### Cross-Source Category Grants

_Newly deferred (2026-09-02)._

**Description:** Granting by category across sources — "my health data", not five named providers. PDPP has the shape of this within one source: a named view is a source-declared subset a user can consent to by name. The open question is the same idea one level up, spanning sources.

**Why it is open:** It needs a shared category vocabulary that is meaningful across arbitrary sources. It also needs a rule for what happens when a source is added to the owner's server after the grant was issued. Does it join an existing category grant automatically? If so, how did the user consent to something that did not exist yet? That second question is the harder one: it is the same widening problem the specification forbids elsewhere (a field added after a grant is issued MUST NOT become visible to that grant). The related but distinct problem of naming views consistently across connectors is tracked separately as [Canonical View Naming Vocabulary](#canonical-view-naming-vocabulary).

**Candidate prior art, not yet evaluated:** W3C Verifiable Credentials, ODRL, DCAT, schema.org category vocabularies, FHIR resource categories, Solid type indexes, and ToIP's Trust Registry Query Protocol were all named as possibilities. None has been assessed for fit. The evaluation should judge each on whether it supplies a category vocabulary that survives arbitrary sources, not on general standing.

**v0.1 posture:** Out of scope. Grants bind to a single `source.id`. A user wanting a category across five providers issues five grants today.

### Subgrants

_Newly deferred (2026-09-02; raised in the 2026-08-19 working session)._

**Description:** Whether a client holding a grant may pass a narrower piece of that access on to another party, without the owner issuing a second grant directly.

**Why it is open:** A grant is immutable and bound to one `client_id`. A subgrant needs a rule for what the owner sees and approves, whether the subgrantee is visible to the owner at all, how revocation of the parent reaches the child, and whether a subgrant can outlive its parent. Answering it badly produces exactly the re-delegation surface the grant model exists to prevent.

**v0.1 posture:** Out of scope. Access under a grant is not transferable, and a second party needs its own grant.

### Change of client ownership and undisclosed sub-processing

_Newly deferred (2026-09-02; raised in the 2026-08-19 working session)._

**Description:** An owner grants access to a client on assumptions about that specific relationship. If the client is acquired, changes legal structure, or outsources processing to a third party the owner never saw, those assumptions no longer hold, and the grant does not know it.

**Why it is open:** The protocol has no representation of who the client is as a legal entity, and no event by which a change of control could reach an issued grant. One suggestion from the session was to require clients to declare ownership type. Whether that belongs in the protocol, in the conformance programme, or nowhere is undecided, as is whether a change of control should force revocation, force re-consent, or merely be disclosed.

**Related:** MyTerms was raised in the same discussion as prior art for owner-specified terms under which a first party holds data. It is IEEE P7012, published as IEEE 7012-2025 "Standard for Machine Readable Personal Privacy Terms"; earlier notes in this repository called it "ISO MyTerms," which is wrong. Whether owner-specified terms belong in Core, in a companion RFC with the authorization server holding templates, or outside PDPP entirely is still open. See [MyTerms (IEEE P7012) compatibility](#myterms-ieee-p7012-compatibility) for how a PDPP grant relates to that model.

**v0.1 posture:** Out of scope. `client_claims` carries client-authored, explicitly non-enforceable statements about a specific request; it is not an ownership record and must not be read as one.

### MyTerms (IEEE P7012) compatibility

_Newly deferred (2026-09-03); written in response to the question of whether PDPP risks drifting from MyTerms._

**Description:** IEEE 7012-2025 "Standard for Machine Readable Personal Privacy Terms," known as MyTerms, inverts the usual direction of online agreement: the individual is the first party and proffers privacy terms, and the service provider is the second party that accepts one of them. The terms are not invented per relationship. They are chosen from a roster kept by a neutral non-business entity, which today is Customer Commons, and each rostered term is a versioned dereferenceable URL such as `https://customercommons.org/agreements/p2b1/0-9/`. Agreements are recorded and kept by both sides.

**How a PDPP grant relates:** A PDPP grant is already the recorded agreement on the owner's side. It is immutable, it names the second party (`client`), and it carries the recipient-side commitments as structured fields rather than prose: `purpose_code` and `purpose_description` are what the data may be used for, `retention` is how long it may be kept and what happens at expiry, and `access_mode` bounds whether the access is one-shot or ongoing. `client_claims` is not part of this analogy: it is explicitly client-authored and non-enforceable, which is the one-sided privacy-policy posture MyTerms exists to displace, so it must not be read as an agreed term. Two structural gaps remain. MyTerms expects both sides to hold a record, and PDPP defines only the authorization server's copy. MyTerms allows the second party to counter-offer before agreement, and a PDPP grant is issued after consent rather than negotiated within the protocol.

**What would create incompatibility:** Inventing a PDPP-specific vocabulary for terms that a roster already names. If PDPP grows a closed enum or a bespoke free-text scheme for purpose and retention semantics, then two grants expressing the same real-world terms become machine-incomparable across deployments, which is the exact failure the roster model exists to prevent. PDPP does not have that problem today because `purpose_code` is an absolute URI the AS MUST accept without recognizing it, so an external identifier is already expressible.

**Positive path:** A grant MAY carry a rostered MyTerms agreement identifier as its `purpose_code`, or alongside it, without any schema change, because a rostered term is already a dereferenceable URI and `purpose_code` already accepts one. The W3C Data Privacy Vocabulary community group publishes an "Extension for IEEE P7012" that models the same objects PDPP would need to bridge — `Agreement`, `AgreementRegistry`, and `AgreementInteractionRecord` — and recommends ODRL for expressing term content, so a mapping has somewhere to land rather than needing to be invented. The cheap hedge is therefore to reference rostered terms rather than mint our own vocabulary, and to keep `purpose_code` open to unrecognized URIs.

**v0.1 posture:** Informative. No Core change. Nothing in v0.1 forecloses a later `terms_ref` field or a MyTerms profile, and the roster is currently too small and the second-party record format too unsettled to depend on.

### Bulk export as a distinct access path

_Newly deferred (2026-09-02; raised in the 2026-08-19 working session)._

**Description:** PDPP has focused on continuous synchronization rather than a Takeout-style bulk export. The question raised was whether export deserves its own defined access path rather than being left as a special case of query.

**Why it is open:** Core already has owner-token self-export as a SHOULD-level resource server conformance item (Section 9), so the primitive exists. What does not exist is a defined export path for a client under a grant, or an answer to whether a bulk export differs from paginating the same query to its end in anything other than convenience.

**v0.1 posture:** Owner self-export is in scope at SHOULD level. Client-side bulk export is not defined and is served, if at all, by ordinary paginated query under the grant.

### Trust Registry Query Protocol (TRQP) as the register interface

_Newly deferred (2026-09-02)._

**Description:** ToIP's Trust Registry Query Protocol is a read-only interface for asking "is X authorized to do Y in this ecosystem", and registries using it can recognize one another. That is the shape of the question an authorization server asks about a source declaration under Section 6, and the shape of what the PDP-Connect register answers.

**Why it is open:** TRQP is in public review and has no test suite, so it cannot be a dated commitment. The design question for the specification is narrower than adoption. Core could describe the register lookup in terms general enough that a TRQP endpoint is one conforming implementation of it. The alternative is a PDP-Connect-specific interface that a TRQP endpoint would then have to be adapted to.

**v0.1 posture:** Core does not define a register interface, so nothing in v0.1 forecloses this. Trust registry and connector certification are already listed as deferred in Core Section 12.

**Design constraint for a future version:** If the register is exposed as a TRQP endpoint from phase 2, recognition of another registry becomes a TRQP query rather than a bilateral arrangement. Withdrawal of recognition then propagates through that same query path. Any interface Core describes in the meantime should not assume a single register.

**Where it would live:** In a profile or binding, not in Core's normative text. Core states what an authorization server establishes about a source declaration before accepting it; it does not name the protocol by which the server asks a third party. Naming TRQP in Core would bind the specification to a document still in public review and without a test suite. Naming it in a binding keeps the commitment real without dating it, and matches how this specification treats other binding-level mechanisms.

### Owner-operated authorization server over a platform's data (UMA-style)

_Newly deferred (2026-09-02)._

**Description:** A topology in which the platform continues to hold the owner's data, but the owner runs their own authorization server in front of it, so that the owner's server — not the platform's — decides who may read what. This is the arrangement UMA describes, and it is distinct from the on-behalf-of chain in Core Section 3, where a personal server holds an ordinary grant against the platform and the two relationships stay separate.

**Why it is open:** It requires the platform's resource server to accept grants issued by an authorization server the platform does not operate and did not choose. That is a trust relationship PDPP does not currently define, and one platforms have no incentive to accept unilaterally. It also needs a rule for what happens when the platform's own policy and the owner's authorization server disagree.

**v0.1 posture:** Not introduced. Core's Section 3 topologies are source-native fulfillment, personal-server fulfillment, and the on-behalf-of chain that follows from them. This is a fourth arrangement, and its absence from Core is deliberate rather than an oversight.

---

## Decided (recorded for history)

These concerns were raised during design and review and were resolved by adopting an explicit v0.1 design constraint. They are not open questions; they are recorded here for the rationale trail.

### Grant identity and trust

_Previously deferred (carried forward): concerns that constrain semantic choices._

**Finding (independent review):** The grant has no `issuer`, `subject`, `audience`, or signature. Without these, grants can be forged, replayed, or misrouted.

**Semantic implication:** The grant object needs to be *signable*. This means:
- Avoid mutable fields in the grant (review flagged `status` — it's runtime state, not part of the consent)
- The grant should be a snapshot of what was consented, not a live object
- Fields like `profile` that reference external state (the manifest) should be expanded at consent time, not resolved at runtime — already done in the spec

**Design constraint for v0.1:** Keep the grant immutable and self-contained. Add `subject` and `client` identity fields even if we don't sign them yet. This makes future signing non-breaking.

### Wildcard consent expansion (`streams: [{ "name": "*" }]`)

_Previously deferred (carried forward): concerns that constrain semantic choices._

**Finding (independent review):** A wildcard consent can be misread as a live pointer that grows with future manifest changes. That would make a grant silently widen over time.

**Semantic implication:** A grant should represent a fixed set of consented access, not a pointer that grows. The only defensible v0.1 behavior is expansion at consent time into an explicit list of stream names. New streams introduced by later manifest versions require re-consent.

**Design constraint for v0.1:** Wildcard stream requests expand at consent time and are frozen in the issued grant. Future stream types are not silently included.

### Purpose declarations and registry evolution

_Previously deferred (carried forward): concerns that constrain semantic choices._

**Finding (independent review):** Free-form purpose text alone is not enough for localization, audit, or policy.

**Semantic implication:** In PDPP, purpose is best understood primarily as a structured policy declaration. `purpose_code` supports consent display, audit, registration policy, and limited protocol rules. It should not be described as generic downstream-use enforcement at the RS layer. Only explicitly named cases such as `ai_training` should carry protocol-level consent requirements.

**Design constraint for v0.1:** Keep `purpose_code` plus `purpose_description`. Future work is registry evolution and profile-specific policy binding, not pretending every purpose code is self-enforcing.

### Retention semantics

_Previously deferred (carried forward): concerns that constrain semantic choices._

**Finding (independent review):** `retention` with `on_expiry: "delete"` is a policy expectation, not a DRM mechanism. There's no enforcement.

**Semantic implication:** The spec should be honest about what `retention` means: it is a structured policy declaration and policy commitment the recipient agrees to as part of the grant, enforceable through legal/contractual means and potentially through trust-registry verification, but not technically enforced by the protocol.

**Design constraint for v0.1:** Keep `retention` in the spec but document it as a structured policy field, not a technical control. This is consistent with how Open Banking handles it.

### Source-binding unification (`connector_id`/`provider_id` → `source`)

_Recorded 2026-07-06; change implemented 2026-04-30._

Earlier drafts of spec-core defined a top-level `connector_id` scalar (and the reference contract a sibling `provider_id`) as the request/grant source-identity field. These were unified into a `source` object. A request requires `source.id` and may supply `source.kind`; a resolved grant requires both. This was a breaking change to the request and grant contract, implemented via the archived OpenSpec change `2026-04-30-unify-source-binding-vocabulary`. The former scalars survive only as kind-keyed meanings of `source.id`, never as top-level request or grant fields; a request carrying a top-level `connector_id` or `provider_id` is rejected with 400 `invalid_request`. The spec-core text was aligned with the implemented contract on 2026-07-06.

### Stream dependencies and binary data

_Previously deferred (carried forward): concerns that affect implementation but not semantics. Retired 2026-07-06: implemented._

**Finding (independent review):** Personal data is often graphs + binaries (conversations→messages→attachments, albums→photos). No stream dependency model, no blob/file transport.

**Resolution:** The gap is closed. spec-core Section 5 defines `relationships` (the declared foreign-key graph), Section 8 defines `expand[]` / `expand_limit` for declaration-driven relation expansion, and Section 4 defines `blob_ref` (binary data) and `resource_ref` (cross-stream pointers). Implemented in the reference (record expansion helpers, read-route expand handling, blob read operation). The shipped design uses manifest-declared `relationships` rather than this entry's proposed `depends_on`, and binary transport is a stored reference with authorized fetch rather than a BLOB message type. Remaining open sliver: expansion depth is fixed at 1; multi-hop expansion is not defined.

### Browser capability protocol

_Previously deferred (carried forward): concerns that affect implementation but not semantics. Retired 2026-07-06: implemented._

**Finding (independent review):** The BROWSER JSONL protocol is too dangerous (script injection) and too small (missing most Playwright features). Suggested alternative: expose a CDP WebSocket URL in the START message and let connectors use standard CDP clients.

**Finding (independent review):** `evaluate` makes portability and security worse. Either define a real browser capability layer or keep it out of the portable core spec.

**Resolution:** Both asks are adopted. The manifest declares `runtime_requirements` (Collection Profile Section 2), and browser automation is the standard `browser_automation` binding carrying `{ interface: "cdp", ws_url }`: connectors drive a runtime-managed browser through standard CDP clients rather than a bespoke JSONL browser protocol. Implemented in the reference (manifest validation, runtime binding matching, CDP adapter). The JSONL `evaluate` mechanism stays out of the portable core.

### Secret handling

_Previously deferred (carried forward): concerns that affect implementation but not semantics. Retired 2026-07-06: adopted as normative conformance items._

**Resolution:** No-secrets-in-STATE and no-credential-logging are normative conformance items in the Collection Profile (connector conformance item 5: no secrets in STATE; runtime conformance item 9: no credential logging or persistence from INTERACTION_RESPONSE) and spec-core Section 10 (credential handling). The remaining piece, STATE versioning for connector upgrades, is tracked as its own entry under Implementation TODOs.

### Historical corrections (mostly resolved)

_Previously deferred (carried forward)._

Many of the March 2026 naming and semantic-precision corrections identified during early review have since been incorporated into the live v0.1 draft: URI-based `type`, `connector_id`, `access_mode`, inclusive/exclusive `time_range`, START `state` as a per-stream map, `StreamRequest`/`StreamGrant` separation for `necessity`, compound-key ordering, and field-allowlist behavior.

The main still-live issue from that pass is not terminology but default posture: whether v0.1 remains too permissive when selectors are omitted. See "Privacy-hostile defaults" under Open design questions above.

---

## Implementation TODOs (v0.2 candidates)

These are concrete, scoped work items. The semantic spec doesn't need to change for these.

### Grant signing and transport

_Previously deferred (carried forward): concerns that affect implementation but not semantics._

- JWS/JWT signed grants
- PAR (Pushed Authorization Requests) for large authorization_details
- Token introspection for grant status checks
- Tamper protection for front-channel requests

**Action:** Add a "Security Considerations" section to the spec acknowledging these. No semantic changes needed.

### STATE versioning

_Split out of the retired Secret handling entry (2026-07-06); originally raised as "State needs versioning for connector upgrades"._

STATE has no version or migration mechanism in the Collection Profile or the reference runtime: a connector upgrade that changes its STATE shape has no defined way to detect or migrate old checkpoints. Candidate for v0.2.

### Mid-run cancellation

_Previously deferred (carried forward): concerns that affect implementation but not semantics._

**Finding (independent review):** No way to cancel a running collection (e.g., on grant revocation). Need a CANCEL message.

**Action:** The v0.1 fallback is implemented, not planned: the runtime terminates the connector process, with graceful termination escalating to SIGKILL. The open item is a protocol-level CANCEL message with acknowledgment and partial-result semantics; candidate for v0.2.

### Record-level errors

_Previously deferred (carried forward): concerns that affect implementation but not semantics._

**Finding (independent review):** No way to report partial failures (1 of 1000 records failed). Currently all-or-nothing.

**Action:** Add RECORD_ERROR or error field on RECORD in v0.2.
