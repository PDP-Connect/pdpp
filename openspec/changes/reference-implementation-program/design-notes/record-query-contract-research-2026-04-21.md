# Record-query contract research — 2026-04-21

**Status:** active input to contract review
**Author:** Codex (owner agent)

## Purpose

Capture the research inputs that should guide the PDPP record-query contract review so the eventual contract decision is grounded in:

- PDPP's own design principles
- modern API leader prior art
- adjacent open standards that have already faced similar tradeoffs

This note is input, not final contract text.

## PDPP design-principle lens

The Core spec already gives a strong lens for evaluating query-surface changes.

### 1. Consent surface and actual consent are separate

Core opens with the design axiom:

- connector manifests define the consent surface
- grants define actual consent

See:

- `spec-core.md` §1 Introduction
- `spec-core.md` §7 Manifest

Implication for query design:

- request-time query parameters can narrow a granted read
- they must not become a shadow consent model
- ad hoc query power should not replace manifest-defined, human-reviewable stream semantics

### 2. Authorization, disclosure, and collection are separate concerns

Core explicitly separates:

1. authorization
2. disclosure
3. collection

See:

- `spec-core.md` §3 System Architecture

Implication:

- the record-query contract should stay focused on disclosure semantics
- it should not absorb runtime/control-plane or collection concerns just because the reference server happens to know more

### 3. Data minimization is a first-class design goal

Core explicitly anchors stream- and field-level selection in data minimization and human-reviewable consent.

See:

- `spec-core.md` §10 Data minimization
- `spec-core.md` §5 Selection request
- `spec-core.md` §7.1 Views

Implication:

- query features should help clients ask for less data, not create hidden ways to ask for more
- field projection is aligned with the protocol's core values
- expansion and broad filter semantics need special caution because they can silently widen what a client receives or learns

### 4. Request-time filters are not grant scope

Core already says request-time filters narrow the result set for a request but do not narrow the authorization scope of the grant.

See:

- `spec-core.md` §14.4 Predicate-based grant scoping (deferred)

Implication:

- filters belong on the disclosure surface
- but the protocol should not drift into "predicate-defined grants by another name"
- when semantically bounded subsets matter for consent, Core already prefers manifest-defined streams over arbitrary technical predicates

### 5. Human reviewability matters

Core repeatedly prefers stable, manifest-defined, human-reviewable semantics over ad hoc technical power.

See:

- `spec-core.md` §7 Stream display metadata
- `spec-core.md` §14.4 Derived subset streams (informative)

Implication:

- if a feature makes the effective data request hard to explain to a user or operator, it should be narrowed or deferred
- this weighs against an OData-like general query language

### 6. Auditability and transparency should be enabled, not overloaded

Core defines auditable protocol primitives but intentionally avoids embedding a full local audit or transparency product into the core query surface.

See:

- `spec-core.md` §10 Auditability and transparency boundary

Implication:

- read/query responses should stay explicit and inspectable
- response metadata like `freshness` can help if it remains advisory and honest

## Prior art

Before listing comparators, one distinction matters:

- Stripe and Plaid are excellent prior art for API quality, contract discipline, and bounded power.
- They are **not** direct analogues to PDPP's hardest problem, which is a protocol over future and heterogeneous streams across many providers/connectors, with consent semantics that must remain interoperable and human-reviewable.

So the right question is not "who has the prettiest API docs?" It is:

- who has already proven out permissioned cross-provider data access at ecosystem scale?
- who has already faced the protocol-design problem of future/heterogeneous resource types, typed search semantics, and capability declaration?

That leads to a second layer of comparators.

## Closest ecosystem comparators

### Open Banking / Open Finance / FDX / FAPI

Why this is close:

- permissioned access across many independent providers
- consent and revocation semantics
- security profiles and ecosystem governance
- real economic and operational scale

Why it matters:

- Open Banking UK reported that in **July 2025** the ecosystem exceeded **15 million users** and **2 billion monthly API calls**.
- FDX is explicitly organized around a common, interoperable standard for user-permissioned financial data sharing, with governance spanning financial institutions, data aggregators, permissioned parties, and industry groups.
- OpenID Foundation FAPI work is explicitly positioned as a core security substrate for Open Banking and Open Data ecosystems.

Sources:

- Open Banking UK, "2 Billion API calls and 15 Million users - a landmark month for open banking in the UK" (published September 2025)
- FDX FAQ / governance materials
- OpenID Foundation open banking / FAPI whitepaper

What it teaches PDPP:

- this is the strongest proof that consented, cross-provider data access can become real infrastructure rather than a niche product API
- security and authorization profiles can be standardized separately from resource/query semantics
- ecosystem capability publication and governance matter as much as endpoint design

What it does **not** settle for PDPP:

- the exact query semantics for future heterogeneous streams
- how generic filtering and expansion should work over arbitrary future resource types

### SMART on FHIR / FHIR

Why this is close:

- protocol over future and heterogeneous resource types
- typed search semantics instead of ad hoc filter conventions
- formal capability declaration
- real regulatory and ecosystem adoption

Why it matters:

- FHIR has a formal `CapabilityStatement` model, including per-resource search/include declarations, and a formal `SearchParameter` model.
- SMART on FHIR positions itself as an interoperable apps-based economy built on those standards.
- U.S. official adoption is substantial:
  - ONC reported that **more than two-thirds of hospitals** used a FHIR API to enable patient access in **2022**.
  - CMS requires impacted payers to expose data through FHIR-based Patient Access APIs and, beginning in **2026**, to report usage metrics for those APIs.

Sources:

- HL7 FHIR `CapabilityStatement`
- HL7 FHIR `Search`
- HL7 FHIR `SearchParameter`
- SMART on FHIR Community
- ONC / HealthIT hospital FHIR API data brief
- CMS Patient Access API guidance

What it teaches PDPP:

- publish capability support explicitly instead of assuming clients can infer it
- tie comparator semantics to declared parameter types rather than "all fields support all operators"
- keep search/query semantics inspectable and profile-aware

What it does **not** settle for PDPP:

- consumer-consent UX and grant semantics in the PDPP sense
- the best disclosure shape for owner-controlled, connector-defined streams

### SCIM

Why this is relevant:

- standardizes interoperable REST semantics over extensible schemas
- includes filter grammar plus explicit feature-discovery endpoints
- real enterprise adoption, even if it is not the same economic category as Open Banking or FHIR

Sources:

- RFC 7644 (SCIM Protocol)

What it teaches PDPP:

- discovery endpoints like `ServiceProviderConfig` are valuable
- schema extensibility can coexist with interoperable protocol semantics
- broad filter grammars are possible, but they become a much larger contract surface quickly

Why it is only a secondary comparator:

- SCIM is about identity provisioning and directory-style resources, not consented cross-provider data access
- it is helpful for protocol structure, not as the primary product/ecosystem analogue

## Comparator synthesis

If the question is "who should influence PDPP's contract decisions most?", the current answer is:

1. **Open Banking / Open Finance / FDX / FAPI** for:
   - consented cross-provider access
   - ecosystem governance
   - auth/security profile lessons
   - evidence that this class of infrastructure can achieve real usage at scale
2. **SMART on FHIR / FHIR** for:
   - future-proof resource/query semantics
   - typed search behavior
   - capability declaration
   - interoperable server/client expectations
3. **Stripe / Plaid** for:
   - contract and docs quality
   - bounded power
   - generated artifacts and developer ergonomics
4. **SCIM** as a secondary protocol-design reference:
   - extensibility
   - discovery
   - cautionary lessons from richer filter grammars

In short:

- Stripe/Plaid remain useful, but mostly for **discipline and ergonomics**
- Open Banking/FDX/FAPI and SMART on FHIR/FHIR are the stronger comparators for the **actual normative design problem**

## What this implies for PDPP contract layout

The main implication is that PDPP should **not** freeze one flat, global query contract as if every future stream supports the same power uniformly.

The stronger layout is a layered one:

### 1. Core protocol contract

This should define the portable, durable semantics that apply across implementations:

- auth / grant / disclosure boundaries
- baseline list/read mechanics
- shared parameter and error conventions
- the distinction between grant scope and request-time narrowing

This layer should stay small and crisp.

### 2. Capability-declared query surface

This should declare what a given server/stream actually supports, especially for the higher-risk areas:

- which fields support exact filtering
- which fields support range operators, and which operators
- which relationships are expandable
- expansion depth/limits
- sort/cursor behavior
- freshness publication

This is where FHIR's `CapabilityStatement` / `SearchParameter` pattern is directly relevant.

### 3. Reference contract / OpenAPI / generated docs layer

This should describe what the reference implementation actually ships right now:

- truthful, machine-readable, and validated
- usable to generate docs, typed clients, and AI-facing surfaces
- explicitly narrower than aspirational PDPP prose if implementation lags

This is where Stripe/Plaid-style contract quality matters most.

## How to weight the comparators

Another important conclusion:

- Open Banking and FHIR should **not** be treated as proof of premium developer taste or delightful product ergonomics in the Stripe/Plaid sense.
- They are highly relevant because they solved harder ecosystem and interoperability problems, often under regulatory pressure, at real scale.

So the right weighting is:

- use **Open Banking / FDX / FAPI / FHIR / SMART** to shape:
  - protocol boundaries
  - capability declaration
  - consent/interoperability discipline
  - ecosystem-grade semantics
- use **Stripe / Plaid** to shape:
  - docs quality
  - machine-readable contract publication
  - bounded power
  - examples, SDK ergonomics, and developer trust

This is not a contradiction. It is the right split of responsibilities across the prior art.

### Stripe

Relevant lessons:

- machine-readable contracts matter enough to publish and generate
- expansion is explicit, declared, and bounded rather than magical
- vendor extensions are acceptable when OpenAPI cannot express the whole truth

Sources:

- `stripe/openapi` repository shows generated OpenAPI plus vendor extensions such as `x-expandableFields`
- Stripe API docs define `expand` and limit expansion depth to four levels

Why it matters for PDPP:

- supports the move toward a generated machine-readable reference contract
- suggests that if PDPP keeps expansion, expandable fields/relations should be explicitly declared rather than inferred
- supports bounded expansion rather than generic relational query power

### Plaid

Relevant lessons:

- high-adoption data APIs often prefer product-specific, narrower request shapes over generic query grammars
- optional disclosure is often exposed as explicit option flags rather than generic expansion or arbitrary filter algebra
- pagination and sync mechanics are part of the product contract, not hidden implementation details

Sources:

- Plaid Transactions docs
- Plaid OpenAPI publication / resource surfaces
- Plaid MCP / AI resource surfaces

Why it matters for PDPP:

- argues for a practical, truthful query surface rather than a maximal one
- suggests PDPP does not need to imitate a broad generic analytics/query language to be useful

### JSON:API

Relevant lessons:

- sparse fieldsets are a legitimate first-class read-surface feature
- inclusion of related resources is optional but, if supported, should be explicit and fail loudly when unsupported
- the response `self` link should preserve the effective query parameters

Sources:

- JSON:API v1.1 spec

Why it matters for PDPP:

- validates keeping `fields`
- validates explicit failure for unsupported include/expand paths instead of silent ignore
- supports the idea that relationship inclusion is a distinct, explicitly declared contract surface

### FHIR

Relevant lessons:

- search parameters are typed
- comparators depend on parameter type, not just on arbitrary field names
- servers declare supported search capabilities
- clients are expected to inspect what the server actually supported

Sources:

- FHIR Search
- FHIR SearchParameter

Why it matters for PDPP:

- strongly supports narrowing range operators by field/search-parameter type
- suggests that "all scalar fields are queryable the same way" is the wrong model
- reinforces the value of explicit capability declaration

### OData

Relevant lesson:

- powerful generic query systems are possible, but they create a much broader and more complex contract surface

Source:

- OData 4.01 URL conventions

Why it matters for PDPP:

- mainly as a caution
- PDPP should avoid drifting into a general-purpose query algebra that becomes harder to review, enforce, and explain than the consent model itself

### OAuth metadata family

Relevant lesson:

- modern interoperable systems publish capability metadata explicitly rather than forcing clients to infer behavior from prose or trial and error

Sources:

- RFC 8414
- RFC 9728
- RFC 9396

Why it matters for PDPP:

- supports the plan to publish a truthful machine-readable reference contract
- does not directly settle record-query semantics, but strongly supports explicit capability publication

## Research-weighted provisional implications

These are not final decisions yet, but they are the strongest provisional read from the current research.

### Keep

- `fields`
- `view`
- exact-match filtering
- `changes_since`
- an explicit machine-readable capability/contract layer

These fit both PDPP's design principles and external prior art.

### Keep, but implement carefully

- stable sort and cursor semantics
- `freshness`
- blob fetch

These look directionally right, but need disciplined semantics.

### Narrow before freezing

- range filters
- `expand[]`
- `expand_limit[...]`

These are the highest-risk areas.

The research suggests:

- range operators should be typed and explicit, not available uniformly across all fields
- expansion should be manifest-declared, bounded, and probably depth-1 in the reference unless there is a strong reason to go wider

## Most important lesson

The modern-leader evidence does **not** argue for "make the query API as expressive as possible."

It argues for:

- truthful contract publication
- explicit capability declaration
- strict validation
- bounded expansion
- typed search semantics
- generated docs and client/agent surfaces from one contract source

That is the frame the next decision pass should use.
