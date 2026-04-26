# Browser Binding Semantics Gap

Status: sprint-needed
Owner: Collection Profile / reference runtime
Created: 2026-04-26
Updated: 2026-04-26
Related: openspec/changes/design-host-browser-bridge-for-docker, Collection Profile `browser_automation` binding

## Question

How should a connector declare browser requirements without leaking reference-deployment mechanisms such as Docker host-browser bridge, noVNC, or future browser streaming into connector semantics?

## Context

The current host-browser bridge change solves a reference deployment problem: a Dockerized connector may need a browser window the owner can see and click. The implementation provides a host-side bridge and container-side env vars, but it does not yet define a rigorous protocol-level capability model for browser-backed connectors.

The important boundary:

- Connector semantics may say what kind of browser capability a run requires.
- Runtime bindings decide how that capability is realized.
- Reference mechanisms such as native Patchright, Docker host bridge, and future streamed browser are realization choices, not connector semantics.

## Stakes

If connectors declare "host bridge required", the Collection Profile leaks a reference deployment topology. If the runtime only infers interaction needs after an `INTERACTION kind=manual_action`, Docker can already be stuck driving an invisible in-container browser. The correct design likely requires a careful refinement of the existing `browser_automation` binding and runtime binding matching.

## Current Leaning

Do not add ad hoc connector fields for `host_browser_bridge`. Treat the current Docker behavior as a reference implementation obligation: when a browser-interactive run cannot be satisfied by the configured deployment, fail honestly with an actionable typed error rather than silently launching an inaccessible browser.

For a future spec change, investigate a capability model along these lines, with exact names and semantics still unsettled:

- profile persistence required vs optional
- owner-visible interaction required, may be required, or never required
- headless sufficiency
- whether the runtime-provided browser endpoint supports interaction handoff
- how these requirements appear in the manifest and/or the `START.bindings` payload

Any such change would require manifest validation, runtime binding matching, `START` payload semantics, failure semantics such as `unsatisfied_binding`, and conformance tests.

## Promotion Trigger

Promote this to a dedicated OpenSpec change before adding durable connector-manifest semantics, Collection Profile requirement language, or conformance tests for browser capability subfields.

## Decision Log

- 2026-04-26: Captured during Docker host-browser bridge review. Owner concern: "something like" is not acceptable for spec changes; defer normative binding refinements until they can be designed rigorously.
