# PDPP Provider Connect Profile Outline

Status: Working memo  
Date: 2026-04-16

## Purpose

This memo outlines a companion profile for the generic "`connect to your PDPP provider`" problem.

The target audience is:

- implementers of CLI or native clients that want to connect to arbitrary PDPP providers
- PDPP spec authors deciding what belongs in core versus a companion profile
- reference-implementation authors deciding what a generic client may assume without bespoke provider coordination

The goal is **not** to restate OAuth. The goal is to define the smallest PDPP-specific glue needed so a client can discover and use a PDPP provider while composing existing OAuth standards directly.

## Bottom line

Core PDPP already gives a strong answer to:

- what data access is being requested (`authorization_details`, RFC 9396 envelope)
- what the resulting grant means
- how a resource server enforces that grant
- how owner-authenticated self-export works once an owner token exists

Core PDPP does **not** yet give a turnkey answer to:

- how a generic client discovers a provider's AS and RS surfaces
- how a generic native app or CLI knows which OAuth flow to use
- how a generic client learns whether self-export is supported
- what a client may assume about registration and redirect behavior without provider-specific docs

That gap is real, but it is **not** a reason to clone OAuth. The right move is a thin PDPP companion profile that:

- reuses OAuth standards directly for auth, discovery, client metadata, and token use
- adds only the PDPP-specific metadata and assumptions that OAuth leaves open
- keeps core PDPP unchanged except for normative references if needed

## Boundary with core PDPP

### Stays in core PDPP

These are already core concerns and should not be redefined in the companion profile:

- the PDPP `authorization_details` type and object semantics
- grant semantics, including stream selection, field projection, access mode, purpose, and retention declarations
- requester identity semantics (`client_display`, `client_claims`)
- RS query semantics and self-export semantics
- owner token versus client token distinction at the RS boundary
- introspection semantics required by PDPP between AS and RS

### Belongs in the provider-connect companion profile

These are the missing interoperability seams for generic clients:

- provider and endpoint discovery
- what kind of OAuth client behavior a PDPP provider must support for CLI/native clients
- how a generic client learns whether self-export is available
- how a generic client learns whether registration is required or optional
- what the minimum metadata contract is for a provider claiming "`generic PDPP client connect`" support

### Explicitly out of scope for this profile

- collection/runtime behavior
- connector execution
- orchestration/control plane
- website integration
- UI details of consent presentation
- local logging/transparency history

## What a generic CLI or native client can and cannot assume

### What it can reasonably assume today from core PDPP

If the provider is already known and the client already has an owner token or client access token, a generic client can assume:

- bearer-token presentation to the RS using `Authorization: Bearer ...` (RFC 6750)
- standard PDPP RS query semantics
- self-export via the standard RS query endpoints if the provider supports owner-authenticated self-export
- PDPP selection requests are expressed using `authorization_details` with the PDPP type URI

### What it cannot safely assume from core PDPP alone

A generic client cannot yet assume:

- where to find the provider's AS and RS metadata
- that the provider supports dynamic client registration
- that the provider accepts public native clients
- that the provider supports device flow for CLI use
- that the provider supports browser-based auth code + PKCE for native apps
- that self-export is available or how owner tokens are issued
- that the same hostname or issuer covers both AS and RS

### Practical consequence

Without the companion profile, a generic "`connect to your PDPP provider`" feature still requires some combination of:

- provider-specific documentation
- provider-specific registration or approval
- provider-specific discovery conventions

That is normal for an ecosystem at this stage, but it is exactly the seam the companion profile should tighten.

## Direct OAuth reuses

The profile should compose the following standards directly rather than cloning them.

### RFC 6749 / OAuth 2.0 core

Use directly for:

- client / AS / RS role model
- authorization code flow concepts
- registration and trust model boundaries
- the rule that resource-owner authentication is out of scope for OAuth itself

Why this matters for PDPP:

- PDPP should not define its own generic token acquisition framework
- PDPP should continue to treat user authentication at the AS as deployment-specific

### RFC 6750 / Bearer token usage

Use directly for:

- token presentation to the RS
- requirement that RS implementations support `Authorization: Bearer`

Why this matters for PDPP:

- PDPP already uses bearer tokens at the RS boundary
- the profile should not invent a custom token transport for CLI/native clients

### RFC 7662 / Token introspection

Use directly for:

- AS↔RS token resolution when AS and RS are separated
- RS-side determination of token activity and metadata

Why this matters for PDPP:

- PDPP already uses introspection-style semantics
- the companion profile should standardize assumptions around introspection support rather than replacing them

### RFC 9396 / Rich Authorization Requests

Use directly for:

- carrying the PDPP selection request in `authorization_details`

Why this matters for PDPP:

- PDPP's data-access semantics are already expressed as an OAuth authorization-details type
- the profile should specify how a generic client submits that request, not redefine the request model

### RFC 8414 / Authorization Server Metadata

Use directly for:

- discovering authorization endpoint, token endpoint, device authorization endpoint, registration endpoint, and supported auth methods

Why this matters for PDPP:

- a generic client needs AS metadata without bespoke docs
- the profile should point to RFC 8414 rather than define a parallel PDPP auth-metadata document

### RFC 9126 / Pushed Authorization Requests

Use directly for:

- large or privacy-sensitive authorization requests
- carrying PDPP `authorization_details` without relying on URL-length limits

Why this matters for PDPP:

- PDPP selection requests can be large enough that production deployments should not depend on front-channel URL carriage
- the profile should reuse PAR rather than defining a PDPP-specific request-staging mechanism

### RFC 7591 / Dynamic Client Registration and client metadata model

Use directly for:

- the client metadata vocabulary
- optional dynamic client registration when a provider chooses to support it

Why this matters for PDPP:

- PDPP already reuses the RFC 7591 human-readable client metadata model
- the profile should not require dynamic registration, but it should use RFC 7591 if registration is offered

### RFC 8252 / OAuth 2.0 for Native Apps

Use directly for:

- native-app redirect handling
- external user-agent expectations
- PKCE requirements for public native clients

Why this matters for PDPP:

- a PDPP desktop or mobile client is exactly the kind of native app this RFC covers
- the profile should not define its own native-app redirect or embedded-webview rules

### RFC 8628 / Device Authorization Grant

Use directly for:

- CLI and input-constrained device authorization when browser redirects are awkward or impossible

Why this matters for PDPP:

- the CLI case is central to this memo
- the profile should state whether device flow is required, recommended, or optional for providers claiming generic CLI-connect support

### RFC 9700 / OAuth 2.0 Security BCP

Use directly for:

- the default security posture for OAuth-based provider-connect behavior
- avoiding stale or weak OAuth assumptions in a new PDPP profile

Why this matters for PDPP:

- the profile should inherit current OAuth security guidance rather than re-litigating it
- this is the cleanest way to align generic client-connect behavior with modern OAuth expectations without turning PDPP into a security-BCP rewrite

## Additional OAuth standards worth using rather than reinventing

### RFC 9728 / Protected Resource Metadata

This is the strongest candidate for avoiding a PDPP-specific provider discovery document.

Why it matters:

- the provider-connect problem is not only about AS discovery; it is also about discovering the protected resource the client wants to call
- RFC 9728 is specifically designed to let a client obtain the information needed to interact with an OAuth-protected resource
- it parallels RFC 8414 and is newer than many existing repo notes

Recommendation:

- prefer RFC 9728 as the discovery anchor for RS-first clients if it is sufficient
- define a PDPP-specific well-known document only if RFC 9728 plus RFC 8414 cannot carry the needed RS/AS linkage and PDPP capability signaling

## Minimal PDPP-specific glue

If OAuth is reused directly, the remaining PDPP-specific glue should be as small as possible.

### 1. Provider capability metadata

A generic PDPP client still needs to know PDPP-specific things that OAuth does not define, such as:

- whether the RS supports owner-authenticated self-export
- whether the provider supports the PDPP provider-connect profile at all
- the PDPP `authorization_details.type` URI(s) the AS accepts
- whether the provider expects AS-issued client tokens, owner tokens, or both

This metadata should be expressed as:

- either extensions to protected-resource metadata / authorization-server metadata
- or, only if unavoidable, a very small PDPP provider metadata document

### 2. RS↔AS linkage for PDPP use cases

A generic client needs a standards-legible way to move from:

- a provider identifier or RS base URL

to:

- the AS metadata document
- the RS metadata document
- the PDPP-specific capability metadata

OAuth gives partial answers here:

- RFC 8414 covers AS metadata
- RFC 9728 covers RS metadata

PDPP should add only whatever linkage those do not already make explicit enough for this ecosystem.

### 3. Self-export signaling

OAuth has no concept of PDPP self-export.

PDPP should define:

- how a provider signals that owner-authenticated self-export is supported
- which RS surfaces are used for self-export
- what token kind is expected for self-export at the RS boundary

This should be capability metadata, not a new self-export protocol.

### 4. Token-kind clarity

PDPP distinguishes:

- owner tokens
- client tokens

OAuth does not define this distinction as a generic ecosystem-wide concept.

The profile should clarify:

- what a generic client may expect from RS error responses and introspection semantics
- whether token kind is visible only to the RS or also declared in provider metadata

This should stay thin. It should not become a new token format or a new token endpoint contract.

## CLI implications

### What a generic CLI should be able to do under the profile

At minimum:

- discover a provider from a configured issuer, RS URL, or provider URL
- obtain or prompt for owner auth if the goal is self-export
- run self-export against standard RS query endpoints
- inspect provider metadata and supported capabilities

Potentially, if the provider supports it:

- initiate a third-party client authorization request using auth code + PKCE or device flow
- submit PDPP `authorization_details` for a scoped client grant
- exchange the resulting code for a client access token

### What the CLI should not assume

- that every provider supports generic third-party client connectivity
- that every provider supports dynamic registration
- that every provider supports device flow
- that owner auth and client auth are the same thing
- that an ad hoc API key or local session token is a portable PDPP assumption

### Recommended CLI posture

The launch-complete reference CLI should implement two modes:

- `self-export` mode
- `client-connect` mode against providers that explicitly claim support for the companion profile

That keeps the launch target complete while avoiding any claim that every provider in the ecosystem supports the richer client-connect path.

## Open questions

### 1. Should RFC 9728 be the primary discovery anchor?

This is the best current candidate. If it works cleanly, PDPP may not need a new well-known document at all. If it does not, PDPP should define only the smallest additional discovery object needed.

### 2. Is dynamic client registration required, recommended, or optional?

Requiring RFC 7591 from every conforming provider would be too heavy. Treating it as irrelevant would weaken the launch-complete reference unnecessarily.

Current recommendation:

- not required from every conforming provider
- protected DCR should be part of the launch-complete reference when the provider advertises a `registration_endpoint`
- a manual or pre-registered fallback should remain part of the baseline interoperability story

### 3. Should device flow be required for CLI-connect support?

CLI usability argues yes. Ecosystem flexibility argues no.

Current recommendation:

- require either device flow or an equivalent browser-based public-client flow that a generic CLI can drive
- prefer explicit device-flow support for providers claiming "`generic CLI connect`"

### 4. Should the profile require PAR?

PDPP selection requests can become large. Core spec already says production deployments should use PAR.

Current recommendation:

- strongly recommend PAR
- consider making PAR required for providers claiming the generic third-party client-connect capability

### 5. What is the minimum registration story for public clients?

The profile needs a coherent story for:

- pre-registered public native clients
- dynamically registered public clients
- provider-approved confidential clients

It should not silently assume one model.

## Recommended next-step spec/profile shape

The companion profile should be short and compositional.

### Suggested sections

1. **Scope and boundary**
   - what this profile adds beyond core PDPP
   - what it explicitly leaves to OAuth standards and deployment policy

2. **Conformance target**
   - what it means for a provider to support generic native/CLI connectivity
   - what it means for a client to implement the profile

3. **Discovery**
   - preferred discovery path
   - how AS metadata and RS metadata are located
   - where PDPP capability metadata is published

4. **Client types and registration**
   - native/public clients
   - CLI/device clients
   - protected dynamic registration
   - manual/pre-registered fallback

5. **Authorization request shape**
   - auth code + PKCE and/or device flow
   - submission of PDPP `authorization_details`
   - requester identity metadata handling

6. **Token use**
   - bearer presentation per RFC 6750
   - introspection expectations where relevant
   - owner token versus client token expectations at the RS

7. **Self-export**
   - capability signaling
   - owner-authenticated RS usage

8. **Security considerations**
   - no embedded webviews for native apps
   - PKCE for public clients
   - PAR for large PDPP authorization requests
   - bearer-token handling and log hygiene
   - security defaults aligned with OAuth BCP
   - optional future hardening profile, not part of this memo

## Recommended shape in one sentence

PDPP should define a **Provider Connect Profile** that says:

> A provider claiming generic PDPP native/CLI connectivity MUST expose its OAuth and RS metadata through existing OAuth metadata standards where possible, MUST accept PDPP selection requests via RFC 9396, MUST document or publish whether self-export is supported, and MUST not require bespoke out-of-band assumptions beyond the profile's declared registration and flow options.

## Recommendation

Proceed with a companion profile.

But keep it narrow:

- do not expand core PDPP
- do not define a PDPP clone of OAuth discovery, registration, or native-app guidance
- prefer RFC 9728 + RFC 8414 + RFC 7591 + RFC 8252 + RFC 8628 + RFC 9396 as the base stack
- add only the minimum PDPP-specific capability and linkage metadata needed for "`connect to your PDPP provider`" interoperability

The launch-complete reference should prove:

- owner self-export
- third-party client connect
- pre-registered/manual fallback
- protected DCR when advertised

If this discipline is maintained, the profile will feel like a serious standards-layer composition rather than a speculative fork of OAuth.
