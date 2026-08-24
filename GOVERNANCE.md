# Governance, Membership and Conformance

**Status:** Pre-consultation draft. Not open for formal review.
**Circulated:** 24 August 2026
**Formal review:** Opens 3 September 2026 at GDC. Closes 1 October 2026.
**Programme live:** 1 October 2026
**Applies to:** PDP-Connect programme documents. Not part of the normative protocol.

Nothing in this draft is settled. It is circulated now so that it can be argued with before it is fixed, and it will change in response.

From 3 September 2026 the specification and this document are locked for the duration of the formal review period. No change is made to either during that window except to correct a factual error, and any such correction is published with its date and its ground.

Every comment received during formal review is logged and given a disposition: accepted, declined with a reason, or deferred. The comment resolution log is published.

Where review produces material change, or where a material question remains in dispute at close, the changed text goes out for a further 15-day review before it is final. Non-material change proceeds to publication.

---

## 0. What this is, for readers new to PDPP

**The protocol.** PDPP is an open protocol for scoped access to personal data. Today, when you let an app use your data from a platform, the choice is usually all of it or none of it, and after you click nothing records what you actually agreed to. PDPP turns that click into a durable, specific record: these fields, this date range, this purpose, for this long. A machine then checks every later request against that record and refuses anything outside it.

**Why a protocol needs governance.** A protocol is a document. Anyone can write one; the hard part is getting people to adopt it, and getting anyone to believe a party that says it complies actually does. That belief has to come from somewhere, and the somewhere is a body that publishes criteria, checks claims against them, and takes the claim away when it turns out to be false. This document defines that body, who elects it, and what it may and may not do.

**Three kinds of party.** Data comes from somewhere, an application asks for some of it, and machines record and enforce what was approved. The programme calls these Source, Accessor and Operator. Every conformance status belongs to exactly one of them.

**What conformance status is.** It says a party has been checked against published criteria and the result is published where anyone can read it. It is not a licence, and it is not required. Anyone may build on PDPP without holding a status, joining anything, or dealing with PDP-Connect at all. That is stated in §1 and it cannot be amended.

**What membership is.** Separate from conformance. Membership records what a company has publicly committed to, from a statement of support up to operating without ever holding user data. It costs nothing, and it confers no conformance status.

**Where this sits.** PDP-Connect is a Lab of LF Decentralized Trust, part of the Linux Foundation. The specification and reference implementation are open source. This document governs the programme around them, not the protocol itself.

---

## 1. Scope and standing

This document defines how PDP-Connect is governed, the membership it operates, and the conformance programme it proposes.

Nothing in this document is a conformance requirement. Core §9 states that conformance is role- and behaviour-based, and that a conformant implementation is not required to use any particular vendor-hosted service, token, chain, centralised registry operator, domain, or repository deployment. That remains the case. Any party may implement PDPP without holding any status described here, without joining any tier described here, and without any dealing with PDP-Connect.

Conformance status is a signal about parties. It is not permission to operate.

The two principles in the preceding two paragraphs are not amendable: no status under this programme is a conformance requirement, and conformance status is not permission to operate. No vote of Partners, decision of the board, or act of the technical committee reaches them.

The rest of this document is amended under §2.8.

### Relationship to the Linux Foundation

PDP-Connect is an LF Decentralized Trust Lab. Labs are initiated and managed by the community rather than overseen by the LFDT Technical Advisory Committee. The Labs Stewards approve entry to the programme and curate it, and hold no oversight of a Lab's own affairs. A Lab is not required to adopt a formal governance model. This document adopts one because the programme it describes issues findings that third parties rely on.

Reference implementation code is Apache-2.0 and all commits carry DCO sign-off, as the Labs programme requires. Specification text is CSL-1.0 and documentation is CC-BY-4.0.

The conformance programme in §4 is modelled on the Certified Kubernetes Conformance Program and follows its structure: self-service testing against an open source suite, public submission of results, review and approval in the open, and no fee for participation.

---

## 2. Governance

### 2.1 The board

The board has five seats, all elected by Partners.

The board:

- sets the conformance criteria and the currency requirements in §4.6;
- grants and withdraws status, on the recommendation of a reviewer;
- hears appeals under §4.7;
- appoints the technical committee;
- represents the programme to the Linux Foundation;
- publishes its decisions.

### 2.2 The Chair

The Chair holds one of the five board seats, elected directly by Partners on the same terms as the other four, and holds a full vote. The office is not appointed by the board and cannot be filled by board appointment.

In addition to serving as a board member, the Chair:

- convenes the board and records its decisions;
- maintains the register;
- administers submissions;
- calls and organises elections;
- publishes the criteria and decisions the board makes.

### 2.3 The technical committee

The board appoints a technical committee. The committee:

- maintains the conformance test suite;
- publishes the review standard and trains the reviewer pool;
- arbitrates disputes between reviewers;
- receives and considers community-proposed changes to the specification;
- runs the change processes listed in §5;
- recommends versions for publication.

The committee is a technical body. It does not grant or withdraw status under §4 and does not set membership terms.

Committee size and terms are set by the board. Appointment requires demonstrated technical qualification: contribution to the specification or its reference implementation, or equivalent standing in authorization, identity, or data portability standards work. The board publishes the qualification criteria it applies and the basis on which each appointment is made.

### 2.4 Elections, terms and removal

Board members serve a term of two years. There is no limit on the number of terms a member may serve. Members remain in office until their successors are seated.

The Chair calls and organises each election and runs it fairly and in a procedurally sound manner. That includes publishing the timetable, the eligibility rules and the method of counting in advance, giving notice long enough for candidates to stand and Partners to vote, and publishing the result with the count.

Where the Chair stands for re-election, the board appoints an independent returning officer to run that election. The same applies where the office is vacant.

**Removal.** A board member, including the Chair, is removed by a resolution of the board supported by a vote of Partners. Both are required.

**Vacancies.** Where one of the four other seats falls vacant between elections, the board may appoint to it for the remainder of the term, or call an early election for that seat. Where the Chair seat falls vacant, an election is held for it. The board designates one of its members to discharge the Chair's administrative functions until that election concludes, and appoints an independent returning officer to run it.

### 2.5 Voting and decisions

**Partner votes.** One organisation, one vote. An organisation is a separate legal entity not under common control with another voting organisation. Every Partner votes. Voting is not conditioned on any fee.

**Board decisions.** Decisions pass by majority. A decision that does not reach a majority does not pass.

**Conflicts.** A board member does not vote on a decision concerning their own status, the status of an organisation they are employed by or control, or their own removal. This applies to every seat.

### 2.6 Interim arrangements and transition

In this document, the maintainers are those listed as maintainers in the PDPP repository at github.com/PDP-Connect/pdpp as at 3 September 2026.

Until the transition below, the maintainers act as the board, discharge the Chair function collectively, and review submissions under §4.

The criteria the maintainers apply are published from programme live.

The maintainers cannot amend this document. See §2.8.

**Transition.** The interim arrangement ends at the sooner of 100 Partners or one year from programme live, and in no case earlier than six months from programme live. At that point an election is held and all five board seats are filled.

### 2.7 Separation

Authoring the specification, operating commercially on it, and reviewing conformance submissions against it are not held by one organisation. The interim arrangement in §2.6 is an exception, made because no alternative exists at launch, and it ends on transition.

### 2.8 Amendment

**This document** is amended by a majority of Partners, except for the two principles stated as unamendable in §1.

**The specification** changes through the technical committee, which receives and oversees community-proposed changes and recommends versions for publication. Specification text is licensed under CSL-1.0 and changes under the Community Specification process. Membership votes do not decide protocol semantics.

**Before a board exists.** Partners vote only after the board is seated under §2.6. Until then this document cannot be amended, and the maintainers cannot amend it.

Two consequences follow, and both are intended. The interim body is bound by terms it cannot change, including the terms under which its own authority ends. And errors identified during the interim period cannot be corrected by ordinary amendment.

To avoid entrenching a defect for up to a year, a narrow exception applies. The maintainers may issue published errata correcting factual errors, broken cross-references and dates. Errata may not alter criteria, statuses, tiers, voting arrangements, or the transition trigger in §2.6. Every erratum is published with its date and its ground, and is subject to ratification or reversal by the first seated board.

---

## 3. Membership

Membership records what a company has committed to. It is separate from conformance status and confers none. Conformance status is separate from membership and does not require it.

Each tier states who decides it.

**Supporter.** A public statement of support. No implementation required, no assessment. Listed by name. *Self-declared. Nobody grants it, and it can be withdrawn by the company at any time.*

**Partner.** The company holds at least one status under §4.2. The register entry states which. Partners participate in working groups, receive drafts ahead of publication, and vote under §2.5. *Granted by the board, on the recommendation of a reviewer, under §4.1. Withdrawn the same way.*

**Steward.** The company holds no custody of user data and operates where the data lives.

Steward opens at programme live as a declared commitment: the company states publicly that it takes no custody, and the register records the claim as declared. It converts to a confirmed Steward on Verified Operator status, once the test suite is published. Declared and confirmed are shown distinctly on the register.

*Declared Steward is self-declared. Confirmed Steward is granted by the board under §4.1.*

The board is the only body that grants or withdraws a status. Reviewers recommend and the technical committee arbitrates between them, but neither grants. No fee, no membership, and no commercial relationship affects a grant. See §4.6.

Membership carries no fee.

---

## 4. Conformance

### 4.1 How status is obtained

There is no accreditation body and there are no licensed assessors. Status is obtained by submission and review in the open.

1. The applicant runs the open source conformance test suite against its implementation.
2. The applicant submits its results as a pull request to the conformance repository, together with the participation form.
3. A reviewer examines the submission in public against the published review standard and recommends that it be granted or refused, with reasons.
4. The board grants or refuses on that recommendation.
5. On grant, the result is published to the register.

Anyone may reproduce a published result by running the same suite against the same implementation.

**The reviewer pool.** Reviews are carried out by volunteer reviewers trained by the technical committee against a published review standard. Reviewers are named on every recommendation they make. Where reviewers disagree, the technical committee arbitrates. The board grants; a reviewer does not.

**Source submissions are reviewed, not tested.** No test suite establishes whether a description is accurate. A Source submission is examined against the published criteria for accuracy and completeness of what the connector produces.

**Recognition.** The board may recognise an external register as an alternative basis for a named status where that register makes the equivalent finding. Recognised registers are named individually with the reasoning published. At programme live the recognised list holds one entry: the Data Transfer Initiative's Data Trust Registry, recognised as a basis for Verified Accessor under §4.4.

### 4.2 Statuses

Four statuses. Each belongs to exactly one role, as defined in Core §2.

**Source.** Where data comes from. Anyone may publish a description of a source.
**Accessor.** An application or agent requesting data. Core §2 calls this the Client.
**Operator.** A party running the authorization server, the resource server, or both.

| Status | Role | Finding | How established | Opens |
| --- | --- | --- | --- | --- |
| Verified Source | Source | The published description is accurate and a named party is accountable for it. | Review and grant | Programme live |
| Official Source | Source | Verified, and the publisher is authenticated as the platform itself. Carries an official tag and display priority. | Review, grant, and identifier check | Programme live |
| Verified Accessor | Accessor | The party is who it claims to be and has been vetted. | Recognition, or review and grant | Programme live |
| Verified Operator | Operator | The implementation conforms to Core §9. | Test suite submission | Publication of the test suite |

### 4.3 Source statuses

**Verified Source.** The published description is assessed against the data it describes, and a named party accepts accountability for its accuracy.

**Official Source.** Verified Source, plus authentication that the publisher is the platform whose data is described. Authentication uses the check in Discovery and Trust §2: `source.id` must be identical to the accepted protected-resource identifier, and the authorization server rejects any mismatch before consent.

Official Source does not substitute for review. A platform meets the same accuracy criteria as anyone else.

**Coexistence.** Official Source does not displace anything. Where a source already holds one or more Verified Source descriptions, the Official description is published alongside them under its own identifier, and the register lists all of them together with what each exposes.

What Official Source carries is an official tag and display priority: an authorization server presents the Official description by default, with the others reachable. Anyone remains free to publish, maintain and extend a Verified Source description for the same source, including one that exposes more.

Existing grants remain bound to the declaration snapshot they were issued against and continue until expiry or revocation. Core §7 does not support grant narrowing, and no migration is forced.

**Why source descriptions carry the most weight.** A description that is wrong corrupts consent at its input, and nothing downstream catches it, because the system then behaves exactly as specified.

### 4.4 Accessor status

The question is whether the party is who it claims to be.

Two routes lead to Verified Accessor. Both confer the same status. The register records which was used.

**Recognition.** A recognised external register has already made the equivalent finding under §4.1.

**Review.** A reviewer examines the submission against published identity and vetting criteria under §4.1, and the board grants on that recommendation.

Both routes exist because the populations differ. The Data Trust Registry vets services seeking access to platforms' portability interfaces. An accessor operating against a personal server may never approach one, and so may have no basis to appear there.

Verified Accessor by either route is a positive trust signal for Core §6, which requires an authorization server to render verified status distinctly where it holds such a signal and to treat a client as unverified where it does not. Neither route is exclusive: an authorization server may recognise other signals, including local registration and domain verification, under its own policy.

### 4.5 Operator status

**Verified Operator.** The applicant runs the conformance test suite against its authorization server and resource server implementation and submits the results under §4.1.

Core §9 notes that a conformance test suite is planned and not defined in v0.1. The suite is published within three months of programme live, and Verified Operator opens on its publication. Until then operator conformance is self-asserted and PDP-Connect makes no finding about it.

### 4.6 Rules common to all statuses

**Grounds.** Standing depends on conduct alone. It does not depend on membership or on any commercial relationship with PDP-Connect or its members. A party that has never held membership may hold any status in §4.2.

**Change.** A Source description is versioned, and every version is compared against the one before it. A change that widens scope, meaning a new stream, a new field, or a new endpoint, returns to review before the new version carries the status. Any other change passes automatically and is recorded.

**Currency.** Status is granted against a stated specification version. To remain current, a holder resubmits against the most recent version within twelve months of its publication. Status that is not renewed lapses, and the register records it as lapsed rather than withdrawn.

**Withdrawal.** Every status is revocable on evidence. Status held by recognition lapses when the underlying registry membership lapses, and an authorization server relying on it is responsible for ceasing to render verified status. Status held by submission is withdrawn by the board.

**Scope.** A status is granted for a named role and does not extend to any other. A recognised external register confers only the status §4.1 names it for.

**The register.** The register is authoritative and any badge or mark is a pointer to it. It shows lapsed and withdrawn status alongside current status, with the date, the ground, the specification version, and the route by which the status was held.

### 4.7 Reports and appeals

**Reports.** Anyone may report a source description as inaccurate, or any other conduct bearing on a status, to reports@pdpp.dev.

The Chair acknowledges a report within five working days and refers it to the board. Where a report is credible on its face, the board may suspend the status pending the outcome.

The outcome is published with reasons. Where a description is found to be inaccurate, the status is withdrawn and the finding records the period during which the description was live, so that operators can identify the grants affected.

**Appeals.** A party refused a status, or whose status is withdrawn, may appeal to the board. A board member who took part in the decision under appeal does not vote on the appeal.

---

## 5. Change processes

Anyone may make a proposal under this section, whether or not they hold a status or a membership.

**Purpose codes.** Core Appendix A defines the initial registry. `https://pdpp.dev/purpose/ai_training` carries the only protocol-level consent requirement. The technical committee considers proposals on a published regular cycle and decides whether to add a code, and whether it carries a protocol-level consent requirement.

**Views.** Core §5 states that views under `pdpp.dev` URI namespaces are controlled through a public change process. That process is the one in this section.

**Extension profiles.** Core §5 states that an extension cannot redefine or weaken Core semantics. The technical committee reviews every proposed extension against that requirement and publishes the finding. An extension that fails review is not published under the `pdpp.dev` namespace.

**The specification.** The technical committee triages proposals on a published regular cycle, works them in public, and recommends versions to the board for publication under CSL-1.0. The board publishes. It does not decide protocol semantics.

**The test suite.** The technical committee maintains the suite and versions it alongside the specification. Changes to what conformance means are published before they take effect.

Decisions under this section are published with reasons.

---

## 6. Timeline

| Stage | Date |
| --- | --- |
| Specification and this document locked, published for public comment | 3 September 2026 |
| Comment period closes | 1 October 2026 |
| Programme live. Source and Accessor submissions open | 1 October 2026 |
| Conformance test suite published | By 1 January 2027 |
| Verified Operator and Steward open | On publication of the test suite |
| Interim governance ends, board seated | Sooner of 100 Partners or 1 October 2027, not before 1 April 2027 |
