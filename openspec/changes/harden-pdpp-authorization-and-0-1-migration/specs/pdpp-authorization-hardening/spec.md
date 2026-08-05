## ADDED Requirements

### Requirement: Authenticated introspection SHALL return a complete PDPPAuthorizationContext via RFC 9396 authorization_details plus a minimal pdpp member

For separated AS/RS deployments, the RS-facing introspection/context-resolution response defined in spec-core.md Section 8 (`### Token introspection`) SHALL be authenticated at the caller level and SHALL return a complete authorization context sufficient to run the grant-enforcement algorithm in Section 8 (`### Grant enforcement`), not the five extension fields (`active`, `pdpp_token_kind`, `subject_id`, `grant_id`, `client_id`, `exp`) currently listed as the complete PDPP extension-fields table. That table omits every constraint the RS's own enforcement steps 3-4 (stream membership, `time_range`, `fields`, `resources`) already require it to have, and omits issuer, audience, and proof/binding context entirely.

The normalized, approved selection (the streams/fields/time_range/resources projection the grant actually authorizes) SHALL be carried in the response's `authorization_details` member, using the same RFC 9396 `authorization_details` carrier already normative for the client's authorization request (spec-core.md Section 5), rather than as a second, PDPP-proprietary shadow copy of the same data. RFC 9396 Section 9.2 registers `authorization_details` as a top-level RFC 7662 introspection-response member and Section 14.3 profiles its IANA registration; this specification adopts that standard carrier rather than treating it as PDPP-specific transport.

A separate, small `pdpp` supplementary member on the same introspection response SHALL carry only facts `authorization_details` cannot express:

- immutable grant identity (`grant_id`, `grant_digest`);
- grant lifecycle state (`status`, `consumed_at`, `superseded_by`);
- a consent-evidence reference;
- the security/binding profile in effect for the token being introspected;
- a `cache_until` (or equivalent) bound consistent with the existing `min(token_exp, 60 seconds)` cache ceiling.

The `pdpp` member SHALL NOT duplicate any field already expressible in `authorization_details` (no shadow copy of streams, fields, time ranges, or resources).

Beyond the `authorization_details` and `pdpp` members, the response SHALL also carry (as standard RFC 7662 top-level members) `iss` (issuer) and `aud` (the exact resource-server audience), and, when the token's presentation mode is sender-constrained, the key-confirmation (`cnf`) needed to validate the token against the presented proof. Before serving a request, the RS SHALL verify, from this complete context: issuer and exact audience; access-token presentation mode and, where sender-constrained, the proof key via `cnf`; binding/security-profile with no downgrade from what the grant recorded at issuance; client/subject/source/grant-identity (`grant_id`/`grant_digest`) consistency; current grant lifecycle state and cache freshness; and that the requested operation is within the intersection of the request and the returned `authorization_details`. If the response omits any of these required facts, or if it carries a mandatory field or extension the RS does not recognize, the RS SHALL treat the token as unauthorized (fail closed) rather than proceeding with a partial context, consistent with the existing unrecognized-`pdpp_token_kind` fail-closed rule in Section 8.

Unauthenticated introspection callers SHALL be refused. Bearer-only (unauthenticated) access to the introspection/context-resolution endpoint is prohibited; the AS SHALL authenticate the RS as an introspection caller before returning any authorization context.

**Change class:** repairs an existing interoperability/security hole

#### Scenario: Authenticated RS receives a complete authorization context

- **WHEN** an authenticated RS calls the introspection endpoint for a valid, active token
- **THEN** the response includes the normalized approved selection in the RFC-9396-registered `authorization_details` member
- **AND** a distinct `pdpp` member carries only grant identity, lifecycle state, consent-evidence reference, and security/binding profile, with no duplicate copy of the streams/fields/time_range/resources already present in `authorization_details`

#### Scenario: An incomplete context fails closed

- **WHEN** the RS receives a context response missing any of issuer, exact audience, proof-mode/`cnf` (for sender-constrained tokens), binding/security-profile, client/subject/source/grant-identity consistency, current grant state, or cache freshness
- **THEN** the RS SHALL reject the request rather than serve it against a partial context

#### Scenario: Unrecognized mandatory context field fails closed

- **WHEN** the introspection/context response includes a mandatory extension or constraint the RS does not recognize
- **THEN** the RS SHALL treat the token as unauthorized rather than silently ignore the unrecognized field

#### Scenario: Unauthenticated introspection is refused

- **WHEN** a caller attempts to call the introspection/context-resolution endpoint without RS-level authentication
- **THEN** the AS SHALL refuse the call

### Requirement: DPoP proof validation duty SHALL be split between the RS and the introspection response, with private_key_jwt correctly attributed

Where a deployment uses DPoP (RFC 9449) as a sender-constrained token presentation mode, the resource server alone SHALL validate the DPoP proof against the actual protected-resource request. Per RFC 9449 Sections 4-7, the RS's per-request validation SHALL include: `htm` (HTTP method), `htu` (HTTP target URI), `iat` (proof freshness), `ath` (access-token hash binding the proof to the specific presented token), and replay/freshness controls via `nonce` and `jti`. The introspection/context-resolution response defined above SHALL NOT perform this request-specific validation; it SHALL supply only the token's `status` (via `active`) and key-confirmation (`cnf`) information, from which the RS derives the expected proof key. `ath` SHALL be named explicitly as a validated proof claim; it SHALL NOT be left as an implicit consequence of an unelaborated RFC 9449 citation.

A resolver contract signature that includes a `presentation_proof` parameter alongside the presented credential is misleading under this duty split, because the resolver does not validate the request-specific proof; the request-specific proof exists only at the RS, bound to the concrete HTTP request. Any such resolver/introspection interface described in companion documents SHALL either drop `presentation_proof` from the signature or, if retained, SHALL be accompanied by an explicit statement that the resolver forwards it only for logging/diagnostic purposes and performs no request-proof validation with it.

`private_key_jwt` as the client-authentication method for an RS acting as an introspection/context-resolution caller SHALL be attributed to OpenID Connect Core Section 9, which defines the method name and its semantics as a client-authentication method, together with the applicable IANA OAuth client-authentication-method registry entry. RFC 7523 alone SHALL NOT be cited as attribution for `private_key_jwt`, because RFC 7523 defines only the JWT-bearer client-authentication and authorization-grant assertion mechanism composed underneath it, not the named method or its registration. Where a deployment adopts `private_key_jwt` for the separated-RS-to-AS introspection caller, the applicable profile SHALL pin: the required assertion audience (the AS's token/introspection issuer identifier); the required assertion claims (at minimum issuer, subject, audience, expiration, and a unique assertion identifier suitable for single-use replay rejection); and the RS's credential-registration mechanism with the AS (how the RS's signing key or key set is registered and rotated), so that two independent implementations cannot both claim conformance while producing non-interoperable assertions.

**Change class:** repairs an existing interoperability/security hole

#### Scenario: RS alone validates the request-specific DPoP proof

- **WHEN** an RS under a DPoP-based presentation mode receives a protected-resource request accompanied by a DPoP proof
- **THEN** the RS SHALL validate `htm`, `htu`, `iat`, `ath`, and replay/freshness (`nonce`/`jti`) against the actual request
- **AND** the introspection/context-resolution response SHALL supply only `status` and `cnf`, and SHALL NOT itself validate the request-specific proof

#### Scenario: presentation_proof is justified or dropped from the resolver contract

- **WHEN** a resolver/introspection interface contract is specified for DPoP-based deployments
- **THEN** it SHALL either omit a `presentation_proof` parameter from the resolver signature or state explicitly that the resolver does not use it for request-proof validation

#### Scenario: private_key_jwt is attributed and pinned correctly

- **WHEN** a separated-RS introspection caller authenticates using `private_key_jwt`
- **THEN** the specification SHALL cite OpenID Connect Core Section 9 and the IANA client-authentication-method registry as the attribution for the method, not RFC 7523 alone
- **AND** the applicable profile SHALL pin the required assertion audience, the required assertion claims, and the RS's credential-registration mechanism with the AS

### Requirement: Authorization codes SHALL be single-use with no retransmission carve-out

An authorization code issued by the OAuth binding SHALL be redeemable exactly once, per RFC 6749 §4.1.2. A second presentation of an already-redeemed authorization code SHALL be denied with `invalid_grant` (or the OAuth-binding-defined equivalent error), regardless of whether the presenting request carries the same DPoP-bound key (`dpop_jkt`) or proof as the original redemption. Same-key proof SHALL NOT repeal the one-use rule; there SHALL be no idempotency carve-out, of any kind, that permits a second presentation of the same code to yield a successful token response. Where technically possible, the AS SHALL revoke the access and refresh tokens already issued from that code's original redemption when a reuse attempt is detected.

A client that fails to receive the token-endpoint response after a successful redemption (a lost response) SHALL NOT recover by re-presenting the same authorization code and expecting a second successful redemption. Lost-response recovery, if a binding chooses to support it, SHALL be defined as a separately named transaction-result or idempotency extension that is bound to the original committed issuance transaction and that never re-triggers grant or credential issuance from the same code. In the absence of such an extension, a lost response after successful redemption SHALL require a fresh authorization interaction to obtain a new code.

**Change class:** repairs an existing interoperability/security hole

#### Scenario: A redeemed authorization code is presented a second time

- **WHEN** a client presents an authorization code that the AS has already successfully redeemed for tokens
- **THEN** the AS SHALL respond with `invalid_grant` (or the OAuth-binding-defined equivalent error) and SHALL NOT issue a new token response
- **AND** the AS SHALL NOT vary this outcome based on whether the second presentation carries proof of the same DPoP-bound key used in the original redemption

#### Scenario: Reuse of a redeemed code triggers revocation of previously issued tokens

- **WHEN** the AS denies a reused authorization code under the prior scenario
- **THEN** the AS SHALL revoke the access token and, if issued, the refresh token that were produced by that code's original redemption, where technically possible

#### Scenario: Lost-response recovery never performs a second redemption

- **WHEN** a client fails to receive the token-endpoint response after a redemption that the AS committed
- **AND** no separately defined transaction-result or idempotency extension bound to that committed issuance is in effect
- **THEN** the client SHALL obtain a new authorization code through a fresh authorization interaction rather than re-presenting the original code
- **AND** any re-presentation of the original code SHALL be treated as reuse under the first scenario, not as idempotent retransmission

### Requirement: Refresh-token replay responses SHALL be a closed, discoverable set, and refresh retransmission SHALL have a defined oracle

When the OAuth binding supports refresh tokens for a continuous grant's credential family, the AS SHALL rotate the refresh token on every successful use and SHALL invalidate the prior generation. Detection of reuse of an invalidated refresh-token generation (replay) SHALL trigger exactly one response drawn from a closed, metadata-declared, discoverable enumeration of permitted replay responses; a conformant AS SHALL NOT invent or select an undeclared response, and the specification SHALL NOT describe the permitted response set as open-ended or as an "equivalent response" left to implementation discretion. Each enumerated replay response SHALL have precisely defined effects on the credential family's active tokens and lifecycle state.

The binding SHALL also define the AS's required behavior when a client retransmits the same refresh-token-rotation request after failing to receive the rotation response (a lost response), distinguishing that case from replay of an already-superseded generation. This retransmission rule SHALL give conformance tests a defined expected outcome for the lost-response case; it SHALL NOT be left unspecified.

**Change class:** repairs an existing interoperability/security hole

#### Scenario: Reuse of an invalidated refresh-token generation is met with a declared response

- **WHEN** the AS detects presentation of a refresh token from a generation already superseded by rotation
- **THEN** the AS SHALL apply exactly one response from the closed, metadata-declared enumeration of permitted replay responses
- **AND** the AS SHALL NOT apply any response outside that enumeration

#### Scenario: Retransmission of the same rotation request after a lost response has a defined outcome

- **WHEN** a client retransmits the identical refresh-token-rotation request because it did not receive the AS's rotation response to its immediately prior request
- **THEN** the AS's required behavior SHALL be the behavior the binding specifies for this case
- **AND** that behavior SHALL be distinguishable, by specification and by test, from the behavior required when a superseded generation is replayed

#### Scenario: Conformance tests assert each declared replay response

- **WHEN** conformance tests are derived from the closed replay-response enumeration
- **THEN** each enumerated response SHALL have a corresponding test asserting its declared effect on the credential family

### Requirement: Keyless credential-family recovery SHALL require fresh authorization or owner-authenticated suspend-and-recover, never self-qualification by the lost key alone

For a continuous credential family bound to a client-held key (for example, a DPoP-bound family), the OAuth binding SHALL distinguish cryptographic key rotation from keyless recovery and SHALL apply distinct requirements to each:

1. **Rotation (old key possessed).** Possession of the currently active key SHALL permit rotation to a new key under the existing conditions already required for runtime key and instance replacement: the same authenticated protocol client requests the change; the accountable entity and software product are unchanged; the new credential is no broader and carries the same RS audience; the event is recorded in the immutable lifecycle audit; and old-key credentials become inactive within the declared propagation bound.

2. **Recovery (old key not presented).** When a client requests replacement of a continuous family's key without presenting proof of the currently active key, the AS SHALL require EITHER (a) a fresh, user-facing authorization interaction that re-establishes the grant's authority, OR (b) suspension of further issuance under the affected family, followed by an owner-authenticated recovery process, followed by notification to the owner that includes a bounded revocation window during which the owner may reject the recovery. No third path SHALL satisfy this requirement; in particular, an undefined "AS policy event" or "equivalent strong client reauthentication" SHALL NOT itself constitute sufficient recovery assurance.

3. **Public clients cannot self-qualify.** When the requesting client is a public or unregistered client whose only persistent authenticator was the key being replaced, that client's own (re-)authentication SHALL NOT itself satisfy the recovery-assurance requirement in item 2; recovery for such a client SHALL proceed only through path (a) or path (b) above, established independently of the lost key.

This keyless-recovery rule SHALL apply without exception to a credential family that has transitioned to a replay-detected state; entering that state SHALL NOT be treated as a trigger that permits bypassing paths (a) or (b) above.

This rule identifies security-critical recovery policy that v0.1 and the current design left unspecified; it does not assert that any deployment has exercised an undefined recovery path.

**Change class:** repairs an existing interoperability/security hole

#### Scenario: Rotation with old-key proof proceeds under the existing conditions

- **WHEN** a client presents proof of the currently active key together with a request to rotate to a new key
- **AND** the same authenticated protocol client, unchanged accountable entity and product, no-broadening, and same-audience conditions all hold
- **THEN** the AS SHALL permit the rotation, record the event in the immutable lifecycle audit, and require old-key credentials to become inactive within the declared propagation bound

#### Scenario: Keyless recovery requires fresh authorization or suspend-plus-owner-recovery

- **WHEN** a client requests key replacement for a continuous credential family without presenting proof of the currently active key
- **THEN** the AS SHALL require either a fresh user-facing authorization interaction, or suspension of issuance under that family followed by an owner-authenticated recovery process and owner notification with a revocation window
- **AND** the AS SHALL NOT complete the key replacement through any other path

#### Scenario: A public client cannot recover using only the lost key as its own authenticator

- **WHEN** the requesting client is a public or unregistered client whose sole persistent authenticator was the key being replaced
- **THEN** that client's self-authentication SHALL NOT satisfy the recovery-assurance requirement
- **AND** recovery SHALL proceed only via fresh user authorization or the suspend-plus-owner-authenticated-recovery path

#### Scenario: Replay-detected state does not create a recovery bypass

- **WHEN** a credential family has transitioned to a replay-detected state
- **THEN** the keyless-recovery requirements of this rule SHALL still apply in full
- **AND** no policy event SHALL substitute for fresh authorization or the suspend-plus-owner-authenticated-recovery path

### Requirement: A source declaration SHALL be able to declare a minimum credential-security profile

A source declaration (the manifest described in Section 7, Manifest Format) SHALL be able to declare a minimum credential-security profile: a floor stating the weakest class of access-token presentation the source's protected resource will accept. This is new normative surface. Nothing in the current v0.1 manifest fields table (Section 7, Manifest fields) carries any such floor, and Section 10's existing bearer-vs-sender-constrained discussion ("Sender-constrained tokens (informative)") is SHOULD-level and does not let a source require anything.

The floor SHALL be a manifest-level field, not a per-stream field: credential-security posture is a property of the resource server guarding the source's data, not of an individual stream within it. A manifest that declares no minimum credential-security profile SHALL be treated as declaring no floor (the v0.1 baseline: bearer-token presentation, RFC 6750, remains acceptable).

This requirement defines only the existence, scope, and binding-independent meaning of the floor as a declarable fact. It does NOT define the concrete set of named credential-security profile identifiers (for example, an OAuth-binding-specific DPoP-only label or a bearer-compatibility-mode label): those identifiers are binding-specific and are out of scope for this profile-independent core requirement. It also does NOT decide whether any sender-constrained presentation mode is mandatory to implement in general; a source MAY declare a floor today even though, in the current reference, bearer-token presentation is the only implemented presentation mode, and MAY choose not to declare one.

**Change class:** introduces a genuinely new normative capability

#### Scenario: A manifest declares a minimum credential-security profile

- **WHEN** a source's manifest declares a minimum credential-security profile
- **THEN** that declaration SHALL apply to every stream served under that source's protected resource
- **AND** the declaration SHALL be visible to both the authorization server and the resource server enforcing that source, not private configuration known only to one

#### Scenario: Absence of a declared floor preserves the v0.1 baseline

- **WHEN** a source's manifest declares no minimum credential-security profile
- **THEN** bearer-token presentation (RFC 6750) SHALL remain an acceptable presentation mode for that source's grants
- **AND** no requirement in this section SHALL be read as retroactively requiring a floor where none is declared

### Requirement: The authorization server SHALL refuse to issue below a declared credential-security floor

When a source declares a minimum credential-security profile, the authorization server SHALL refuse to issue an authorization or access token whose presentation mode is weaker than that declared floor. This upgrades the presupposed but previously undefined gate: the current design implies a policy check at authorization time but states no obligation level for it, and provides the declaring source no enforceable guarantee. The authorization server MUST NOT downgrade an already-issued grant's presentation mode below the floor declared at issuance time, either.

Refusal SHALL use the ordinary grant/token error path (an authorization or token error indicating the requested presentation mode is not permitted for the source), not a silent downgrade and not a silent issuance under the weaker mode.

**Change class:** repairs an existing interoperability/security hole

#### Scenario: The authorization server rejects a below-floor authorization request

- **WHEN** a client requests authorization selecting a presentation mode weaker than the source's declared minimum credential-security profile
- **THEN** the authorization server SHALL refuse to issue the authorization or access token for that request
- **AND** SHALL return an error rather than silently issuing under the weaker mode or silently upgrading the request to the declared floor

#### Scenario: A source with no declared floor imposes no refusal obligation

- **WHEN** a client requests authorization against a source whose manifest declares no minimum credential-security profile
- **THEN** this requirement SHALL NOT obligate the authorization server to refuse any presentation mode on that basis

### Requirement: The resource server SHALL reject authorization contexts below its declared floor

When a source declares a minimum credential-security profile, the resource server enforcing that source SHALL reject a request whose resolved authorization context reports a presentation mode weaker than the declared floor. This is a MUST-level obligation, not a MAY: the resource server's enforcement is the last line of defense against a token that was issued (whether through authorization-server error, a downstream compromise, or a context resolved under a different, permissive source's rules) below the floor the source itself requires.

This rejection SHALL be independent of, and in addition to, the authorization server's issuance-time refusal in the preceding requirement: an authorization server refusing to issue below the floor does not relieve the resource server of its own obligation to check the resolved context at request time, per the existing Trust boundary responsibilities division of labor (Section 10) under which the resource server never re-validates beyond introspection but does enforce what introspection reports.

**Change class:** repairs an existing interoperability/security hole

#### Scenario: The resource server rejects a request presented below the declared floor

- **WHEN** a resource server resolves an authorization context whose presentation mode is weaker than its source's declared minimum credential-security profile
- **THEN** the resource server SHALL reject the request
- **AND** SHALL NOT serve the request under the assumption that the authorization server's issuance-time check already covered this case

#### Scenario: A correctly floored context is served normally

- **WHEN** a resource server resolves an authorization context whose presentation mode meets or exceeds its source's declared minimum credential-security profile
- **THEN** the resource server SHALL proceed with ordinary grant enforcement (stream membership, field projection, time_range, resources) as already specified in Section 8

### Requirement: Consent disclosure of a reduced-theft-resistance presentation mode SHALL be mandatory

When a source permits a weaker, reduced-theft-resistance presentation mode (for example, a bearer-compatibility mode alongside a stronger sender-constrained mode) as one of the modes available for its grants, the authorization server's consent surface SHALL disclose that the selected or selectable weaker mode carries reduced theft-resistance compared to the source's stronger mode, before the user completes authorization. This is a MUST-level obligation. It replaces any framing under which such disclosure is merely optional UI wording: leaving disclosure optional is what allows a client to obtain a materially weaker presentation mode against a source the user believes they are protecting under a stronger one, with the consent surface saying nothing about the difference.

This disclosure requirement composes with, and does not substitute for, the two preceding requirements: a source that declares a minimum credential-security profile excludes the weaker mode entirely (no disclosure question arises, because the mode is refused outright); this disclosure requirement governs the remaining case where a source permits both modes and a weaker mode is nonetheless selectable.

**Change class:** repairs an existing interoperability/security hole

#### Scenario: A weaker presentation mode triggers mandatory disclosure

- **WHEN** a source permits both a stronger sender-constrained presentation mode and a weaker, reduced-theft-resistance presentation mode, and an authorization request would result in the weaker mode being issued
- **THEN** the authorization server's consent surface SHALL disclose the reduced theft-resistance of the weaker mode to the user before authorization completes
- **AND** the authorization server SHALL NOT complete issuance of the weaker mode without having displayed that disclosure

#### Scenario: A floor excludes the weaker mode outright, so no disclosure question arises

- **WHEN** a source declares a minimum credential-security profile that excludes the weaker presentation mode
- **THEN** the weaker mode SHALL already be refused under the authorization-server-refusal requirement above
- **AND** this disclosure requirement imposes no additional obligation for that source, since the weaker mode is never issued

### Requirement: A normative PDPP OAuth 0.1 Migration Profile SHALL resolve the legacy-context enforcement conflict

A normative PDPP OAuth 0.1 Migration Profile SHALL exist as a deliverable of this change, resolving the previously undefined conflict between the common RS enforcement algorithm (Section 8's grant-enforcement steps, which resolve a complete authorization context and fail closed on unknown mandatory constraints) and a `legacy_0_1` authorization context (Section 15.9 item 2 of the controlling architecture decision), whose issuer, exact audience, proof/binding mode, and source-declaration digest are explicitly marked unavailable rather than invented. Prior to this Migration Profile, no spec text stated which of the two rules governs a `legacy_0_1` context, and the required backward-compatibility conformance test had no definable expected result.

The Migration Profile SHALL define exactly one enforcement outcome for a `legacy_0_1` authorization context, distinct from the fail-closed algorithm applied to a context asserting the current binding:

- A `legacy_0_1` context SHALL be recognized only when the RS resolves it as `legacy_0_1` explicitly (a discriminated context kind), never inferred from the mere absence of fields on an otherwise-current-binding context.
- For the specific fields that Section 15.9 item 2 marks unavailable — issuer, exact RS audience, access-token presentation/proof mode, binding and security-profile identity, and source-declaration digest — the RS SHALL accept their absence under the `legacy_0_1` context kind and SHALL NOT fail closed solely because those fields are absent.
- For every other field the common algorithm requires — client, subject, source, and grant-ID/digest consistency; current grant lifecycle state; and cache freshness — a `legacy_0_1` context SHALL be resolved and enforced exactly as the common algorithm requires; these facts are present on a v0.1 grant and their absence, staleness, or mismatch SHALL fail closed under the common algorithm, unchanged by legacy-context handling.
- An RS resolving a `legacy_0_1` context SHALL NOT treat that context as satisfying, or silently substitute it for, an authorization context asserting a sender-constrained (key-bound) security profile; a `legacy_0_1` context SHALL carry only the security properties of an unauthenticated bearer credential (RFC 6750) for authorization purposes.
- A `legacy_0_1` context is accepted only while the deployment's discovery metadata affirmatively signals legacy acceptance (see the following requirement) and only until any operator-set sunset boundary is reached (see the disable/sunset requirement below); outside those bounds the RS SHALL reject the context.

This closes the gap in which a `legacy_0_1` context's declared-missing fields could otherwise be read as satisfying the common algorithm's fail-closed-on-unknown-constraint rule in either direction (over-strict rejection of every existing v0.1 grant, or silent unbounded acceptance).

**Change class:** repairs an existing interoperability/security hole

#### Scenario: A legacy context with the expected missing fields is accepted under legacy rules

- **WHEN** an RS resolves an authorization context that is explicitly discriminated as `legacy_0_1` and whose issuer, exact audience, proof/binding mode, security profile, and source-declaration digest are marked unavailable
- **THEN** the RS SHALL NOT reject the context solely for the absence of those specific fields
- **AND** the RS SHALL still verify client, subject, source, and grant-ID/digest consistency, current grant lifecycle state, and cache freshness, and SHALL fail closed if any of those checks fails

#### Scenario: A legacy context is never mistaken for a sender-constrained context

- **WHEN** an RS resolves a `legacy_0_1` authorization context
- **THEN** the RS SHALL NOT grant that context any of the security properties associated with a sender-constrained (key-bound) presentation mode
- **AND** the RS SHALL treat the presenting credential as an unauthenticated bearer credential for authorization purposes only

#### Scenario: A context missing required facts outside the declared legacy set still fails closed

- **WHEN** an RS resolves an authorization context that is not explicitly discriminated as `legacy_0_1` and that is missing any field the common algorithm requires
- **THEN** the RS SHALL fail closed per the common algorithm's unknown-mandatory-constraint rule
- **AND** the absence of that field SHALL NOT be reinterpreted as an implicit `legacy_0_1` context

### Requirement: An RS SHALL support dual-mode enforcement of v0.1-legacy and current authorization contexts simultaneously

A resource server MAY, and where it accepts any v0.1-issued credential MUST, support two concurrently active enforcement paths distinguished by the discriminated context kind resolved for a given request: the `legacy_0_1` path defined above, and the common algorithm applied to a context asserting the current binding. A single RS deployment SHALL be able to serve both a client presenting a pre-existing v0.1 credential and a client presenting a credential issued under the current binding within the same deployment lifetime, without requiring a deployment-wide cutover.

The RS SHALL determine which path applies solely from the resolved authorization context's discriminated kind, never from token syntax, never from the presence or absence of an `Authorization` header scheme, and never from client-declared version headers alone.

Neither path SHALL widen the other's guarantees: resolving a request under the `legacy_0_1` path SHALL NOT grant access broader than the specific grant's own stored constraints (streams, fields, time range, resources, access mode) permit, and the existence of the `legacy_0_1` path SHALL NOT relax any enforcement step of the common algorithm for a context not discriminated as `legacy_0_1`.

**Change class:** repairs an existing interoperability/security hole

#### Scenario: The RS enforces both paths in the same deployment without cutover

- **WHEN** a deployment holds both a pre-existing v0.1 grant and a grant issued under the current binding, and both are presented for enforcement in the same operating period
- **THEN** the RS SHALL resolve and enforce each independently under its own path
- **AND** SHALL NOT require disabling one path to serve requests under the other

#### Scenario: Path selection never depends on token syntax or headers alone

- **WHEN** the RS selects which enforcement path applies to an incoming request
- **THEN** the selection SHALL be based solely on the discriminated kind of the resolved authorization context
- **AND** SHALL NOT be based on the token's wire format, the presence of a version request header, or any other client-supplied signal alone

### Requirement: A deployment's discovery metadata SHALL explicitly signal whether v0.1 legacy acceptance is active

An AS or protected-resource metadata document SHALL advertise, via an explicit discovery flag, whether the deployment currently accepts `legacy_0_1` authorization contexts, following the existing `pdpp_*_supported`-style discovery convention (e.g. `pdpp_registration_modes_supported`). Absence of this flag, or its explicit value `false`, SHALL be treated as legacy acceptance being off; a deployment SHALL NOT accept a `legacy_0_1` context merely because the flag is unset, and silent indefinite acceptance inferred only from an RS's willingness to resolve older tokens is prohibited.

When the flag indicates legacy acceptance is active, the discovery metadata SHALL also surface the sunset boundary in effect, if any, per the disable/sunset requirement below, so that clients and auditors can determine the acceptance window without an out-of-band inquiry.

**Change class:** repairs an existing interoperability/security hole

#### Scenario: A client checks discovery metadata before relying on legacy acceptance

- **WHEN** a client inspects a deployment's discovery metadata
- **THEN** it SHALL find an explicit flag stating whether `legacy_0_1` contexts are currently accepted
- **AND** if accepted, SHALL find the sunset boundary in effect, if the operator has set one

#### Scenario: Absence of the flag means legacy acceptance is off, not silently on

- **WHEN** a deployment's discovery metadata omits the legacy-acceptance flag, or sets it to false
- **THEN** the RS SHALL reject `legacy_0_1` authorization contexts
- **AND** SHALL NOT infer acceptance from having previously served v0.1-issued credentials

### Requirement: An operator SHALL have a bounded, explicit mechanism to disable acceptance of v0.1 legacy credentials

A deployment SHALL provide an operator-controlled mechanism to stop accepting `legacy_0_1` authorization contexts and any bearer-mode credential accepted only under the legacy/bearer profile, bounded by an explicit and discoverable sunset condition (a stated date, an operator action, or both). This mechanism specifically addresses the two legacy-credential properties that otherwise carry no natural expiry: a grant with a null (`continuous`) `expires_at`, and a non-rotating legacy refresh token (see the refresh-token requirement below), neither of which lapses on its own.

Once the operator has disabled legacy acceptance (whether by reaching a stated sunset date or by an explicit operator action), the RS SHALL reject every subsequent request presenting a `legacy_0_1` context or a legacy-profile bearer credential, and the deployment's discovery metadata SHALL reflect the disabled state per the discovery requirement above. Disabling legacy acceptance SHALL NOT itself delete, rewrite, or reissue the underlying v0.1 grant records; a disabled legacy grant remains an immutable historical record, reachable again only if the owner performs a fresh authorization interaction that supersedes it under the current binding.

**Change class:** repairs an existing interoperability/security hole

#### Scenario: An operator disables legacy acceptance and it takes effect deployment-wide

- **WHEN** an operator invokes the disable mechanism, or a previously configured sunset date is reached
- **THEN** the RS SHALL reject all subsequent `legacy_0_1` contexts and legacy-profile bearer credentials
- **AND** the discovery metadata's legacy-acceptance flag SHALL reflect the disabled state on the next metadata fetch

#### Scenario: A null-expiry legacy grant is not left permanently acceptable by default

- **WHEN** a `continuous` v0.1 grant with a null `expires_at` is the only credential asserting access to a source
- **THEN** the deployment SHALL have an available, documented operator path to bound or end that grant's acceptance
- **AND** that path SHALL NOT depend on the grant's own `expires_at` ever becoming non-null

#### Scenario: Disabling legacy acceptance does not mutate historical grant records

- **WHEN** legacy acceptance is disabled for a deployment
- **THEN** the stored bytes of any pre-existing v0.1 grant SHALL remain unchanged
- **AND** the grant SHALL be reachable again only through a fresh authorization interaction that supersedes it under the current binding

### Requirement: A legacy v0.1 refresh token SHALL be neither silently reclassified nor silently upgraded

A refresh token issued under v0.1 (a non-rotating, reusable refresh token, per the credential inventory's confirmed absence of rotation-on-use or reuse detection for this credential kind) SHALL continue to be honored, if at all, only under the legacy/bearer profile it was issued under. An RS or AS SHALL NOT:

- treat presentation of a legacy refresh token as if it were bound to a sender-constrained (key-bound) presentation mode; or
- silently begin applying rotation-on-use or reuse-detection semantics to a legacy refresh token as though it had been reissued under the current binding, without an explicit reauthorization event that supersedes the underlying grant.

A legacy refresh token remains subject to the disable/sunset mechanism above: once legacy acceptance is disabled for a deployment, a legacy refresh-token exchange SHALL be rejected. Upgrading a client from a legacy refresh token to a current-binding refresh token SHALL occur only through an explicit fresh authorization interaction that supersedes the prior grant; an AS SHALL NOT transparently exchange a legacy refresh token for a current-binding refresh token as a byproduct of ordinary use.

**Change class:** repairs an existing interoperability/security hole

#### Scenario: A legacy refresh token is not silently upgraded on use

- **WHEN** a client presents a v0.1-issued refresh token to the token endpoint
- **THEN** the AS SHALL process the exchange, if at all, under the legacy/bearer profile only
- **AND** SHALL NOT issue a sender-constrained (key-bound) access or refresh credential in response

#### Scenario: A legacy refresh token exchange is rejected once legacy acceptance is disabled

- **WHEN** an operator has disabled acceptance of `legacy_0_1` contexts and legacy-profile bearer credentials for a deployment
- **THEN** a subsequent legacy refresh-token exchange attempt SHALL be rejected
- **AND** the client SHALL be directed to perform a fresh authorization interaction to obtain a current-binding credential

### Requirement: The migration inventory SHALL name a rule for every credential kind in the current credential inventory

The migration inventory (extending the backward-compatibility and migration coverage previously limited to grants, bearer tokens, `manifest_version`, and clients) SHALL explicitly state, for each credential kind confirmed present in the reference implementation's credential inventory, what a deployment enforcing this Migration Profile does with a pre-existing credential of that kind. At minimum, the inventory SHALL cover:

- **Owner device-flow tokens** (fixed-duration bearer credentials issued to the owner's own client, e.g. via the device-authorization flow): remain valid bearer credentials under the legacy/bearer profile until their own expiry; they are not owner-grant-bound and are therefore out of scope for the `legacy_0_1` context/grant-enforcement rules above, but SHALL be named explicitly rather than left unaddressed by the migration inventory, since Stage 1 confirms this credential surface exists in the reference implementation.
- **Client access tokens on `continuous` grants with a null expiry**: remain valid under whichever profile (`legacy_0_1` or current) the underlying grant resolves to; a null-expiry client access token is precisely the case the disable/sunset mechanism above exists to bound, since it does not lapse through natural expiry.
- **Non-rotating legacy OAuth refresh tokens**: governed by the refresh-token requirement above.
- **Extension token kinds** (e.g. `mcp_package`-style tokens, and tokens issued against grant packages): treated as extension data under this Migration Profile exactly as Section 15.9 item 6 already treats reference-only grant packages, per-stream `client_claims`, and embedded grant display fields — i.e., the Migration Profile does not newly promote these extension kinds into Core enforcement, but the migration inventory SHALL still name them explicitly (rather than omit them) and state that they inherit the enforcement path (`legacy_0_1` or current) of the grant or package they are bound to.

This item does not require, and this Migration Profile does not assert, any fact about a specific live deployment's grant inventory, null-expiry-grant counts, or failure mode; the rules above state deployment-independent obligations, cited to the credential inventory's file:line evidence of each kind's current issuance/acceptance/revocation/rotation behavior, not to any deployment's live state.

**Change class:** repairs an existing interoperability/security hole

#### Scenario: The migration inventory names a rule for a fixed-duration owner device-flow token

- **WHEN** the migration inventory is reviewed for an owner token issued through the device-authorization flow
- **THEN** it SHALL state that the token remains a valid legacy-profile bearer credential until its own fixed expiry
- **AND** SHALL state that this credential is out of scope for the `legacy_0_1` context/grant-enforcement rules because it is not grant-bound

#### Scenario: The migration inventory names a rule for a null-expiry continuous-grant client access token

- **WHEN** the migration inventory is reviewed for a client access token issued against a `continuous`-mode grant with a null `expires_at`
- **THEN** it SHALL state that the token remains valid under its grant's resolved enforcement path (legacy or current)
- **AND** SHALL state that the disable/sunset mechanism, not natural expiry, is the bounded path to end that acceptance

#### Scenario: The migration inventory names a rule for extension token kinds

- **WHEN** the migration inventory is reviewed for an extension token kind such as a package-scoped token bound to a grant package
- **THEN** it SHALL state explicitly that the token is extension data inheriting the enforcement path of the grant or package it is bound to
- **AND** SHALL NOT omit this credential kind from the inventory

### Requirement: A conformance test suite SHALL assert a fully specified expected result for the required backward-compatibility test

The backward-compatibility conformance test named as a required negative test (asserting that v0.1 grants remain byte-identical, that a legacy context marks missing fields rather than inventing them, and that a v0.1 credential is not silently upgraded or accepted under a claim of the current sender-constrained security profile) SHALL have a fully specified, unambiguous expected result once this Migration Profile is applied. Conformance testing under this Migration Profile SHALL assert, at minimum:

- a v0.1 grant's stored bytes are unchanged after being resolved through the `legacy_0_1` path;
- an authorization context resolved for that grant is discriminated as `legacy_0_1` and marks its issuer, exact audience, proof/binding mode, security profile, and source-declaration digest as unavailable, never as a fabricated or inferred value;
- a request presenting that grant's credential is rejected if it is evaluated under the common algorithm's fail-closed rule instead of the `legacy_0_1` path;
- a request presenting that grant's credential is rejected outright once the deployment's legacy-acceptance flag is off or the sunset boundary has passed;
- no response derived from that grant asserts a sender-constrained (key-bound) security profile.

**Change class:** repairs an existing interoperability/security hole

#### Scenario: The backward-compatibility test yields one unambiguous pass/fail result

- **WHEN** the required backward-compatibility conformance test is executed against an implementation of this Migration Profile
- **THEN** each of the assertions above SHALL have exactly one specified expected outcome
- **AND** the test SHALL fail if the implementation upgrades the credential to, or reports it under, a sender-constrained security profile

### Requirement: PDPP SHALL pin one JSON Schema dialect for common and security-critical schemas

All PDPP schemas that a conformant implementation validates against — including but not limited to `streams[].schema` (spec-core.md §7 Manifest Format) and any schema a future change later defines for common authorization objects — SHALL declare conformance to a single, named JSON Schema dialect: **JSON Schema draft 2020-12** (`https://json-schema.org/draft/2020-12/schema`). An implementation SHALL NOT validate a declared schema against a different dialect, and a schema document SHALL NOT omit a `$schema` declaration where the dialect would otherwise be ambiguous.

This requirement resolves an unresolved dialect question and closes the gap where `streams[].schema` names "JSON Schema" with no dialect pinned.

**Change class:** introduces a genuinely new normative capability

#### Scenario: A manifest schema declares the pinned dialect

- **WHEN** a connector manifest declares `streams[].schema`
- **THEN** the schema SHALL be interpreted under JSON Schema draft 2020-12
- **AND** an authorization server or resource server validating records against that schema SHALL NOT apply a different draft's validation rules

#### Scenario: Two implementations validate the same schema identically

- **WHEN** two independent implementations validate the same record against the same declared `streams[].schema`
- **THEN** both SHALL reach the same accept/reject result, because both interpret the schema under the one pinned dialect rather than each implementation's own default

### Requirement: PDPP SHALL pin one canonical timestamp and duration string profile for canonicalized objects

Any object that PDPP canonicalizes or digests (including any future grant digest computation, which is out of scope for this change but depends on this pin) SHALL represent every RFC 3339 timestamp field and ISO 8601 duration field using exactly one canonical string profile:

- **Timestamps** SHALL be represented in RFC 3339 `date-time` form, in the UTC offset, using the literal uppercase `Z` suffix (not a numeric `+00:00` offset), with exactly **zero** fractional-second digits when the underlying instant has no sub-second precision, and otherwise with exactly **three** fractional-second digits (millisecond precision), zero-padded. A timestamp string that a producer cannot express with zero or three fractional digits SHALL be rounded to the nearest millisecond before canonical encoding.
- **Durations** SHALL be represented in ISO 8601 duration form using only the largest applicable calendar designators already illustrated in spec-core.md's `retention.max_duration` examples (e.g. `P6M`, `P1Y`, `P90D`); a duration string SHALL NOT include a time-of-day component (`T` designator) unless the duration is genuinely sub-day, and SHALL NOT use two different representations of the same duration length (e.g. `P90D` and `P3M` are not interchangeable canonical forms — a producer SHALL choose one and represent that duration length consistently across the deployment).

A field declared as a timestamp or duration in a canonicalized object that does not conform to this profile SHALL be rejected before canonicalization, rather than canonicalized as received. This requirement does not itself define grant-digest computation (RFC 8785 JCS application, hash algorithm, or excluded fields), which remains out of scope for this change; it defines only the string-representation prerequisite that any such future digest computation depends on, because RFC 8785 canonicalizes JSON structure but treats string values as opaque, so semantically identical instants written as `...00Z` and `...00.000Z` would otherwise canonicalize to different bytes and produce different digests.

This requirement resolves an unresolved timestamp/duration canonicalization question and is a prerequisite the seam-spike gate (see the sequencing requirement below) depends on before its Phase 0 begins.

**Change class:** introduces a genuinely new normative capability

#### Scenario: Two producers of the same instant canonicalize to the same bytes

- **WHEN** two implementations independently produce a timestamp string for the same underlying instant, one naturally rendering it as `2026-08-04T12:00:00Z` and the other as `2026-08-04T12:00:00.000Z`
- **THEN** both SHALL normalize the field to the single pinned profile before canonicalization
- **AND** the resulting canonical bytes for that field SHALL be identical between the two implementations

#### Scenario: A non-conforming timestamp is rejected before canonicalization

- **WHEN** a timestamp field intended for a canonicalized object uses a numeric UTC offset (e.g. `+00:00`) or a fractional-second precision other than zero or three digits
- **THEN** the implementation SHALL reject the field rather than pass it through to canonicalization unchanged

#### Scenario: A duration field uses the pinned calendar-designator form

- **WHEN** a `retention.max_duration`-shaped duration field is produced for a canonicalized object
- **THEN** it SHALL use the largest applicable calendar designators with no time-of-day component for durations of a day or longer
- **AND** an implementation SHALL NOT emit two different designator forms for what is declared to be the same duration length within one deployment

### Requirement: The Core/binding decomposition and the closed 0.2 common schemas SHALL remain gated on the repaired seam-spike protocol

The three-document Core/binding decomposition (a prospective split of normative protocol text into separate Core, OAuth-binding, and owner-profile documents) and the nine 0.2 common schemas (`PDPPSelection`, `PDPPApprovedSelection`, `PDPPRequesterIdentity`, `PDPPConsentEvidence`, `PDPPGrant`, `PDPPGrantState`, `PDPPCredentialFamily`, `PDPPAuthorizationContext`, `PDPPError`, each at 0.2) are NOT settled normative text as of this change. They SHALL NOT be published as normative until the repaired seam-spike protocol defined below has run and passed. This change (PR1) is scoped to the subset of hardening and migration requirements that hold regardless of that decomposition's eventual outcome; the decomposition and the nine schemas are deferred to a subsequent change gated on the spike's result.

The seam-spike protocol that governs this gate SHALL:

1. Use a corpus of exactly 13 vectors, where the 13th vector is a v0.1 grant served through a `legacy_0_1` authorization context by a 0.2 resource server.
2. Define "independent," for the purpose of any two-implementation, two-authorization-server, or two-resource-server threshold in the spike, as a separate team or an off-the-shelf product; oracle substitution (evaluating a threshold using the same implementation or team that produced the object under test) SHALL NOT be permitted for the commitment decision.
3. Either give the GNAP adapter leg of the spike binding pass/fail criteria — partial approval returning an unambiguous client-visible result, `single_use` credential exchange behaving exactly-once, and full `PDPPAuthorizationContext`-equivalent resolution — or explicitly and textually declare the GNAP leg non-gating for the decomposition-commitment decision. A mapping-completeness report alone SHALL NOT serve as the GNAP leg's pass criterion if the GNAP leg is declared gating.
4. Be stated as exactly one normative experiment definition, which any other document section referencing the spike SHALL cross-reference rather than restate.
5. Require that the canonical timestamp/duration profile and JSON Schema dialect pin (the two requirements above) are resolved before the spike's first phase begins.

**Change class:** repairs an existing interoperability/security hole

#### Scenario: The decomposition is not treated as settled before the spike passes

- **WHEN** a reader looks for normative status of the three-document Core/binding split or any of the nine 0.2 common schemas
- **THEN** the spec text SHALL state they are not settled normative text
- **AND** SHALL state they remain deferred pending the seam-spike's outcome

#### Scenario: The spike corpus includes the legacy vector

- **WHEN** the seam-spike corpus is assembled
- **THEN** it SHALL contain 13 vectors
- **AND** the 13th vector SHALL be a v0.1 grant served through `legacy_0_1` by a 0.2 resource server

#### Scenario: Independence excludes oracle substitution

- **WHEN** a two-implementation, two-authorization-server, or two-resource-server threshold in the spike is evaluated for the commitment decision
- **THEN** "independent" SHALL mean a separate team or an off-the-shelf product
- **AND** the same implementation or team serving as both the object under test and its own evaluating oracle SHALL NOT satisfy the threshold

#### Scenario: The GNAP leg either has real pass criteria or is declared non-gating

- **WHEN** the GNAP adapter leg of the spike is evaluated
- **THEN** it SHALL be judged against partial-approval-with-unambiguous-result, exactly-once `single_use` behavior, and full authorization-context resolution
- **OR** the spec text SHALL explicitly declare the GNAP leg non-gating for the decomposition-commitment decision

#### Scenario: One normative experiment definition is cross-referenced, not restated

- **WHEN** more than one document section describes the seam-spike experiment
- **THEN** exactly one section SHALL state the experiment definition normatively
- **AND** every other section referencing it SHALL cross-reference that one statement rather than restating a possibly-different definition

#### Scenario: The canonicalization pin precedes the spike's first phase

- **WHEN** the seam-spike protocol's first phase is scheduled to begin
- **THEN** the pinned JSON Schema dialect and canonical timestamp/duration profile SHALL already be resolved normative text
