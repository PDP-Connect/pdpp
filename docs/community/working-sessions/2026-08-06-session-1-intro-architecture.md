# Session 1: Intro and architecture

6 August 2026

Sections covered: 1–3

These notes summarize the discussion. They do not change the draft specification.

## Summary

The first PDP-Connect working session introduced the Personal Data Portability
Protocol to an open community audience. The session covered the protocol
architecture, its foundations in OAuth 2.0 and RFC 9396, and its relationship
to standards such as SMART on FHIR and UK Open Banking. A live demonstration
connected an AI agent to personal data through PDPP and the reference
implementation's MCP interface.

## Discussion

### Protocol architecture

- PDPP defines how a person authorizes an application to access a bounded set
  of personal data and how a resource server enforces that authorization.
- It builds on OAuth 2.0 and RFC 9396 Rich Authorization Requests.
- Its main components are the selection request, grant, record model, connector
  manifest, and resource server interface.

### Live demonstration

- The demonstration connected ChatGPT memories to an AI agent through a
  personal server.
- The grant limited the agent to the selected data, showing granular consent in
  practice.

### Freshness and latency

- Continuous grants and incremental collection can provide ongoing access
  instead of a single point-in-time export.
- A user can collect data in the background into an environment they control,
  but this requires some setup.

### Data granularity

- A source's schemas and, for connectors, its manifest define the streams and
  fields that can be selected.
- Optional query capabilities include lexical and semantic search,
  aggregation, and range filters.

### Data portability landscape

- Participants discussed lessons from earlier portability efforts, including
  whether a standard must be sufficiently opinionated to support adoption.
- PDPP v0.1 is neutral about storage and identity so it can be implemented in
  different environments.
- Buzz was raised as a possible project for collaboration. Write support is not
  part of PDPP v0.1.

### Jurisdiction and data custody

- Participants discussed whether user-controlled storage could reduce central
  custody and how jurisdiction would apply in a decentralized system.
- PDPP does not require a particular storage or custody model. These remain
  implementation choices.

## Decisions

No protocol decisions were made. This was an introductory session.

## Open questions

- How should PDPP implementations operate in restricted network environments?
- How opinionated should PDPP be about identity and storage?
- Should a later version evaluate GNAP as an alternative authorization
  foundation?

## Next steps

- Session 2 on 13 August will cover the record model and selection request,
  Sections 4–5 of the core specification.
- Community feedback is welcome in the PDP-Connect channel on the LFDT Discord.

[Watch the Session 1 recording](https://www.youtube.com/watch?v=ncHmzE7oPQ4).
