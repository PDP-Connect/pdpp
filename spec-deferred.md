# Spec v2: Deferred Concerns

Status: Informational (non-normative; tracking document for future versions)
Date: 2026-04-06 (revised)

Issues identified during design and review that are intentionally out of scope for v0.1. Each item is named precisely so it can be referenced from the core spec and tracked for future versions.

This document mixes three kinds of entries, now split into three sections:

- **Open design questions** — genuinely unresolved concerns. The spec should be designed so these can be added later without breaking changes, but no v0.1 design constraint has been adopted yet.
- **Decided (recorded for history)** — concerns that were raised during design and review and were resolved by adopting an explicit v0.1 design constraint. These are recorded here for the rationale trail, not because they are still open.
- **Implementation TODOs (v0.2 candidates)** — concrete, scoped work items that don't require resolving a semantic design question first.

Dated batch attributions (`Newly deferred (...)`, `Finding (Codex)`, `Finding (Gemini)`, etc.) are preserved inside each entry as originally written.

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

_Historical corrections (mostly resolved) — the main still-live issue from the March 2026 review pass._

Many of the March 2026 naming and semantic-precision corrections identified during early review have since been incorporated into the live v0.1 draft: URI-based `type`, `connector_id`, `access_mode`, inclusive/exclusive `time_range`, START `state` as a per-stream map, `StreamRequest`/`StreamGrant` separation for `necessity`, compound-key ordering, and field-allowlist behavior.

The main still-live issue from that pass is not terminology but default posture: whether v0.1 remains too permissive when selectors are omitted.

**Finding (Codex):** Omitting selectors means "all available data", `necessity` defaults to `required`, `"name": "*"` means all streams. These defaults favor maximum data collection.

**Semantic question:** Should the spec default to maximum or minimum data? Open Banking defaults to minimum (you must explicitly list permissions). OAuth defaults to maximum (scopes grant broad access). For personal data portability, the Open Banking approach (explicit, minimal) is more defensible.

**Options:**
1. Keep current defaults (maximum) but require explicit opt-in for wildcards — already somewhat true since `"*"` must be specified
2. Change defaults to minimum — no streams means no data, every stream must be listed
3. Keep as-is but document the rationale

This is a design philosophy question, not just a technical one.

---

## Decided (recorded for history)

These concerns were raised during design and review and were resolved by adopting an explicit v0.1 design constraint. They are not open questions; they are recorded here for the rationale trail.

### Grant identity and trust

_Previously deferred (carried forward) — concerns that constrain semantic choices._

**Finding (Codex):** The grant has no `issuer`, `subject`, `audience`, or signature. Without these, grants can be forged, replayed, or misrouted.

**Semantic implication:** The grant object needs to be *signable*. This means:
- Avoid mutable fields in the grant (Codex flagged `status` — it's runtime state, not part of the consent)
- The grant should be a snapshot of what was consented, not a live object
- Fields like `profile` that reference external state (the manifest) should be expanded at consent time, not resolved at runtime — already done in the spec

**Design constraint for v0.1:** Keep the grant immutable and self-contained. Add `subject` and `client` identity fields even if we don't sign them yet. This makes future signing non-breaking.

### Wildcard consent expansion (`streams: [{ "name": "*" }]`)

_Previously deferred (carried forward) — concerns that constrain semantic choices._

**Finding (Codex):** A wildcard consent can be misread as a live pointer that grows with future manifest changes. That would make a grant silently widen over time.

**Semantic implication:** A grant should represent a fixed set of consented access, not a pointer that grows. The only defensible v0.1 behavior is expansion at consent time into an explicit list of stream names. New streams introduced by later manifest versions require re-consent.

**Design constraint for v0.1:** Wildcard stream requests expand at consent time and are frozen in the issued grant. Future stream types are not silently included.

### Purpose declarations and registry evolution

_Previously deferred (carried forward) — concerns that constrain semantic choices._

**Finding (Codex):** Free-form purpose text alone is not enough for localization, audit, or policy.

**Semantic implication:** In PDPP, purpose is best understood primarily as a structured policy declaration. `purpose_code` supports consent display, audit, registration policy, and limited protocol rules. It should not be described as generic downstream-use enforcement at the RS layer. Only explicitly named cases such as `ai_training` should carry protocol-level consent requirements.

**Design constraint for v0.1:** Keep `purpose_code` plus `purpose_description`. Future work is registry evolution and profile-specific policy binding, not pretending every purpose code is self-enforcing.

### Retention semantics

_Previously deferred (carried forward) — concerns that constrain semantic choices._

**Finding (Gemini):** `retention` with `on_expiry: "delete"` is a policy expectation, not a DRM mechanism. There's no enforcement.

**Semantic implication:** The spec should be honest about what `retention` means: it is a structured policy declaration and policy commitment the recipient agrees to as part of the grant, enforceable through legal/contractual means and potentially through trust-registry verification, but not technically enforced by the protocol.

**Design constraint for v0.1:** Keep `retention` in the spec but document it as a structured policy field, not a technical control. This is consistent with how Open Banking handles it.

### Source-binding unification (`connector_id`/`provider_id` → `source: { kind, id }`)

_Recorded 2026-07-06; change implemented 2026-04-30._

Earlier drafts of spec-core defined a top-level `connector_id` scalar (and the reference contract a sibling `provider_id`) as the request/grant source-identity field. These were unified into the single discriminated `source: { kind: "connector" | "provider_native", id }` object — a breaking change to the request and grant contract, implemented via the archived OpenSpec change `2026-04-30-unify-source-binding-vocabulary`. The former scalars survive only as the kind-keyed meanings of `source.id`, never as top-level request or grant fields; a request carrying a top-level `connector_id` or `provider_id` is rejected with 400 `invalid_request`. The spec-core text was aligned with the implemented contract on 2026-07-06.

### Historical corrections (mostly resolved)

_Previously deferred (carried forward)._

Many of the March 2026 naming and semantic-precision corrections identified during early review have since been incorporated into the live v0.1 draft: URI-based `type`, `connector_id`, `access_mode`, inclusive/exclusive `time_range`, START `state` as a per-stream map, `StreamRequest`/`StreamGrant` separation for `necessity`, compound-key ordering, and field-allowlist behavior.

The main still-live issue from that pass is not terminology but default posture: whether v0.1 remains too permissive when selectors are omitted. See "Privacy-hostile defaults" under Open design questions above.

---

## Implementation TODOs (v0.2 candidates)

These are concrete, scoped work items. The semantic spec doesn't need to change for these.

### Grant signing and transport

_Previously deferred (carried forward) — concerns that affect implementation but not semantics._

- JWS/JWT signed grants
- PAR (Pushed Authorization Requests) for large authorization_details
- Token introspection for grant status checks
- Tamper protection for front-channel requests

**Action:** Add a "Security Considerations" section to the spec acknowledging these. No semantic changes needed.

### Browser capability protocol

_Previously deferred (carried forward) — concerns that affect implementation but not semantics._

**Finding (Gemini):** The BROWSER JSONL protocol is too dangerous (script injection) and too small (missing most Playwright features). Suggested alternative: expose a CDP WebSocket URL in the START message and let connectors use standard CDP clients.

**Finding (Codex):** `evaluate` makes portability and security worse. Either define a real browser capability layer or keep it out of the portable core spec.

**Semantic implication:** None for the grant/selection/manifest. The browser protocol is a runtime concern. But the manifest's `capabilities.browser` declaration is semantic — it should be renamed to `runtime_requirements.browser` per Gemini's suggestion.

**Action:** For v0.1 implementation, use the v1 adapter for browser connectors. Defer the v2 browser protocol. Note in the spec that browser automation is runtime-specific and will be specified separately.

### Secret handling

_Previously deferred (carried forward) — concerns that affect implementation but not semantics._

- Passwords and OTP codes in HUMAN_RESPONSE should not be logged or persisted
- Tokens should not be stored in STATE (use a separate encrypted runtime store)
- State needs versioning for connector upgrades

**Action:** Add "Security Considerations" notes. Implementation concern, not semantic.

### Stream dependencies and binary data

_Previously deferred (carried forward) — concerns that affect implementation but not semantics._

**Finding (Codex):** Personal data is often graphs + binaries (conversations→messages→attachments, albums→photos). No stream dependency model, no blob/file transport.

**Semantic implication:** This is a real gap but adding it to v0.1 would significantly increase complexity. For the demo, flat JSON streams are sufficient. When we need relationships, we can add:
- `depends_on: "conversations"` to a stream definition
- A `BLOB` message type for binary data with a file reference

**Action:** Defer. Document as a known limitation.

### Mid-run cancellation

_Previously deferred (carried forward) — concerns that affect implementation but not semantics._

**Finding (Gemini):** No way to cancel a running collection (e.g., on grant revocation). Need a CANCEL message.

**Action:** Add to v0.2. For v0.1, the runtime can kill the process.

### Record-level errors

_Previously deferred (carried forward) — concerns that affect implementation but not semantics._

**Finding (Gemini):** No way to report partial failures (1 of 1000 records failed). Currently all-or-nothing.

**Action:** Add RECORD_ERROR or error field on RECORD in v0.2.
