# Conformance suite design constraints (2026-08-29)

Status: design note, not normative. Grounds the suite that GOVERNANCE.md §4.6
commits to publishing within three months of programme live, and records
which choices follow precedent and which would be PDP-Connect originals.
Prior-art grounding: OpenID certification, Certified Kubernetes, ONC/Inferno
(FHIR), UK Open Banking conformance tooling (corpus entry:
conformance-claims-are-scoped-per-profile-not-globally...).

## 1. Claims are scoped, never global

Every peer program scopes a conformance claim along role, profile or tier,
and specification version. OpenID certifies per profile (Basic OP, FAPI OP);
ONC certifies per numbered criterion; Certified Kubernetes binds product
type and minor version; UK Open Banking splits functional and security
suites. None grants a global "conforms."

The suite therefore reports per Core §9 surface: authorization server,
resource server tier 1, resource server tier 2 (optional), connector,
client — each against a named spec version. A Verified Operator claim
states which surfaces and version it covers. (Governance change proposed
separately.)

## 2. Integrity model: reproducibility, not submission-time policing

Peers deter fabricated results through public raw results anyone can re-run
(Kubernetes), signed declarations plus a revocable mark (OpenID), or
accredited third-party testing in the regulated case (ONC). PDP-Connect's
§4.7–§4.8 (public register, withdrawal on evidence, appeals) already follow
the first two patterns. The suite publishes raw, re-runnable results with
each submission.

**Open decision, no precedent either way:** requiring that the suite run
against the endpoint named in the public register, rather than an
applicant-chosen instance. No peer program requires this; Kubernetes and
OpenID accept applicant-submitted evidence from any instance. Adopting it
would be a PDP-Connect original strengthening — defensible because our
register binds a status to a running service, but it must be argued on its
own merits. If adopted, it belongs in GOVERNANCE.md §4.6 (claim-shape rules
live in the certifying body's process documents in every peer program), not
in the suite documentation.

## 3. The suite provisions its own data

Grant enforcement cannot be tested against an empty implementation. The
suite acts as owner and client: it creates a synthetic account, seeds known
records, then exercises consent, projection, incremental sync, and
revocation against known answers. Inferno (the only peer whose subject is a
PII-bearing data system) solves this the same way — simulated components
ship inside the test kit, with production data explicitly out of scope.

For connector-backed operators the ingest path makes seeding
straightforward. For provider-native implementations, seeding implies
sandbox or test accounts at the provider. External review has already asked
for exactly this (limited test accounts so small organisations can
prototype); the suite requirement and that request should be designed
together.

## 4. Source assessment includes declaration accuracy

Source statuses are assessed, not tested, but part of the assessment is
mechanical: records must validate against the declared schemas, and
semantics labels must match observed behaviour. The remainder is judgment:
display text honestly describing what a field reveals. Assessment criteria
should name both halves, and the mechanical half can reuse the suite's
schema-validation machinery.

## Non-goals

No version-numbering scheme is imposed on source declarations (ordering and
diffability suffice; grants pin declaration versions already). No suite
requirement reaches into governance beyond the two items noted above.
