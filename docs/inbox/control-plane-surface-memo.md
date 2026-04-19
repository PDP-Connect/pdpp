# PDPP Control-Plane / Surface Architecture Memo

Date: 2026-04-16

## Bottom line

PDPP should introduce a live control-plane surface and a local orchestration layer, but neither should be allowed to absorb the illustrated landing page. The public reference page should stay a curated narrative. The control plane should stay operational and stateful. Docker Compose should stay an assembly mechanism for the reference stack. A shared event/trace spine should keep both views honest and aligned.

This follows the repo’s existing split:

- `spec-core.md` and `spec-collection-profile.md` are normative.
- `/` is the illustrated reference.
- `/design` is the component/specimen workbench.
- the e2e stack is the live substrate.

The missing piece is not another all-purpose surface. It is a clean operational surface over the same substrate the landing page already illustrates.

## Surfaces we actually need

| Surface | Audience | Job | Should not do |
|---|---|---|---|
| Illustrated landing page | prospects, reviewers, implementers | explain why PDPP matters and show one canonical proof chain | become an ops console or a stack tutorial |
| Live control plane | engineers, operators, presenters | start runs, inspect grants, watch collection, inspect traces, revoke, reseed | become marketing copy or spec text |
| Docs/spec surface | implementers, standards readers | define the protocol and its companion profile(s) | pretend to be the live system |
| Design/system surface | designers, implementers | inspect components, specimens, and visual rules | carry the main story |
| CLI | power users, operators | self-export, query, debug, verify | become a hidden admin UI |
| Docker Compose | local developers, CI, demo runners | assemble the reference stack reproducibly | become a product surface |

The landing page answers `why should I care?`
The control plane answers `what is running right now?`
The docs answer `what is normative?`
The design page answers `what are the reusable parts?`
Compose answers `how do I bring the stack up locally?`

## Why one surface should not do every job

The repo already shows the failure mode: when one surface tries to explain, operate, and prove everything, it becomes either a dashboard with marketing copy or a landing page with operational noise.

Those jobs have different audiences and different update rates:

- The illustrated page needs stability, pacing, and persuasion.
- The control plane needs volatility, actionability, and current truth.
- Compose needs determinism and assembly, not narrative.
- The docs need precision and normative boundaries.

If we fuse them, we get bloat in two directions at once:

- the public story gets cluttered with logs, health checks, and service wiring
- the operational surface gets diluted into a theatrical walkthrough

So the right rule is: one substrate, multiple projections.

## Recommended shape of the control plane

The live control plane should be a stateful operational surface over the reference stack, not a second landing page.

It should show:

- current grants and their lifecycle
- active and past collection runs
- connector/runtime health
- a trace or event timeline
- collection status and errors
- reseed/reset controls for demos and tests

It should be good at answering:

- what is currently active
- what happened most recently
- what failed and why
- what can be replayed or revoked

It should not try to teach the protocol from scratch. The illustrated landing page already does that job.

## Docker Compose: yes, but only as substrate

Compose is worth introducing if it serves reproducibility and local truth.

Use it for:

- booting the reference stack consistently
- declaring which services belong to the live substrate
- keeping the e2e and demo worlds from drifting apart
- making the control plane and illustrated flow run against the same environment

Do not use it for:

- hidden product behavior
- a new abstraction layer over the protocol
- an end-user UX

If Compose becomes a way to explain the system, it has already become too visible. Its job is assembly.

## Shared substrate that keeps live and illustrated aligned

The live control plane and the illustrated flow should read from the same canonical substrate:

- one request / consent / grant model
- one record and state model
- one run and trace model
- one identifier scheme for `grant_id`, `run_id`, `client_id`, `connector_id`, `stream`, and correlation IDs
- one fixture/scenario registry

The most important piece is an append-only event / trace spine.

That spine should capture the protocol and runtime truth in a single sequence of typed events, such as:

- request received
- consent shown
- grant issued
- run started
- record ingested
- state advanced
- revoke issued
- query returned
- error emitted

Then:

- the live control plane renders the full spine and the current state projections
- the illustrated landing page renders a curated narrative projection of the same spine
- tests assert against the same scenario ids and event order

That is how the live system and the illustrated story stay aligned without becoming the same surface.

## Relationship to the illustrated landing-page flow

The landing page should stay editorialized and selective.

It should:

- show the happy-path proof chain
- collapse noisy operational detail
- use the trace spine only as needed to prove the story
- remain readable without requiring the reader to understand orchestration

The control plane should do the opposite:

- show the full operational reality
- expose failures, retries, revocations, and collection state
- make it easy to inspect what the landing page is summarizing

In short:

- the landing page is the story
- the control plane is the evidence
- the trace spine is the truth source

## Anti-bloat rules

1. Do not add a new surface unless it has a different primary audience and a different primary question.
2. Do not let the public landing page become a runtime console.
3. Do not let the control plane become a second marketing page.
4. Do not add a widget unless it can be derived from the canonical event / trace spine or the canonical state model.
5. Do not introduce a new representation of request, grant, run, or record unless it is a projection of the canonical one.
6. Do not let Compose define product behavior; it only defines assembly.
7. Do not let the illustrated flow drift from live behavior; both must be explainable by the same scenarios and identifiers.

## Recommendation

Introduce three things, in this order:

1. A canonical event / trace spine with stable identifiers and scenario fixtures.
2. A live control-plane surface that reads that spine and manages the running stack.
3. Docker Compose as the local assembly layer that boots the same substrate for dev, demo, and e2e.

Keep the illustrated landing page separate and curated. That separation is what prevents the reference from bloating into a single surface that is trying to be a demo, an ops console, a spec, and a product page at once.
