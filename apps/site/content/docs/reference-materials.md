---
title: "Reference Materials"
description: "Supporting documentation for the Personal Data Portability Protocol: implementation notes, design rationale, and reference topology."
---

<Callout type="info" title="Reference materials">
  These documents provide implementation details, design rationale, and architectural context for PDPP. They are not part of the normative protocol specification.
</Callout>

The specification defines the protocol. These materials provide additional context, implementation guidance, and design decisions behind that specification.

- **[Reference Topology](/specification/spec-architecture)** — How the current PDPP reference components relate: native provider, polyfill path, runtime, and client flows.
- **[Reference Implementation Notes](/specification/reference-implementation)** — Current behavior of the forkable reference stack, not normative protocol requirements.
- **[Auth Design](/specification/spec-auth-design)** — Design rationale for bearer token semantics at protocol boundaries.
- **[Change Tracking](/specification/spec-change-tracking)** — Design rationale for grant-relative incremental sync via `changes_since` cursors.
