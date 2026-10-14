# Review update: changes after the first comment period

13 October 2026

Document covered: PDPP v0.1.0 revisions from the formal review (draft in #374)

These notes summarize the discussion. They do not change the draft specification.

## Summary

Tim presented the changes made to PDPP after the first public review of the
v0.1 draft. Most fall into three groups: more control for data owners, more
clarity for applications requesting data, and room for the protocol to grow.
PDPP v0.1.0 locks on Monday 26 October 2026.

## Discussion

### Control for data owners

Owners can narrow consent. A grant covers one purpose, and a request can ask
for several. Each approved purpose becomes its own grant (#384).

A grant can name a grantor when the person who approves it is not the data
subject, such as a parent approving access to a child's records. The grantor's
capacity is recorded with the grant. The protocol can express this relationship
with verifiable evidence. Specific verification methods, such as DIDs or
zero-knowledge proofs, would need separate profiles. Those profiles can build
on one another.

### Clarity for applications

Consent text can be provided in several languages, using BCP 47 language tags.
Different applications receive different identifiers for the same person, which
protects privacy. Data freshness tracking, syncing fixes, and partial records
are also covered. Work on data provenance is in draft in #373.

### Tokens and authorization

Single-use access tokens must have a finite lifetime, so non-expiring
single-use tokens no longer conform. The design leaves room for authorization
protocols beyond OAuth. OAuth 2.0 and RFC 9396 are the v0.1 binding, and other
bindings, such as GNAP, may follow.

AI training permissions and consent withdrawal are still being worked on. A
"lease" mechanism for consent withdrawal is under consideration.

### Data use

The standard provides protections through grant agreements and terms. It cannot
guarantee how data is used once it reaches an application. Stronger technical
assurances, such as trusted execution environments, are outside the standard.

### Standardization and composability

The project chose not to mandate common data schemas. PDPP aims to stay a small
core. It composes with existing standards, such as C2PA, through extensions and
profiles.

## Decisions

- PDPP v0.1.0 locks on Monday 26 October 2026.
- A grant covers one purpose (#384).
- Non-expiring single-use access tokens no longer conform (#374).
- Common data schemas are not mandated.

## Open questions

- How should consent withdrawal work? A "lease" mechanism is under
  consideration.
- Which verification methods, such as DIDs or zero-knowledge proofs, need
  separate profiles?

## Next steps

- Tim to ship most, if not all, of the pull requests discussed over the next
  few weeks.
- Contributors: review and comment on the draft pull requests, especially #374
  and #373, over the next week.
- Community: give feedback on the proposed "lease" mechanism for consent
  withdrawal once its pull request is up.
- Community: join #pdp-connect on the LF Decentralized Trust Discord.
- Viewers: go to pdpp.dev and declare support for the PDPP principles.

[Watch the review update recording](https://www.youtube.com/watch?v=NyLKxMz-swU).
