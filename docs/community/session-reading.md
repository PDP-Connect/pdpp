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

## Session 2: Records, manifests, requests, and grants

This session covers four steps: describing records, declaring the data a
source can offer, requesting a subset, and recording the approved access in a
grant. It covers Core Sections 4–7. Section 8, the resource server interface,
follows in a later session.

### Required (about 30 minutes)

1. [PDPP Core, Sections 4–7](https://pdpp.dev/docs/spec-core#record-model).
   Focus on how the four sections fit together:

   - In Section 4: streams, `append_only` and `mutable_state` semantics,
     incremental sync, and the RECORD envelope.
   - In Section 5: what a manifest declares, the data and choices it makes
     available for consent, `consent_time_field`, views, and manifest
     versioning.
   - In Section 6: source kinds, stream and profile selection, and the
     difference between protocol-enforced constraints, structured policy
     declarations, and attributed client claims.
   - In Section 7: the immutable grant, its resolved enforcement fields,
     grant lifetime, data time range, access mode, version layering, and
     revocation.

   Skim the JSON examples and schemas. Use the field tables when a term is
   unclear. You do not need to memorize every member.

### Context (optional, about 5 minutes)

- UK Open Banking,
  [Account Access Consent elements](https://openbankinguk.github.io/read-write-api-site3/v4.0.1/profiles/account-and-transaction-api-profile.html#consent-elements):
  permissions, consent expiration, and the transaction date range. Compare
  these with PDPP's grant lifetime and data time range.

Questions for discussion:

- For a `provider_native` source, where do stream definitions, schemas, and
  consent metadata come from?
- Which selection-request fields can the protocol enforce, and how should
  consent distinguish policy declarations from client claims?
- Should an existing grant keep its resolved fields when its manifest or a
  view definition changes?
