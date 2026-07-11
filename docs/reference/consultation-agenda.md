# PDPP Community Consultation Agenda

Status: Informative · consultation draft · 2026-07-09

## Purpose

PDPP v0.1 is a draft. Before the specification hardens, its open design
questions are being put to public consultation. This document is the
consultation agenda: it frames each unresolved question so that implementers,
reviewers, and adopters can respond to a stable, shared statement of the
problem rather than reconstruct it from scattered notes.

The design intent is deliberate. PDPP pins the interoperable core — the
resource-server interface, the grant as an immutable consent artifact, the
manifest-backed consent surface, and the introspection contract — and defers
the questions that cannot be answered well without implementation experience
or community agreement. Those deferred questions are enumerated in the
[Open Questions](https://www.pdpp.dev/docs/open-questions) list and in
[Deferred Concerns](https://www.pdpp.dev/docs/spec-deferred). This agenda
selects the items where community input most changes the outcome and states,
for each, what v0.1 does today and what response would move the question
toward resolution.

### How each item is framed

Every agenda item follows the same structure:

- **The question** — the decision to be made, stated as a single question.
- **Why it matters** — the interoperability or adoption consequence of
  getting it wrong, and why v0.1 left it open.
- **Current v0.1 position** — what the draft specification does today, with a
  section reference. A "position" here may be a working default, an explicit
  deferral, or a deliberate silence; it is not a settled decision.
- **What input helps** — the specific evidence, preference, or prior-art
  argument that would let the working group resolve the item.

An item's presence in this agenda means it is undecided. Items already
resolved by a v0.1 design constraint are recorded, with rationale, under
"Decided" in [Deferred Concerns](https://www.pdpp.dev/docs/spec-deferred) and
are not reopened here.

### Scope of this consultation

This agenda concerns the interoperable protocol: the grant, the selection
request, the manifest, the resource-server interface, and the companion
profiles that extend them. It does not concern any particular deployment,
operator console, or connector implementation. Where a question touches
runtime behavior, it does so only insofar as that behavior constrains the
portable contract.

---

## 1. Selector defaults: omitted selector means all, or none?

**The question.** When a selection request omits a selector, should the
default be all available data, or none?

**Why it matters.** The default posture is the difference between a protocol
whose baseline is broad collection and one whose baseline is data
minimization. It is not only a technical choice; it is a design philosophy
question that sets the tone for every grant issued under the specification.
Two mature ecosystems have chosen opposite defaults: OAuth deployments
typically default broad (a scope grants wide access), while Open Banking
requires explicit, minimal selection (permissions must be listed). For
personal-data portability, the more defensible default is contested.

**Current v0.1 position** ([spec-core §5](https://www.pdpp.dev/docs/spec-core#selection-request)).
Today the draft leans permissive on absence. Omitting `fields` (and `view`)
authorizes all fields in the stream; omitting `time_range` imposes no temporal
constraint; `necessity` defaults to `required`; and `"name": "*"` requests all
streams (expanded and frozen at consent time). The specification does require
that wildcards be written explicitly rather than implied, and it advises
clients to request only what they need. But the aggregate default posture —
maximum data when selectors are omitted — remains the primary live concern
from the review pass that produced this agenda.

**What input helps.** A reasoned position on which default a personal-data
protocol should adopt, ideally grounded in an ecosystem precedent (Open
Banking's explicit-minimum model, OAuth's broad-scope model, or another).
Concrete cases where a minimum default would break a legitimate use, or where
a broad default has caused over-collection, are especially useful. The options
under consideration are: keep the permissive default but require explicit
wildcards (roughly the current state); change the default to minimum, so that
an unspecified stream set authorizes nothing; or keep the current behavior and
document the rationale as an intentional choice.

## 2. Adoption posture: which paths to portability should the design optimize for?

**The question.** Which adoption postures should the design optimize for:
platforms that implement the resource-server interface natively, platforms
that endorse a connector over their existing API, or community connectors
covering platforms that do neither?

**Why it matters.** These three paths make different demands on the
specification. Provider-native adoption needs the source to speak PDPP
directly and be accountable for its own artifacts. Endorsed connectors need a
clear relationship between a platform's blessing and a connector's authority.
Community connectors — the polyfill case — need the connector and manifest
machinery to stand alone without any cooperation from the source. Optimizing
the design for one path can quietly raise the cost of the others, and the
protocol's reach depends on serving all three honestly.

**Current v0.1 position** ([spec-core §5](https://www.pdpp.dev/docs/spec-core#source-kinds)).
The source binding is a discriminated `source: { kind, id }` object. `kind`
is `"connector"` — a manifest-declared collection source bridging a platform
that does not speak PDPP — or `"provider_native"` — the provider's own
PDPP-speaking interface, hosting its own authorization and resource-server
roles. Both kinds render consent under the same manifest obligations. The
draft thus admits all three paths, but its detailed semantics and worked
examples are richest for the connector case; provider-native display-metadata
conventions are expected to mature with real provider integrations. See also
item 3 below, which covers the manifest's counterpart for provider-native
sources.

**What input helps.** From platform operators: what would make native
adoption viable, and what an endorsement of a connector would need to mean
contractually and technically. From connector authors: where the current
connector-oriented machinery imposes cost that a native path would avoid.
Statements of which path a given class of source is realistically likely to
take help the working group weight its investment.

## 3. Provider-native declaration document

**The question.** For a `provider_native` source, what document plays the role
the connector manifest plays for connectors — declaring the source's streams,
schemas, and selection capabilities?

**Why it matters.** For connectors, the manifest is the versioned, trusted
artifact against which the authorization server validates a request and renders
consent. A provider-native source needs an equivalent declaration, or consent
cannot be rendered and requests cannot be validated to the same standard. This
question is the concrete missing piece behind the provider-native path in
item 2: without it, provider-native remains a named kind without a defined
consent surface.

**Current v0.1 position** ([spec-core §5](https://www.pdpp.dev/docs/spec-core#selection-request)).
For provider-native sources, the streams, schemas, and selection capabilities
are currently reference-implementation convention rather than a specified
declaration. The consent surface is required to present the provider source's
declared streams under the same rendering obligations as the manifest
(Section 7), but the form and discovery of that declaration are not pinned.

**What input helps.** Prior art from ecosystems where a first party publishes
its own capability declaration (for example, well-known discovery documents or
capability manifests). A view on whether the connector manifest format should
be reused directly for provider-native sources, adapted, or replaced by a
provider-published discovery document.

## 4. Agent grant bundling

**The question.** Should Core standardize a grant-bundling primitive for agent
access — a way for one authorization to span multiple sources behind a single
token and base URL?

**Why it matters.** AI agents strongly favor a single credential and a single
endpoint. Today every source requires its own grant, so an agent that needs
several sources must juggle several grants and endpoints. Bundling exists only
as a reference-implementation feature, which means agents that rely on it are
depending on non-portable behavior. Standardizing it would make multi-source
agent access interoperable; declining to standardize it keeps the grant a
clean single-source consent artifact.

**Current v0.1 position** ([spec-core §6](https://www.pdpp.dev/docs/spec-core#grant)).
A grant is a single-source consent artifact: exactly one `source` per
authorization detail, and the resource server enforces one grant's constraints
against a token. There is no Core primitive that bundles multiple sources into
one authorization. The `agent_context` purpose code exists, and pre-registered
public client discovery aids agent onboarding, but neither bundles grants.

**What input helps.** Concrete agent-integration experience: how painful the
per-source-grant model is in practice, and whether bundling belongs in Core or
in a companion profile. Any design that preserves the grant's per-source
auditability and revocability while presenting a single token and base URL to
the client is of particular interest, as is an argument that bundling should
remain a deployment concern.

## 5. Authorization-server interface normativity

**The question.** At what point should a normative authorization-server
interface be standardized — endpoints for grant issuance, revocation, status
queries, and token introspection?

**Why it matters.** v0.1 pins the resource-server interface and the
introspection contract, which is enough for a client and a resource server to
interoperate. But grant issuance and revocation flows are left to the
deployment, so two conforming authorization servers may expose entirely
different issuance interfaces. Standardizing the authorization-server interface
too early risks freezing choices before implementation experience justifies
them; standardizing it too late leaves a portability gap for clients that must
target multiple authorization servers.

**Current v0.1 position** ([spec-core §2](https://www.pdpp.dev/docs/spec-core),
[§11](https://www.pdpp.dev/docs/spec-core)).
Authorization flows are deployment-specific in v0.1. Only the introspection
endpoint contract is normative; the full authorization-server interface is
informational. The reference implementation uses standard OAuth flows — the
authorization-code flow with RFC 9396 `authorization_details` for client
grants, and OAuth device authorization for owner tokens — but these are not
imposed on conformant implementations.

**What input helps.** A judgment on the readiness threshold: how much
cross-implementation experience the working group should require before
promoting the authorization-server interface to normative. Reports of concrete
interoperability friction caused by the current deployment-specific flows
carry the most weight.

## 6. Collection Profile as a companion standard

**The question.** Does the Collection Profile merit companion-standard status?

**Why it matters.** The Collection Profile's value is connector portability: a
connector written against it should run on any conformant runtime. That value
is only realized if the profile is a standard rather than a reference-specific
document. But its least-settled part is the browser-automation runtime
contract, and parts of it remain reference-specific. Elevating it prematurely
would standardize surfaces that are still moving; leaving it as reference
documentation keeps connector portability aspirational.

**Current v0.1 position** ([Collection Profile](https://www.pdpp.dev/docs/spec-collection-profile),
[voice-and-framing](voice-and-framing.md)).
The Collection Profile is framed as a *companion* specification, explicitly
optional: a conformant resource server can serve pre-collected, exported, or
manually imported data with no collection machinery at all. Within the profile,
several formerly reference-specific concerns have been promoted to normative
conformance items (the standard runtime bindings, no-secrets-in-STATE,
no-credential-logging), and browser automation is specified as a standard
CDP-over-WebSocket binding rather than a bespoke protocol. Companion-standard
status for the profile as a whole is not yet asserted.

**What input helps.** From runtime implementers: whether the browser-automation
binding and the other runtime requirements are stable enough to standardize.
From connector authors targeting more than one runtime: where the profile
still leaks reference-specific assumptions. A clear signal on which parts are
ready for companion-standard status and which should stay informative.

## 7. Erasure versus revocation semantics

**The question.** Should the protocol define an erasure signal — with delivery
and acknowledgment semantics — distinct from revocation?

**Why it matters.** Revocation and erasure are commonly conflated but are not
the same. Revocation stops future access; it does not request deletion of data
already disclosed to the client. A user who wants their disclosed data deleted
has no protocol-level way to signal that intent. But a real erasure signal is
more than a new event name: it requires recipient authentication, delivery and
retry semantics, acknowledgment behavior, auditability, and a defined
relationship to legal obligations that may override deletion. Improvising those
across the authorization server, resource server, and client boundaries would
be a mistake.

**Current v0.1 position** ([spec-core §6](https://www.pdpp.dev/docs/spec-core#grant),
[§10](https://www.pdpp.dev/docs/spec-core#security)).
The draft is explicit that revocation is not deletion. Revocation stops future
access only; records already delivered are governed by the grant's `retention`
policy and applicable legal obligations. The specification deliberately does
not overload revocation responses or introspection state to imply downstream
erasure, and no active erasure signal is defined in v0.1.

**What input helps.** Prior art on machine-to-machine deletion requests and
their acknowledgment (including how legal-hold and retention obligations are
represented). A view on whether erasure belongs in Core or in a companion
profile, and on the minimum acknowledgment semantics that would make an
erasure signal meaningful rather than advisory.

## 8. Trust registry and connector certification

**The question.** Should connector and client certification mechanics be
specified, and how should trust status appear on the consent surface?

**Why it matters.** The consent surface already distinguishes verified from
unverified clients, but it has no standardized notion of *why* a client or
connector is trusted. Without a certification model, "verified" means whatever
each deployment decides. A standardized trust registry and certification
process would make trust signals portable and comparable across
implementations; leaving them unspecified keeps trust a local, deployment-by-
deployment matter and risks inconsistent or misleading consent surfaces.

**Current v0.1 position** ([spec-core §5](https://www.pdpp.dev/docs/spec-core#client-display),
[§10](https://www.pdpp.dev/docs/spec-core#security),
[§11](https://www.pdpp.dev/docs/spec-core)).
Trust registry and connector certification are out of scope for v0.1. The
draft does define the hooks a trust model would use: the authorization server
must render a positive trust signal distinctly (for example, a "verified"
badge) and must treat clients without such a signal as unverified; it must
treat client-supplied logos as untrusted until accepted under local policy; and
it names trust-registry verification as one of the external mechanisms through
which retention and other policy declarations may be enforced. A formal
connector trust model is deferred, and the connector-trust guidance today is
advisory (sandboxing, trusted registries, runtime-mediated credentials).

**What input helps.** Prior art on certification and trust registries in
comparable ecosystems (app-store review, CA/Browser Forum practices, banking
trust frameworks). A view on what a connector or client certification should
attest to, who operates the registry, and how trust status should be rendered
on the consent surface without overwhelming or misleading the user. Governance
proposals for how a registry stays credible over time are welcome.

## 9. Conformance test suite

**The question.** What should a formal conformance test suite for PDPP roles
cover, and when should it be defined?

**Why it matters.** Conformance in v0.1 is defined by behavior — the numbered
obligations for each role — but there is no executable test suite to check an
implementation against those obligations. Without one, conformance claims are
self-asserted and hard to compare. A shared test suite would make "conformant"
a checkable statement; the risk is defining it before the role interfaces have
enough implementation experience to test the right things.

**Current v0.1 position** ([spec-core §9](https://www.pdpp.dev/docs/spec-core#conformance)).
The specification defines role-based conformance for authorization servers,
resource servers (Tier 1 Core and Tier 2 Collection Profile), connectors, and
clients as numbered behavioral obligations. A formal conformance test suite is
stated as planned but explicitly out of scope for v0.1.

**What input helps.** Which conformance obligations are most valuable to test
first, and which are hardest to test meaningfully. Experience from other
protocol conformance suites (structure, self-service versus witnessed testing,
how a suite is governed and versioned). Volunteers to help build reference
test vectors are welcome.

---

## Further open questions

The items above are the questions where community input most changes the
outcome. The following are also open and are tracked in full in
[Open Questions](https://www.pdpp.dev/docs/open-questions) and
[Deferred Concerns](https://www.pdpp.dev/docs/spec-deferred). They are grouped
here so that responses can reference them, and follow the same structure in
condensed form.

### Grant scope and consent shape

- **Semantic subset templates.** Should grants support manifest-declared,
  typed subset templates so consent can be bounded semantically ("only messages
  from this sender") rather than only by stream, fields, time range, and record
  ID? v0.1 narrows access by stream, view/field, time range, and explicit
  resource IDs only; semantically bounded subsets are modeled as named streams
  in the manifest, and request-time `filter[]` parameters narrow results but not
  grant scope. The recommended future direction — manifest-declared parameterized
  subset templates with typed bound parameters — and the open questions that must
  be resolved before specifying it are detailed in
  [Deferred Concerns](https://www.pdpp.dev/docs/spec-deferred). *Input helps:*
  real consent cases the named-stream approach cannot express well.

- **AI-training consent exception.** Should the protocol-level consent
  requirement for the `ai_training` purpose stand, be generalized to other
  purposes, or be removed? It is the one exception to `purpose_code` and
  `retention` being declarations enforced by contract rather than by the
  protocol ([spec-core §5](https://www.pdpp.dev/docs/spec-core#ai-training-consent)).
  *Input helps:* whether other purposes warrant the same protocol-level
  treatment, and the cost of the exception to implementers.

- **Child grants and delegation.** Should a future version support issuing a
  narrowed child grant to another party, such as an accountant? Grants are
  client-bound today, and the specification states no transfer or delegation
  boundary ([spec-core §6](https://www.pdpp.dev/docs/spec-core#grant)).
  *Input helps:* concrete delegation use cases and their revocation
  expectations.

- **Canonical view vocabulary.** Should view names such as `basic` and `full`
  carry consistent meaning across connectors, or remain connector-defined? v0.1
  leaves views connector-suggested, monotonically additive, with no default
  ([spec-core §7](https://www.pdpp.dev/docs/spec-core)). *Input helps:* which
  view names recur across real connectors.

- **`single_use` post-consumption.** After a `single_use` grant is consumed,
  should the specification require deletion, require retention as a consent
  record, or leave it to local policy?
  ([spec-core §6](https://www.pdpp.dev/docs/spec-core#grant)). *Input helps:*
  audit and privacy expectations for consumed one-time grants.

### Freshness, liveness, and lifecycle signals

- **Grant freshness mechanism.** Which mechanism should signed grants use to
  prove they are still in force: short expiry, a published status list, or
  introspection? A signature proves what was approved, not that the grant
  remains active ([spec-core §10](https://www.pdpp.dev/docs/spec-core#security)).

- **Request-side freshness requirements.** Should a client be able to require a
  maximum data age on a query, and is an unmet requirement an error or a
  warning? v0.1 prefers response-side freshness metadata (`captured_at`,
  `status`, `last_attempted_at`) before promising collection behavior a server
  may be unable to deliver
  ([spec-core §8](https://www.pdpp.dev/docs/spec-core#list-records)).

- **Re-interaction / session refresh.** Should the protocol define a signal
  that a connection needs fresh user interaction (expired source-side login,
  MFA), distinct from revocation? A `continuous` grant may stay valid while
  collection fails because source-side session state decayed; v0.1 asks that
  this be surfaced honestly as operational failure, not revocation
  ([Deferred Concerns](https://www.pdpp.dev/docs/spec-deferred)).

- **Evidence strategy per stream.** What evidence strategy should each stream
  declare, so that complete coverage, accepted partial coverage, retryable
  gaps, stale-but-known data, and missing instrumentation can be told apart?
  Today an uninstrumented stream reads the same as unknown
  ([Collection Profile](https://www.pdpp.dev/docs/spec-collection-profile)).

### Token and client hardening

- **Sender-constrained token trigger.** What condition should trigger
  *requiring* sender-constrained tokens (DPoP, mTLS) rather than recommending
  them over the bearer-plus-introspection baseline? v0.1 sets bearer tokens as
  the baseline and recommends sender-constrained tokens for sensitive standing
  access ([spec-core §10](https://www.pdpp.dev/docs/spec-core#security)).

- **Client ID Metadata Documents.** Should PDPP adopt Client ID Metadata
  Documents for client identity now, or wait for the IETF draft to stabilize?
  ([spec-core §3](https://www.pdpp.dev/docs/spec-core)).

### Collection model and data classes

- **Read-time resource-server mode.** Should Core define a resource-server mode
  that indexes a source and fetches records at read time rather than storing
  them? This affects freshness metadata, `changes_since`, and availability
  ([spec-core §8](https://www.pdpp.dev/docs/spec-core#resource-server-interface)).

- **Data classes in scope.** What classes of data is PDPP for? High-frequency
  telemetry, real-time streams, and large media are deferred without a stated
  principle ([spec-core §11](https://www.pdpp.dev/docs/spec-core)).

- **Event-driven collection.** Should webhook-triggered collection be specified
  as a companion profile? `access_mode` reserves room for an `event_driven`
  value ([spec-core §6](https://www.pdpp.dev/docs/spec-core#grant)).

- **Source lifecycle actions.** If source-side actions such as delete-after-
  export are added later, should they form a separately authorized action class
  in the grant, distinct from collection scope?
  ([spec-core §11](https://www.pdpp.dev/docs/spec-core)).

### Governance and extension process

- **Staging implementation-led changes.** What process should stage
  implementation-led changes into the normative specification? The reference
  implementation generates protocol pressure ahead of the spec text; the
  source-binding vocabulary change is the recent example
  ([spec-core §11](https://www.pdpp.dev/docs/spec-core)).

- **Companion profile contribution.** Who may propose a companion profile, what
  review applies, and when does a profile become official? Core defines how
  extensions behave but not how they are contributed
  ([spec-core §11](https://www.pdpp.dev/docs/spec-core)).

- **Interoperable audit-event format.** Should a companion profile standardize
  an interoperable audit-event format? Core defines the identifiers and state
  transitions that make auditing possible but no log format
  ([spec-core §11](https://www.pdpp.dev/docs/spec-core#security)).

---

## How to participate

This consultation is conducted in the open. Responses may take any of the
following forms:

- **A pull request against this repository.** Protocol changes are proposed
  through public pull requests; non-trivial protocol, reference-contract, or
  architecture changes are tracked with an OpenSpec change so reviewers can
  audit the rationale, tasks, and requirement deltas before implementation
  ([spec-core §11](https://www.pdpp.dev/docs/spec-core)).
- **An issue or discussion thread** referencing the agenda item by number or
  title.
- **A position document or prior-art writeup** attached to the relevant thread.

When responding, reference the agenda item and state which of the item's
requested inputs you are addressing. Positions grounded in a concrete use case,
an ecosystem precedent, or implementation experience are the most actionable.

Items resolved through this consultation move to the "Decided" record in
[Deferred Concerns](https://www.pdpp.dev/docs/spec-deferred), with the adopted
constraint and its rationale, and — where they change protocol semantics — into
the normative specification through the process above.

## Related

- [Open Questions](https://www.pdpp.dev/docs/open-questions) — the full ordered
  list this agenda draws from.
- [Deferred Concerns](https://www.pdpp.dev/docs/spec-deferred) — open questions,
  decided items with rationale, and implementation TODOs.
- [`spec-core.md`](../../spec-core.md) — the normative protocol.
- [`spec-collection-profile.md`](../../spec-collection-profile.md) — the
  companion Collection Profile.
- [`voice-and-framing.md`](voice-and-framing.md) — the register and framing
  rules this document follows.
