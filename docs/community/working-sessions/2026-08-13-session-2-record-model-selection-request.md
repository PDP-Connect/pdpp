# Session 2: Record model and selection request

13 August 2026

Sections covered: 4–6

These notes summarize the discussion. They do not change the draft specification.

## Summary

The second PDP-Connect working session covered how personal data is represented
in PDPP and how a client requests access to it. Tim walked through the record
model, the data source manifest, and the selection request, with Anna
contributing on design trade-offs. Discussion focused on the decision not to
impose a canonical data model, the limits of what the protocol can enforce in a
consent flow, and where identity, provenance, and trust sit relative to the
spec.

## Discussion

### Record model and streams

- PDPP uses a cursor-based streaming model rather than static point-in-time
  queries, so changes to data can be tracked over time.
- Records are distinguished as append-only or mutable, which can simplify the
  rules both clients and servers follow. Whether the distinction earns its
  complexity remains an open question.
- PDPP does not enforce a canonical data model. Data is modelled according to
  its own domain rather than translated into a shared shape. This raises the
  cost of aggregating across sources but lowers the barrier to adoption, and
  AI agents are increasingly capable of working across diverse schemas.

### Selection requests and consent

- Clients initiate access requests and must specify which streams and fields
  they want and what they intend to use them for. Some streams can be marked
  optional so users retain control over what they share.
- Clients should not be able to see the full inventory of what a resource
  server holds. One direction discussed was using OAuth scopes to define what
  level of visibility a client gets.
- Consent involves three distinct categories: rules the protocol can enforce,
  machine-readable claims about intended use, and free-text messages to the
  user that cannot be consumed programmatically. Keeping enforceable and
  unenforceable claims visually and semantically separate matters,
  particularly for AI training.

### Standardization and common vocabulary

- An attendee raised the balance between standardization and flexibility: a
  standard should give a safe, interoperable frame while leaving room for data
  elements specific to a given company or context. Common definitions for
  basic fields such as addresses would help portability.
- Tim suggested drawing on existing resources such as schema.org and the DTP
  data models where common definitions are useful.

### Identity, provenance, and trust

- An attendee described the practical problem of identity standardization
  across platforms, and a solution using a persistent wallet-based identity
  that carries across environments.
- Trust and provenance become harder when a third party builds the adapter to
  a data source rather than the source integrating directly.
- The group discussed whether verification and provenance belong in the core
  protocol or a later extension. The direction favoured was a flexible
  approach supporting different verification levels depending on the use case,
  rather than uniform strict verification.

## Decisions

None formally taken. Direction of travel favours flexible, use-case-dependent
verification over a uniform requirement.

## Open questions

- Should clients be able to query the full inventory of available streams, and
  how should access to inventory information be scoped?
- Should provenance and trust be handled in the core protocol or as a later
  extension, and does that differ for data connectors versus direct
  integrations?
- How much common vocabulary should the spec borrow for shared fields such as
  addresses?
- How should the protocol handle the growing volume of agent-generated data,
  and the blurring line between human and AI-generated content?

## Next steps

- Tim to determine this month how inventory querying and scoping should work.
- Tim to explore provenance and trust handling in the current spec iteration,
  including whether a trust registry or proof mechanism is warranted.
- Tim to document a range of use cases including edge cases such as
  large-scale agent data, medical data, and personal notes, to pressure test
  the design.
- Community: share use cases and references in the PDP-Connect channel or in
  future sessions.
- Session 3 on 20 August will cover the grant and the resource server
  interface, Sections 7–8 of the core specification.

[Watch the Session 2 recording](https://www.youtube.com/watch?v=V_EkmK-7b9c).
