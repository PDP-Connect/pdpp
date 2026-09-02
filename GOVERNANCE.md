# Governance, Membership and Conformance

**Status:** Consultation draft
**Circulated:** 24 August 2026. Revised 2 September 2026.
**Formal review:** 3 September to 1 October 2026
**Supporter signing opens:** 3 September 2026
**Programme live:** 15 October 2026
**Applies to:** PDP-Connect programme documents
**Reports:** pdpp-dev-reports@lfdecentralizedtrust.org

---

**Programme document.** This is a programme document, not normative protocol text. It defines how PDP-Connect is governed and how conformance status is obtained. It does not change the specification, and no status it defines is a conformance requirement.

This document is in two parts.

**Part A, Operating rules,** is in force from programme live. It describes what PDP-Connect does now, as a Lab of LF Decentralized Trust, with the powers a Lab has.

**Part B, Proposed structure,** is not in force. It describes what PDP-Connect proposes to become once it holds a legal home that can stand behind conformance findings. It is published for comment and will change in response.

From 3 September 2026 the specification and Part A are locked for the duration of the formal review period. No change is made to either during that window except to correct a factual error, and any such correction is published with its date and its ground. Part B remains open to revision throughout.

Every comment received during formal review is logged and given a disposition: accepted, declined with a reason, or deferred. The comment resolution log is published. During disposition the maintainers may hold further open consultations or one-on-one conversations with commenters, and will say so in the log.

Where review produces material change, or where a material question remains in dispute at close, the changed text goes out for a further 15-day review before it is final. Non-material change proceeds to publication.

---

## 0. What this is, for readers new to PDPP

**The protocol.** PDPP is an open protocol for scoped access to personal data. Today, when you let an app use your data from a platform, the choice is usually all of it or none of it, and after you click nothing records what you actually agreed to. PDPP turns that click into a durable, specific record: these fields, this date range, this purpose, for this long. A machine then checks every later request against that record and refuses anything outside it.

**Why a protocol needs governance.** A protocol is a document. Anyone can write one; the hard part is getting people to adopt it, and getting anyone to believe a party that says it complies actually does. That belief has to come from somewhere, and the somewhere is a body that publishes criteria, checks claims against them, and takes the claim away when it turns out to be false. This document defines that body, who elects it, and what it may and may not do.

**Three kinds of party.** Data comes from somewhere, an application asks for some of it, and machines record and enforce what was approved. The programme calls these Source, Accessor and Operator. Every conformance status belongs to exactly one of them.

**What conformance status is.** It says a party has been checked against published criteria and the result is published where anyone can read it. It is not a licence, and it is not required. Anyone may build on PDPP without holding a status, joining anything, or dealing with PDP-Connect at all. That is stated in §1 and it cannot be amended.

**What membership is.** Separate from conformance. Membership records what a company or an individual has publicly committed to: signing the Principles as a Supporter, or holding a conformance status as a Partner. It costs nothing, and it confers no conformance status.

**Where this sits.** PDP-Connect is a Lab of LF Decentralized Trust, part of the Linux Foundation. It was started by the Vana Foundation. PDPP is a community specification, owned, governed and managed by the community. The specification and reference implementation are open source. This document governs the programme around them, not the protocol itself.

---

# Part A. Operating rules

In force from programme live.

## 1. Scope and standing

This document defines how PDP-Connect is governed, the membership it operates, and the conformance programme it proposes.

Nothing in this document is a conformance requirement. Core §9 states that conformance is role- and behaviour-based, and that a conformant implementation is not required to use any particular vendor-hosted service, token, chain, centralised registry operator, domain, or repository deployment. That remains the case. Any party may implement PDPP without holding any status described here, without joining any tier described here, and without any dealing with PDP-Connect.

Conformance status is a signal about parties. It is not permission to operate.

The two principles in the preceding two paragraphs are not amendable: no status under this programme is a conformance requirement, and conformance status is not permission to operate. No vote of Partners, decision of the steering committee, or act of the technical committee reaches them.

### 1.1 Relationship to the Linux Foundation

PDP-Connect is an LF Decentralized Trust Lab. Labs are initiated and managed by the community rather than overseen by the LFDT Technical Advisory Committee. The Labs Stewards approve entry to the programme and curate it, and hold no oversight of a Lab's own affairs. A Lab is not required to adopt a formal governance model. This document adopts one because the programme it describes issues findings that third parties rely on.

Reference implementation code is Apache-2.0 and all commits carry DCO sign-off, as the Labs programme requires. Specification text is CSL-1.0 and documentation is CC-BY-4.0.

### 1.2 Legal status

PDP-Connect is not a separate legal entity. It holds no funds, enters into no agreements, and issues no marks. It operates within the LF Decentralized Trust Labs series of LF Projects, LLC.

Findings published under Part A are the published output of the process described here. They are not certification, they carry no warranty, and participants act in their own capacity.

Where PDP-Connect's programme should legally sit is an open question, raised at the fourth working session and being worked with LF Decentralized Trust. Part B describes the structure PDP-Connect proposes to adopt once that question is resolved. Nothing in Part A depends on the answer.

### 1.3 The model

The conformance programme is modelled on the Certified Kubernetes Conformance Program and follows its structure: self-service testing against an open source suite, public submission of results, review and approval in the open, and no fee for participation.

## 2. How the programme is run

The programme moves through four stages: a preparatory stage before programme live, then the three numbered phases. Each is defined by who holds authority and what can appear on the register.

| Phase | Who runs it | What is on the register | Ends when |
| --- | --- | --- | --- |
| Pre | The maintainers | Public comment on the specification and Part A. Principles v1.0 published. Supporter signing opens | Programme live, 15 October 2026 |
| 1. Launch | The maintainers | Supporters | The interim technical committee is named |
| 2. Interim | The maintainers, with an interim technical committee | Supporters, and every status in §5 | Partners elect the steering committee |
| 3. Full | The steering committee and the technical committee it appoints | As phase 2 | Amended under Part B |

### 2.1 Phase 1: the maintainers

The maintainers are those listed as maintainers in the PDPP repository at github.com/PDP-Connect/pdpp as at 3 September 2026.

In phase 1 the maintainers administer the register, run the change processes in §7, receive reports under §6, and prepare the interim technical committee. They make no finding about any third party.

The maintainers cannot amend this document. See §9.

### 2.2 Phase 2: the interim technical committee

Within 30 days of programme live, the maintainers name an interim technical committee of five.

The committee is constituted on five rules, all of which are published before anyone is named:

1. **Published criteria.** Appointment requires demonstrated technical qualification: contribution to the specification or its reference implementation, or equivalent standing in authorization, identity, or data portability standards work. The maintainers publish the criteria and the basis on which each appointment is made.
2. **Majority independent.** At least three of the five members are unaffiliated with Vana Foundation, Open Data Labs, or any organisation under common control with either. Every member's affiliation is published.
3. **Appointed once.** The maintainers name the committee and cannot remove any member. Only the first elected steering committee may remove a member, and only for cause published with reasons.
4. **Term ends at the first election.** The committee stands down when the steering committee is seated under Part B.
5. **Decisions in the open.** Every decision is published with reasons and with each member's vote named. A member does not vote on a matter concerning their own organisation, and recusal reduces the number needed for a majority.

The committee reviews conformance submissions under §5, maintains the conformance test suite and the review standard, and runs the change processes in §7. Until PDP-Connect's legal home is confirmed, the register describes the committee's findings as reviewed by the interim technical committee.

### 2.3 How the committee decides

Each submission is assigned to two members, neither from the applicant's organisation. They examine it in public against the published review standard and write a recommendation of no more than one page: grant or refuse, with reasons.

The full committee votes on that recommendation, asynchronously, within seven days. A recommendation passes by a majority of the whole committee, less any member who has recused. A recommendation that does not reach a majority does not pass.

A refused applicant receives the written reasons and may correct and resubmit. There is no appeal from the interim committee; appeals open when the steering committee is seated. That is stated here so that no applicant expects a route that does not yet exist.

Reviewer pairs rotate.

### 2.4 Separation

Authoring the specification, operating commercially on it, and reviewing conformance submissions against it are not held by one organisation. The majority-independent rule in §2.2 is how that is achieved before an elected structure exists.

## 3. Open participation

The work happens in the open, and joining requires no signature.

**Open channels.** The PDP-Connect mailing list and the #pdp-connect channel on the LF Decentralized Trust Discord are open to anyone. Both are linked from pdpp.dev. Drafts, working sessions, and the comment resolution log are announced there.

**Working sessions** are public and recorded.

**Public bodies.** Regulators, government agencies and international organisations are welcome to participate in the open channels and working sessions as observers, without signing anything, holding any status, or appearing on any register. A named contact for public bodies is listed on pdpp.dev.

## 4. Membership

Membership records what a party has publicly committed to. It is separate from conformance status and confers none.

### 4.1 Supporter

A Supporter has signed the PDPP Principles, a short statement of the intentions behind the protocol, published at pdpp.dev and versioned separately from the specification.

Signing is a statement of intent. It is not an undertaking to implement PDPP, and it does not indicate agreement with any particular version of the specification. Individuals and organisations both sign. An individual's affiliation, if given, is shown for identification only; the individual signs in a personal capacity. A signature attaches to the version of the Principles signed, and a signatory is invited, not moved, when the Principles are revised.

Supporters are listed on the public register by name (individuals) or by organisation, type and country (organisations), with the date and the Principles version signed. The register is in date order, without ranking or tiers. No badge or mark is issued.

Supporter is self-declared. Nobody grants it, and it can be withdrawn at any time.

Supporter is the only membership available in phase 1. Signing opens 3 September 2026, ahead of programme live, because a Supporter register needs no body to administer it beyond the maintainers.

### 4.2 Partner

A Partner is an organisation that holds at least one status under §5. The register entry states which. Partners receive drafts ahead of publication, participate in working groups, and vote under Part B once the steering committee election is called.

Partner is not granted. It follows from holding a status, and lapses when the last status lapses.

Partner opens in phase 2.

Membership carries no fee at any level.

## 5. Conformance

### 5.1 Who does what

**The interim technical committee** examines every submission in public against the published review standard and decides under §2.3. Members are named on every decision.

**The maintainers** administer submissions, run the admissions check in Appendix A, merge on a committee decision, and maintain the register.

There is no accreditation body and there are no licensed assessors.

### 5.2 How status is obtained

Four steps, the same for every status:

1. **Submit.** The applicant opens a pull request containing the evidence for the status sought, together with the participation form.
2. **Check.** The maintainers run the admissions check in Appendix A. A submission that fails a check is returned with the item cited. The maintainers exercise no discretion at this step.
3. **Review.** The interim technical committee examines the submission and decides under §2.3.
4. **Publish.** On a decision to grant, the maintainers merge the submission and the result is published to the register.

What is submitted at step 1 differs by status:

| Status | What the applicant submits |
| --- | --- |
| Verified Source | The published description, and a named party accepting accountability for its accuracy |
| Official Source | The same, plus the identifier check in Discovery and Trust §2, which is mechanical |
| Verified Accessor | Identity and vetting evidence against the published criteria |
| Verified Operator | Results of the open source conformance test suite, run by the applicant |

**Recognition short-circuits steps 1 to 3.** Where a recognised external register has already made the equivalent finding, the result is published. At programme live the recognised list holds one entry: the Data Transfer Initiative's Data Trust Registry, recognised as a basis for Verified Accessor under §5.5.

### 5.3 Statuses

Four statuses. Each belongs to exactly one role, as defined in Core §2.

| Status | Role | Finding | How established | Opens |
| --- | --- | --- | --- | --- |
| Verified Source | Source | The published description is accurate and a named party is accountable for it. | Reviewed | Phase 2 |
| Official Source | Source | Verified, and the publisher is authenticated as the platform itself. Carries an official tag and display priority. | Reviewed, plus identifier check | Phase 2 |
| Verified Accessor | Accessor | The party is who it claims to be and has been vetted. | Reviewed, or recognised | Phase 2 |
| Verified Operator | Operator | The implementation conforms to Core §9. | Tested | Publication of the test suite |

### 5.4 Source statuses

**Verified Source.** The published description is assessed against the data it describes, and a named party accepts accountability for its accuracy. There is no test suite for this status.

**Official Source.** Verified Source, plus authentication that the publisher is the platform whose data is described. Authentication uses the check in Discovery and Trust §2: `source.id` must be identical to the accepted protected-resource identifier, and the authorization server rejects any mismatch before consent.

Official Source does not substitute for review. A platform meets the same accuracy criteria as anyone else.

**Coexistence.** Official Source does not displace anything. Where a source already holds one or more Verified Source descriptions, the Official description is published alongside them under its own identifier, and the register lists all of them together with what each exposes. What Official Source carries is an official tag and display priority: an authorization server presents the Official description by default, with the others reachable. Anyone remains free to publish, maintain and extend a Verified Source description for the same source, including one that exposes more.

Existing grants remain bound to the declaration snapshot they were issued against and continue until expiry or revocation. Core §7 does not support grant narrowing, and no migration is forced.

**Why source descriptions carry the most weight.** A description that is wrong corrupts consent at its input, and nothing downstream catches it, because the system then behaves exactly as specified.

### 5.5 Accessor status

The question is whether the party is who it claims to be.

Two routes lead to Verified Accessor. Both confer the same status. The register records which was used.

**Review.** The applicant submits identity and vetting evidence through the four steps in §5.2.

**Recognition.** A recognised external register has already made the equivalent finding, and the result is published rather than repeated.

Both routes exist because the populations differ. The Data Trust Registry vets services seeking access to platforms' portability interfaces. An accessor operating against a personal server may never approach one, and so may have no basis to appear there.

Verified Accessor by either route is a positive trust signal for Core §6, which requires an authorization server to render verified status distinctly where it holds such a signal and to treat a client as unverified where it does not. Neither route is exclusive: an authorization server may recognise other signals, including local registration and domain verification, under its own policy.

### 5.6 Operator status

**Verified Operator.** The applicant runs the conformance test suite against its authorization server and resource server implementation and submits the results under §5.2. A Verified Operator claim states which Core §9 roles and tiers it covers, and against which specification version the results were produced.

Core §9 notes that a conformance test suite is planned and not defined in v0.1. The suite is published by 1 January 2027, and Verified Operator opens on its publication. Until then operator conformance is self-asserted and PDP-Connect makes no finding about it.

### 5.7 Rules common to all statuses

**Grounds.** Standing depends on conduct alone. It does not depend on membership or on any commercial relationship with PDP-Connect or its members.

**Change.** A Source description is versioned, and every version is compared against the one before it. A change that widens scope, meaning a new stream, a new field, or a new endpoint, returns to review before the new version carries the status. Any other change passes automatically and is recorded.

**Currency.** Status is granted against a stated specification version. To remain current, a holder resubmits against the most recent version within twelve months of its publication. Renewal is a re-declaration by the holder plus a fresh run of the admissions check and, for Verified Operator, the test suite. The committee re-reviews only where a check fails or a report under §6 is open. Status that is not renewed lapses, and the register records it as lapsed rather than withdrawn.

**Withdrawal.** Every status is revocable on evidence, by the committee under §2.3. Status held by recognition lapses when the underlying registry membership lapses, and an authorization server relying on it is responsible for ceasing to render verified status.

**Scope.** A status is granted for a named role and does not extend to any other. A recognised external register confers only the status §5.2 names it for.

**The register.** The register is authoritative. It shows lapsed, withdrawn and disputed status alongside current status, with the date, the ground, the specification version, and the route by which the status was held. No badge or mark is issued until PDP-Connect holds a legal home.

## 6. Reports

Anyone may report a source description as inaccurate, a Supporter entry as misattributed, or any other conduct bearing on a status or a register entry, to pdpp-dev-reports@lfdecentralizedtrust.org.

The maintainers designated as responders, listed on pdpp.dev, acknowledge a report within five working days.

**In phase 1,** no body exists to adjudicate. The register records the entry as disputed and publishes the report alongside it. The entry is not removed unless the party withdraws it.

**In phase 2,** the report is referred to the interim technical committee, which decides under §2.3. Where a report is credible on its face, the committee may suspend the status pending the outcome. The outcome is published with reasons. Where a description is found to be inaccurate, the status is withdrawn and the finding records the period during which the description was live, so that operators can identify the grants affected.

## 7. Change processes

Anyone may make a proposal under this section, whether or not they hold a status or a membership. In phase 1 the maintainers run these processes; from phase 2 the interim technical committee does.

**Purpose codes.** Core Appendix A defines the initial registry. `https://pdpp.dev/purpose/ai_training` carries the only protocol-level consent requirement. Proposals are considered on a published regular cycle, deciding whether to add a code, and whether it carries a protocol-level consent requirement.

**Views.** Core §5 states that views under `pdpp.dev` URI namespaces are controlled through a public change process. That process is the one in this section.

**Extension profiles.** Core §5 states that an extension cannot redefine or weaken Core semantics. Every proposed extension is reviewed against that requirement and the finding is published. An extension that fails review is not published under the `pdpp.dev` namespace.

**The specification.** Proposals are triaged on a published regular cycle, worked in public, and published under CSL-1.0 through the Community Specification process. Membership votes do not decide protocol semantics.

**The test suite.** Maintained and versioned alongside the specification. Changes to what conformance means are published before they take effect.

Decisions under this section are published with reasons.

## 8. Timeline

| Stage | Date |
| --- | --- |
| Specification and Part A locked, published for public comment. PDPP Principles v1.0 published. Supporter signing opens | 3 September 2026 |
| Comment period closes | 1 October 2026 |
| Disposition published. Further 15-day review if material change | From 1 October 2026 |
| Programme live | 15 October 2026 |
| Interim technical committee named | By 14 November 2026 |
| Source and Accessor submissions open | On the committee being named |
| Conformance test suite published | By 1 January 2027 |
| Verified Operator opens | On publication of the test suite |
| Steering committee election called | Sooner of 100 Partners or 15 October 2027, not before 15 April 2027 |

## 9. Amendment of Part A

Part A cannot be amended during phases 1 and 2. The maintainers and the interim technical committee are bound by it, including the terms under which their own authority ends.

To avoid entrenching a defect, a narrow exception applies. The maintainers may issue published errata correcting factual errors, broken cross-references and dates. Errata may not alter criteria, statuses, tiers, the constitution of the interim committee, or the election trigger in §8. Every erratum is published with its date and its ground, and is subject to ratification or reversal by the first seated steering committee.

From phase 3, Part A is amended under Part B §B.5.

---

# Part B. Proposed structure

Not in force. Published for comment. Contingent on PDP-Connect holding a legal home able to stand behind conformance findings, which is being worked with LF Decentralized Trust.

## B.1 Path to project status

The programme starts under the LF Decentralized Trust Labs structure, which provides no separate legal personality. When the conformance test suite is published and Verified Operator opens, PDP-Connect applies for its own legal home. The candidates are LF Decentralized Trust project status, a series of Joint Development Foundation Projects, LLC, which is how the Coalition for Content Provenance and Authenticity and Trust over IP are constituted, or another Linux Foundation category if one is better suited to a programme that issues findings.

At that point membership can become a signed agreement, findings can become certification, marks can be issued and enforced, and the programme can hold funds and form liaisons with other standards bodies. Until then: no fees, no contracts, no marks.

## B.2 The steering committee

Five seats, all elected by Partners. The Chair holds one of the five, elected directly on the same terms as the other four.

The steering committee sets the conformance criteria and currency rules, grants and withdraws status on the technical committee's recommendation, hears appeals, appoints the technical committee, publishes specification versions the committee has approved, represents the programme to the Linux Foundation, and publishes its decisions.

The Chair convenes the committee and records its decisions, maintains the register, administers submissions and merges them once granted, calls and organises elections, and publishes criteria and decisions.

**Open questions from the fourth working session, carried here for comment:** whether five seats or three; whether one organisation, one vote deters large participants; and whether the technical committee should recommend or grant.

## B.3 The technical committee

Appointed by the steering committee on demonstrated technical qualification, as in §2.2. It maintains the test suite and the review standard, reviews submissions and recommends, receives community-proposed changes to the specification, runs the change processes in §7, and recommends versions for publication.

The committee approves and merges pull requests against the specification, its companion documents and the test suite. It does not merge conformance submissions. It recommends; the steering committee decides.

## B.4 Elections, terms, removal and voting

Steering committee members serve two years, no term limit, and remain in office until successors are seated. The Chair runs elections and publishes the timetable, eligibility rules, counting method and result. Where the Chair stands for re-election or the seat is vacant, an independent returning officer is appointed.

Removal of any member, including the Chair, requires both a resolution of the steering committee and a vote of Partners.

Partner votes: one organisation, one vote. An organisation is a separate legal entity not under common control with another voting organisation. Voting is not conditioned on any fee. Steering committee decisions pass by majority. A member does not vote on a decision concerning their own status, their own organisation, or their own removal.

## B.5 Amendment

This document is amended by a majority of Partners, except for the two principles stated as unamendable in §1. The specification changes through the technical committee under the Community Specification process, never by membership vote.

## B.6 Under consideration

Annual attestation and compliance review for assessed statuses, on the model offered at the fourth working session. Appeals from the interim technical committee's decisions, once a steering committee exists to hear them. Marks and badges, once an entity exists to own and enforce them.

---

# Appendix A. Admissions check

Applied by the maintainers at §5.2 step 2. The list is exhaustive: a submission cannot be returned for a reason not on it. The maintainers have no discretion to return a submission that meets every item. Every return cites the item and is logged.

For every submission:

1. The participation form is complete.
2. The submission names the specification version it is made against.
3. A named party accepts accountability, with working contact details.
4. The pull request carries DCO sign-off.

For Supporter:

5. The signatory has confirmed by email.
6. For an organisation, the signatory's email is at the organisation's domain and the authority declaration is checked.

For Source statuses:

7. The declaration is well-formed and parses against the specification version named.
8. Declared endpoints resolve.
9. For Official Source, the identifier check in Discovery and Trust §2 passes.

For Verified Operator:

10. Test suite results are attached, name the suite version, and are reproducible.

Separately from this check, the maintainers may decline to publish content that is unlawful, fraudulent or abusive, under the Code of Conduct. That is repository moderation, not a status decision, and is recorded as such.
