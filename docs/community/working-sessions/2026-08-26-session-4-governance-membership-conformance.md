# Session 4: Governance, membership and conformance

26 August 2026

Document covered: PDP-Connect Governance, Membership and Conformance
(pre-consultation draft)

These notes summarize the discussion. They do not change the draft document.

## Summary

The fourth PDP-Connect working session covered the governance document rather
than the specification: the separation of governance, membership and
conformance, the proposed board and technical committee, the three membership
tiers, and the four conformance statuses. Discussion turned almost entirely
to adoption, and to whether the structure would survive contact with
regulators, large platforms and the Linux Foundation's own project
categories.

## Discussion

### Why the three are kept apart

Governance covers how the standard is maintained and how it relates to other
standards bodies. Membership addresses adoption at global scale. Conformance
is deliberately separate from both: conformance status is not permission to
operate, and membership is not a conformance requirement. The stated
preference is that parties aspire to meet the standard rather than join a
programme to be seen to meet it.

### Legal personality is unresolved

An attendee with fifteen years of Linux Foundation experience set out the
three project classes: open source projects, open standards projects under
the Joint Development Foundation, and a small third category of governance
projects, originally driven by blockchain work. Neither of the first two
suits governance. Trust over IP is a JDF project that produces protocols and
governance models but does not itself do governance, treating the separation
as strict.

PDP-Connect is currently an LFDT Lab, an open source project type, working
toward a community specification. That does not cover where the board and
register would legally sit. The discussion has not yet happened with LFDT.

### Signing authority and money

If there is financial support, who is authorised to sign contracts and make
payments. The current assumption is that dues sit at the LFDT level and the
programme is voluntary in its first iteration, but signing authority is not
addressed in the draft.

### Scope, and whether this can scale

A question was raised about the eventual scope of governance for personal
data at global scale, using DNS and ICANN as the reference: systems of that
reach took years to establish, and the governance came before the scale. The
response was that the timeline here does not allow years, which is the
reasoning behind the interim arrangements. The tension between moving fast
enough to matter and building something durable enough to last was the
recurring thread of the session.

### Whether regulators would accept the structure

Concern was raised that regulators may not see the structure as sufficiently
open: a board, membership tiers, no open mailing list, and no defined route
for governments to participate. If regulatory endorsement is a goal, the
structure should be tested against what regulators would accept before it is
fixed. It was agreed to put this question to the panel at GDC.

### Adoption

The dominant theme of the session. Points raised:

- Selling a vision without a concrete need does not work. One attendee
  described several years of difficulty growing a comparable membership
  organisation, and the further difficulty of moving members from signing up
  to writing code.
- Inside a large company, portability crosses protocol, operations, domain,
  legal and portability functions, each with an effective veto. Any one can
  stop it.
- Standards are easy to lower and hard to raise. Set too high and nobody
  joins; set too low and that becomes the ceiling. The specific danger
  identified: a large entity joins at Supporter for the name, never moves
  higher, and others read that as the norm.
- The proposed counter: recruit small entities at any level for volume, and
  large entities as high up the stack as possible, then rely on the
  resulting peer pressure.
- The Jabber and XMPP precedent was offered at length. Build a working open
  source implementation, take it to the IETF to broaden the audience and
  remove any incumbent's ability to claim ignorance of the work, then bring
  the extensions into a dedicated foundation once the base exists.
- The IEEE route: adoption through the IEEE process reaches over half a
  million members across 190 countries, with an adjacent open source
  community.
- The UK Open Banking Standard was cited as a contrasting trajectory,
  starting with large institutions and working down rather than the reverse.
  Bottom-up and top-down are not exclusive, and both routes are usually
  worth running at once.
- Rather than trying to represent every jurisdiction, find the pain point
  common to all of them and build the model and the story around it. For AI
  governance the recurring threads are personal data, data sources, and
  whether data can be trusted.

### Regulatory landscape

The US was characterised as moving toward data autarky: maximising domestic
data, minimising reliance on foreign models and offshore infrastructure. The
argument made was that this is an opening rather than an obstacle, since it
underscores sovereignty for individuals and for countries, and since most of
the world's data never touches the US.

Europe was identified as the more stable route: GDPR establishes the right
and no protocol operationalises it. European concern about US dominance of
AI and data infrastructure makes the region structurally receptive to an
open standard, though European actors are equally wary of data captured by
any state.

### Adoption via the mid-market

Observed traction is strongest among smaller and pre-public companies
competing with larger players and wanting access to data on a level playing
field. Much of the existing commercial client base wants to ingest user data
and cannot get it through platform APIs. A suggestion followed that this
constituency, alongside individuals, could be organised as something
resembling a users group: individuals concerned about their data, and small
and medium businesses whose viability depends on access to it.

### Do sticks work

The Official Source mechanism was presented as the stick. If a community
member publishes a connector for a platform's data, the only route by which
that platform regains control of the description is to become an Official
Source, which requires Partner status and a conforming implementation.

The response was sceptical. Platforms have historically treated third-party
access on behalf of users as an attack, deploying captchas, rate limiting
and account termination. The last twenty years contain many startups that
tried this and were treated as an infection rather than invited to the
table. Where a GDPR export route exists, the practical countermeasure is to
use the full thirty-day window so the data is never fresh.

The counter-question from the floor: whether an open source community can
iterate faster than platform countermeasures, and whether current public
frustration makes this an inflection point.

### Compliance and attestation

How are these commitments proven rather than asserted, and does the
structure need a compliance role. EU practice was offered as the reference:
annual compliance review and attestation, on the basis that meeting the
rules at the point of entry does not mean continuing to meet them. Noted as
something to examine.

### Education, and its limits

Education work has repeatedly hit the same wall: once people understand how
their data is used, they ask what they can do about it, and there has been
no answer. That gap is part of the genesis of PDPP. A caution was raised
against the programme drifting into lobbying or advocacy, described as
potentially fatal.

## Decisions

None formally taken.

## Open questions

- What is the legal home for the board and the register? LFDT Labs is an
  open source project type and JDF suits open standards; neither is designed
  for governance.
- Who is authorised to sign contracts and authorise payment?
- Would regulators accept a structure with a board, membership tiers, no
  open mailing list and no defined route for government participation?
- Can governance for personal data at global scale be established on this
  timeline, when comparable systems took years?
- Should the technical committee recommend rather than grant?
- Board of five seats or three?
- Does one organisation, one vote deter large players, given it caps their
  influence regardless of size?
- How do you prevent a large entity parking at Supporter and setting that as
  the perceived norm?
- Should Supporter require any compliance check?
- Should PDP-Connect adopt EU-style annual attestation and compliance
  review?
- Does the Official Source stick produce participation, or platform
  countermeasures?

## Next steps

- Art to raise legal personality with LFDT, including whether the third
  project category is available.
- Art to speak with IEEE about the standards adoption route.
- Art to review EU attestation and annual compliance review models.
- Art to arrange bilateral review of the governance draft with one or two
  governments, ideally including one from the developing world, given those
  nations have most to gain and most to protect.
- Art to put the regulator-openness question to the panel at GDC.
- Art to incorporate this feedback into the draft before GDC on 3 September.
- Art to send the recap, including the questions that surfaced on this call.
- Written feedback welcome on GitHub or directly.
- Formal public review opens 3 September at GDC and closes 1 October.

[Watch the Session 4 recording](https://youtu.be/XrNtXktjokM).
