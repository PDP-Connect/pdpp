# PDP-Connect session reading

> Working draft: this list may change as working-session agendas take shape.

## Session 1: Architecture overview

We will establish a shared picture of PDPP, where it fits among adjacent
portability efforts, and the authorization model it builds on.

Frame adjacent standards as complementary. PDPP defines consent and access.
Other efforts define trust, transfer, archive formats, or different storage
models.

### Required (about 20 minutes)

1. [PDPP Core, Sections 1–3](https://pdpp.dev/docs/spec-core)
   (about 15 minutes): Introduction, Terminology and Actors, and System
   Architecture. Stop before Section 4.
2. [PDPP Core, Appendix B](https://pdpp.dev/docs/spec-core#appendix-b-relationship-to-the-data-transfer-project-dti)
   (about 5 minutes): how PDPP and the Data Transfer Project compose.

### Foundations (skim if unfamiliar)

- [OAuth 2.0](https://www.rfc-editor.org/rfc/rfc6749.html), Sections 1.2 and
  1.3.1: the authorization-code flow at a high level.
- [RFC 9396: OAuth 2.0 Rich Authorization Requests](https://www.rfc-editor.org/rfc/rfc9396.html),
  Abstract and Sections 1, 2.1, 3, and 3.1. These sections introduce the
  `authorization_details` envelope that PDPP uses.

Questions we will explore:

- Are the boundaries between PDPP and DTP, PDPA, the Data Trust Registry from
  DTI, and Solid clear?
- Does `authorization_details` give PDPP the right authorization envelope?

### Context (optional)

- [GDPR Article 20](https://eur-lex.europa.eu/eli/reg/2016/679/ojv). It defines
  the right to receive personal data in a common machine-readable format and
  transmit the data to a different controller.

- [Digital Markets Act, Article 6(9)](https://eur-lex.europa.eu/eli/reg/2022/1925/2022-10-12/eng):
  portability and continuous, real-time access for end users and authorized
  third parties.

- [What is the Data Transfer Project?](https://dtinit.org/docs/dtp-what-is-it)
  gives a short introduction. For more detail, read the Architecture and
  System Components sections of
  [DTP Overview and Fundamentals](https://dtinit.org/assets/dtp-overview.pdf).

- The IETF
  [Personal Data Portability Archive](https://datatracker.ietf.org/doc/draft-ietf-mailmaint-pdparchive/)
  draft describes an emerging archive format. Read the Abstract and
  Introduction. The relationship between PDPA and PDPP remains open.

- Johann Kranz et al.,
  [“Data Portability”](https://doi.org/10.1007/s12599-023-00815-w),
  especially Sections 4.2–4.4: a peer-reviewed survey of portability
  platforms, open protocols, and personal data stores. This paper provides
  context, not normative guidance.

## Session 2: Records, source declarations, and requests

This session covers three steps: describing records, declaring the data a
source can offer, and requesting a subset. It covers Core Sections 4–6.
Section 7, the grant, and Section 8, the resource server interface, follow in
a later session.

### Required (about 23 minutes)

1. [PDPP Core, Sections 4–6](https://pdpp.dev/docs/spec-core#record-model).
   Focus on how the three sections fit together:

   - In Section 4: streams, `append_only` and `mutable_state` semantics,
     incremental sync, and the RECORD envelope.
   - In Section 5: what a source declaration covers (earlier materials
     called this the manifest), the data and choices it makes available for
     consent, `consent_time_field`, views, and declaration versioning.
   - In Section 6: source kinds, stream and profile selection, and the
     difference between protocol-enforced constraints, structured policy
     declarations, and attributed client claims.

   Skim the JSON examples and schemas. Use the field tables when a term is
   unclear. You do not need to memorize every member.

### Context (optional, about 5 minutes)

- UK Open Banking,
  [Account Access Consent elements](https://openbankinguk.github.io/read-write-api-site3/v4.0.1/profiles/account-and-transaction-api-profile.html#consent-elements):
  permissions and the transaction date range. Compare these with PDPP's
  selection-request streams and time range.

Questions for discussion:

- For a `provider_native` source, where do stream definitions, schemas, and
  consent metadata come from?
- Which selection-request fields can the protocol enforce, and how should
  consent distinguish policy declarations from client claims?
- When a source's declaration changes — a view gains new fields, or a view
  definition itself changes — should a client that already selected that
  view see the update automatically, or does every such change require a new
  selection?

## Session 3: Grants and the resource server interface

This session covers the two halves of enforcement: the grant, the durable
record of what the user approved, and the resource server interface, where
every read is checked against that record. It covers Core Sections 7–8.

### Required (about 23 minutes)

1. [PDPP Core, Sections 7–8](https://pdpp.dev/docs/spec-core#grant).
   Focus on how the two sections fit together:

   - In Section 7: grant fields and resolved stream grants, access modes
     (`single_use` and `continuous`), time concepts and version layering,
     grant narrowing, records from revoked grants, and retention.
   - In Section 8: grant enforcement, token introspection, the read
     endpoints and `changes_since`, and the error model.

   Skim the JSON examples and field tables. The enforcement rules matter
   more than any individual member.

2. If time allows, skim Sections 9–11 (Conformance, Security, Privacy),
   about 10 minutes. These sections do not get their own session; the
   final session covers governance.

### Context (optional, about 5 minutes)

- [RFC 7009, Section 2.2](https://www.rfc-editor.org/rfc/rfc7009.html#section-2.2):
  OAuth token revocation invalidates the token going forward and says
  nothing about data already disclosed. Compare with PDPP's records from
  revoked grants.
- [Plaid /transactions/sync](https://plaid.com/docs/api/products/transactions/#transactionssync):
  production cursor-based incremental sync returning added, modified, and
  removed items. The same shape as PDPP's `changes_since`.

Questions for discussion:

- When a source declaration or a view changes, should an existing grant
  keep serving its resolved fields unchanged, and how does a client move to
  the new shape? (Carried from session 2.)
- Revocation stops future access only. Is that the right boundary, and what
  should retention commitments promise about records already delivered?
- Should the resource server interface ever offer bulk export — a
  grant-scoped archive produced on a schedule — alongside the live read
  API?
