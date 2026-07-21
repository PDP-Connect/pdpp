## ADDED Requirements

### Requirement: Credential-boundary process replacement SHALL expose continuity uncertainty without assuming repair

When a credential-boundary browser process is replaced, the runtime SHALL emit
non-secret replacement evidence and expose current continuity as
`replacement_pending`, `rehydration_false`, or `indeterminate` until a
provider-specific continuity mechanism proves otherwise. None of those states may
be treated as green or create an owner action. Provider invalidation can route the
existing connection to repair only through a typed, auditable
`ProviderInvalidationProof` with `kind: "provider_invalidation_proof"`, provider,
connection identity, non-secret evidence identity and observation time, and
`verified: true`.

The proof SHALL be provider-originated and connection-bound. A free-form string,
replacement receipt, process-loss inference, false/indeterminate probe, or
DOM/URL/title/profile heuristic SHALL NOT be coerced into that proof. The runtime
SHALL deduplicate it to at most one connection-scoped repair for a connection and
proof identity.

The runtime SHALL preserve the connector's exact authenticated-session probe as the
only provider-authentication discriminator. For ChatGPT, an HTTP 200 response from
`/api/auth/session` with no `user` SHALL evaluate false. The runtime SHALL reject
DOM markers, URL, title, persisted profile, page reachability, and transport status
alone as substitutes for the probe.

#### Scenario: A replacement has false rehydration but no provider invalidation

**WHEN** a credential-boundary process replacement completes and the connector's
exact session probe is false or indeterminate
**AND** no typed verified `ProviderInvalidationProof` exists for that connection
**THEN** the runtime SHALL expose non-green continuity uncertainty
**AND** it SHALL create no owner action.

#### Scenario: Provider invalidation remains the typed repair boundary

**WHEN** a provider-originated, connection-bound `ProviderInvalidationProof` is
verified for the connection
**THEN** the runtime MAY create one existing connection-scoped repair action for
that proof
**AND** it SHALL preserve the connection identity
**AND** it SHALL NOT infer stored-credential capture from a browser-session binding.

#### Scenario: Ambiguous evidence cannot manufacture repair authority

**WHEN** a replacement receipt, a false or indeterminate exact probe, or DOM/URL/
profile evidence is observed without a typed verified provider proof
**THEN** the runtime SHALL create no owner repair action
**AND** it SHALL NOT relabel the evidence as provider invalidation.
