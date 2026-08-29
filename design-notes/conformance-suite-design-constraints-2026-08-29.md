# Conformance suite design constraints

Status: captured
Created: 2026-08-29

The governance draft commits PDP-Connect to publishing a conformance test suite within three months of the programme going live, and gates the Verified Operator status — the register's public finding that an operator's implementation passed the suite — on that publication. No document records the constraints that make such a suite trustworthy: what a conformance claim covers, how self-run results stay honest, where test data comes from, and what assessing a source actually checks. This note records those constraints, with the precedent behind each, so the suite is designed once rather than corrected after it ships. One proposal here has no precedent anywhere and is labeled as such.

## Claims are scoped, never global

Section 9 of the core specification (spec-core.md) defines conformance separately per role: the authorization server, the resource server (in two tiers, the second optional), the connector, and the client — each against a versioned specification. Every peer conformance program scopes claims the same way. OpenID certifies implementations into named profiles (Basic OpenID Provider; FAPI, its financial-grade profile), never "certified for OpenID Connect." US health-IT certification under ONC, the Office of the National Coordinator, is per numbered criterion. Certified Kubernetes binds a claim to a product type and an exact Kubernetes minor version. UK Open Banking runs its functional and security conformance as separate suites. None of them grants a global pass.

The suite therefore reports results per Section 9 surface, each against a named specification version, and a Verified Operator claim states which surfaces and which version it covers. A companion governance change adds that sentence to the Operator status definition.

## Integrity comes from reproducibility, not submission-time policing

A self-run suite can always be run against a doctored build, so peer programs do not try to prevent dishonest submissions; they make dishonesty pointless after the fact. Certified Kubernetes publishes the raw test output with every submission and anyone can re-run the identical open-source suite. OpenID pairs published results with a signed declaration and a certification mark that can be revoked. The regulated outlier is ONC, which uses accredited third-party testing bodies — heavier machinery than a young programme needs. The governance draft's public register, withdrawal on evidence, and appeal path already follow the lighter pattern; the suite's contribution is that every submission includes raw, re-runnable output.

One open decision has no precedent in any program studied: requiring that the suite run against the endpoint named in the public register, rather than an instance of the applicant's choosing. Kubernetes and OpenID both accept evidence produced against any instance, including private or ephemeral ones. Requiring the registered endpoint would be a PDP-Connect original, defensible because our register binds a status to a specific running service rather than to a distributable product, but it has to be argued on its own merits rather than presented as standard practice. If adopted, it belongs in the governance document's Operator status section, because in every peer program the rules about what a claim attaches to live in the certifying body's own process documents, not in the test tooling's documentation.

## The suite provisions its own data

Grant enforcement cannot be tested against an empty implementation: proving that a read returns only granted fields requires known records behind the grant. The suite therefore acts as both owner and client — it creates a synthetic account, seeds records whose contents it knows, and then exercises consent, projection, incremental sync, and revocation against known answers. The one peer program whose test subject is a personal-data system solves it the same way: Inferno, ONC's test kit for FHIR (the health-data API standard) servers, ships simulated components inside the kit and puts production data explicitly out of scope.

For connector-backed operators the ingest path makes seeding straightforward. For provider-native implementations, seeding implies sandbox or test accounts at the provider. External reviewers have already asked for limited test accounts so that small organisations can prototype; that request and this suite requirement are the same capability and should be designed together.

## Assessing a source means checking the declaration tells the truth

Source statuses are assessed rather than tested, but part of the assessment is mechanical: collected records must validate against the declared schemas, and declared semantics must match observed behaviour. The rest is judgment: whether the display text honestly describes what a field reveals. The published assessment criteria should name both halves, and the mechanical half can reuse the suite's schema-validation machinery rather than growing its own.

## Non-goals

No version-numbering scheme is imposed on source declarations; the change process needs ordering and diffability, which any monotonic version gives, and grants already pin the declaration version they were issued against. Nothing in this note requires governance changes beyond the claim-scoping sentence above and, if adopted, the registered-endpoint rule.
