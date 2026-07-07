---
title: "Open Questions"
description: "Open design questions for PDPP, ordered by importance. Consolidated from the deferred-concerns register, design notes, and review threads."
---

# PDPP Open Questions

Consolidated June 2026, ordered by importance. Each item is undecided. Decided items
and implementation TODOs are tracked in [Deferred Concerns](https://www.pdpp.dev/docs/spec-deferred).

1. When a selection request omits a selector, should the default be all available data
   or none? OAuth deployments typically default broad; Open Banking requires explicit
   selection. ([spec-core §5](https://www.pdpp.dev/docs/spec-core))

2. Which adoption postures should the design optimize for: platforms implementing the
   resource server natively, platforms endorsing a connector over their existing API,
   or community connectors covering platforms that do neither? The
   `connector`/`provider_native` distinction currently carries little design weight.
   ([spec-core §5](https://www.pdpp.dev/docs/spec-core))

3. Should Core standardize a grant-bundling primitive for agent access? Agents favor a
   single token and base URL; today every source requires its own grant, and bundling
   exists only as a reference-implementation feature. ([spec-core §6](https://www.pdpp.dev/docs/spec-core#grant))

4. Should grants support manifest-declared subset templates, so consent can be bounded
   semantically ("only messages from this sender") rather than only by stream, fields,
   time range, and record ID? ([Deferred Concerns](https://www.pdpp.dev/docs/spec-deferred))

5. Which freshness mechanism should signed grants use: short expiry, a published status
   list, or introspection? A signature proves what was approved, not that the grant is
   still in force. ([spec-core §10](https://www.pdpp.dev/docs/spec-core#security))

6. Does the Collection Profile merit companion-standard status? Its value is connector
   portability across implementations; its browser-automation runtime contract is the
   least settled part, and parts of it are still reference-specific.
   ([Collection Profile](https://www.pdpp.dev/docs/spec-collection-profile))

7. What process should stage implementation-led changes into the normative spec? The
   reference implementation generates protocol pressure ahead of the spec text; the
   source-binding vocabulary change is the recent example.
   ([spec-core §11](https://www.pdpp.dev/docs/spec-core))

8. Who may propose a companion profile, what review applies, and when does a profile
   become official? Core defines how extensions behave but not how they are
   contributed. ([spec-core §11](https://www.pdpp.dev/docs/spec-core))

9. At what point should a normative authorization-server interface be standardized?
   v0.1 pins only the resource-server interface and the introspection contract.
   ([spec-core §2](https://www.pdpp.dev/docs/spec-core))

10. Should the protocol-level consent requirement for AI-training purposes stand, be
    generalized to other purposes, or be removed? It is the one exception to
    `purpose_code` and `retention` being declarations enforced by contract rather than
    by the protocol. ([spec-core §5](https://www.pdpp.dev/docs/spec-core))

11. What condition should trigger requiring sender-constrained tokens (DPoP, mTLS)
    rather than recommending them over the bearer-plus-introspection baseline?
    ([spec-core §10](https://www.pdpp.dev/docs/spec-core#security))

12. Should the protocol define an erasure signal, with delivery and acknowledgment
    semantics, distinct from revocation? Revocation stops future access but does not
    request deletion of already-disclosed data. ([spec-core §6](https://www.pdpp.dev/docs/spec-core#grant))

13. Should a future version support issuing a narrowed child grant to another party,
    such as an accountant? Grants are client-bound and the spec currently states no
    transfer or delegation boundary at all. ([spec-core §6](https://www.pdpp.dev/docs/spec-core#grant))

14. What document plays the manifest's role for `provider_native` sources, declaring
    streams, schemas, and selection capabilities? Current semantics are
    reference-implementation convention. ([spec-core §5](https://www.pdpp.dev/docs/spec-core))

15. Should Core define a resource-server mode that indexes a source and fetches records
    at read time rather than storing them? This affects freshness metadata,
    `changes_since`, and availability.
    ([spec-core §8](https://www.pdpp.dev/docs/spec-core#resource-server-interface))

16. What classes of data is PDPP for? High-frequency telemetry, real-time streams, and
    large media are deferred without a stated principle. ([spec-core §11](https://www.pdpp.dev/docs/spec-core))

17. Should webhook-triggered collection be specified as a companion profile?
    `access_mode` reserves room for an `event_driven` value.
    ([spec-core §6](https://www.pdpp.dev/docs/spec-core#grant))

18. Should the protocol define a signal that a connection requires user interaction
    (expired source-side login, MFA), distinct from revocation?
    ([Deferred Concerns](https://www.pdpp.dev/docs/spec-deferred))

19. If source lifecycle actions such as delete-after-export are added later, should
    they form a separately authorized action class in the grant?
    ([spec-core §11](https://www.pdpp.dev/docs/spec-core))

20. Should a client be able to require a maximum data age on a query, and is an unmet
    requirement an error or a warning? ([spec-core §8](https://www.pdpp.dev/docs/spec-core#list-records))

21. After a `single_use` grant is consumed, should the spec require deletion, require
    retention as a consent record, or leave it to local policy?
    ([spec-core §6](https://www.pdpp.dev/docs/spec-core#grant))

22. Should view names such as `basic` and `full` carry consistent meaning across
    connectors, or remain connector-defined? ([spec-core §7](https://www.pdpp.dev/docs/spec-core))

23. Should PDPP adopt Client ID Metadata Documents for client identity now, or wait for
    the IETF draft to stabilize? ([spec-core §3](https://www.pdpp.dev/docs/spec-core))

24. Should a companion profile standardize an interoperable audit-event format? Core
    defines the identifiers and state transitions that make auditing possible but no
    log format. ([spec-core §11](https://www.pdpp.dev/docs/spec-core))

25. Should connector and client certification mechanics be specified, and how should
    trust status appear on the consent surface? ([spec-core §11](https://www.pdpp.dev/docs/spec-core))
