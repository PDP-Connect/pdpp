# Session 3: Grants and the resource server interface

20 August 2026

Sections covered: 7–8

These notes summarize the discussion. They do not change the draft specification.

## Summary

The third PDP-Connect working session covered the grant, the immutable record
of a user's consent, and the resource server interface that enforces it on
every read. Tim walked through grant scope and terms, access modes,
revocation, and the query surface. Discussion turned to reuse of existing
standards, adoption strategy, delegated approval, and changes in client
ownership.

## Discussion

### Grants and revocation

- A grant is an immutable record of the permissions a user gave a client for
  a specific source: streams, fields, time constraints, purpose, and terms.
  Scope reduction is revoke-and-reissue.
- Enforcement resolves tokens through introspection; positive results cache
  for at most 60 seconds, which bounds revocation latency. Self-contained
  JWTs are permitted as an optimization, at the cost of revocation waiting
  for token expiry.
- Client query capabilities are deliberately narrower than owner capabilities
  in v0.1. Future extensions may widen them.

### Reusing existing standards

- An attendee pointed to related IETF work, noting PDPP already profiles Rich
  Authorization Requests and could lean on existing drafts rather than
  specifying afresh, including a draft extending RAR metadata.
- WebDAV's REPORT method and sync tokens behave much like PDPP's cursors and
  handle synchronizing large collections. Cursor-based sync is a well-trodden
  problem: rsync, XMPP, JMAP, MCP, ActivityPub, GraphQL, Atom, Solid, and
  WebDAV all take positions on it.

### Adoption

- An attendee with long experience promoting standards to platforms holding
  personal data observed that platforms consistently prefer in-house
  implementations. The obstacle is not the absence of a standard.
- The data connector deployment option lets PDPP build a working
  implementation without waiting for platforms. The eventual shape may
  resemble MCP: something that sits on top of existing systems rather than
  requiring them to change, accepting that conformance may be partial and
  some optional features unsupported.

### Access paths

- PDPP has focused on continuous sync rather than Takeout-style bulk export.
  Export is the easier problem once data is on a server, so the spec started
  with the harder one. Other access paths may be worth defining explicitly.

### Delegation and ownership

- Delegating grant approval to an AI agent, with auditable automation and
  policies for what can be auto-approved: nothing in PDPP prevents an
  agent-mediated authorization flow, and the decoupling from any single
  authorization protocol means GNAP or another mechanism could carry it.
- Change of legal ownership: if a client is acquired or restructures, should
  that prompt revocation? The user granted access on assumptions about that
  specific relationship. The same question applies to previously undisclosed
  sub-processors. One suggestion was requiring clients to report ownership
  type.
- ISO MyTerms was raised as adjacent work covering the terms under which
  first parties hold bulk user data, an area where users currently have no
  control.

## Decisions

None formally taken.

## Open questions

- How should subgrants work — a grant recipient passing a smaller piece of
  its access to someone else — and do they belong in the spec?
- Should PDPP adopt or reference the IETF RAR-metadata work and WebDAV's
  REPORT and sync tokens rather than specifying equivalents afresh?
- Do user-specified terms belong in the standard, and should common terms
  live in a separate document with authorization servers holding templates?
- Should a change of client ownership or undisclosed sub-processing trigger
  anything protocol-side?
- Should additional access paths be defined, including bulk export?
- How does ISO MyTerms relate to PDPP: overlap or complement?

## Next steps

- Tim to investigate subgrants and how they might fit the spec.
- Tim to review the IETF RAR-metadata draft and WebDAV's REPORT and sync
  tokens for possible reuse.
- Tim to consider protocol support for user-specified terms, including
  changes of legal ownership and outsourcing.
- Tim to continue conformance work: test suites and making it easier for
  platforms to conform, ahead of the public announcement.
- Session 4 on 27 August covers governance, led by Art.

Recording link to follow.
