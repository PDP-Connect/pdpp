---
title: "Prior-art graveyard: why user-controlled personal-data protocols failed to get adoption"
date: 2026-06-24
status: draft research (verify-before-cite; not yet linked from a positioning file's References list)
---

# Prior-art graveyard: UMA, Solid, and the personal-data-protocol dead pool — and what PDPP does differently

**Research question:** why did prior user-controlled personal-data protocols fail to get
broad adoption, and what does PDPP do differently?

**Method:** web research via search + primary-source fetch, 2026-06-24. Wikipedia direct
fetch was blocked by the runtime's domain-safety check; Wikipedia content is cited via the
search-engine snippets that quote it verbatim (marked below), not a live fetch — treat
those particular facts as one hop less verified than the others and re-confirm from
Wikipedia directly if this ever needs to survive hostile fact-checking.

---

## 1. UMA (User-Managed Access) 1.0 / 2.0

### What it is and who backed it

UMA is an OAuth 2.0-based protocol for **party-to-party authorization**: it lets a
resource owner (not just "the user of this one app") configure an authorization server
with policies that let a *different* human or entity (a requesting party — a doctor, an
accountant, a family member) get access to the owner's resources, asynchronously from any
live interaction with the owner. Standard OAuth assumes the resource owner and the token
requester are the same party; UMA's whole reason to exist is the case where they aren't.

- **Standards body:** Kantara Initiative (not IETF — see below).
- **UMA 1.0:** approved as a Kantara Initiative Recommendation 2015-03-23; announced
  2015-05-05 with member "overwhelming" support.
  Source: [Kantara UMA v1.0 announcement](https://kantarainitiative.org/uma-v1-0-call-to-implement/) (accessed 2026-06-24).
- **UMA 2.0:** published February 2018, as two specs — "UMA Grant for OAuth 2.0
  Authorization" (core) and the optional "Federated Authorization for UMA 2.0."
  Editor: Eve Maler (ForgeRock). Source:
  [UMA 2.0 Grant spec](https://docs.kantarainitiative.org/uma/wg/rec-oauth-uma-grant-2.0.html) (accessed 2026-06-24).
- **Backers/implementers:** ForgeRock (editor company; shipped OpenUMA and later an
  "UMA Provider"/"UMA Protector" pair in its Identity Platform), Gluu (UMA AS endpoints
  incl. claims-gathering by 2018), plus MITREid Connect, Atricore, Node-UMA, Keycloak,
  WSO2 Identity Server as smaller/OSS implementations. Source:
  [WSO2 "Quick Guide to UMA 2.0"](https://wso2.com/library/article/2018/12/a-quick-guide-to-user-managed-access-2-0/);
  [ForgeRock press release](https://www.forgerock.com/about-us/press-releases/forgerock-joins-key-industry-and-government-leaders-in-launching-new-kantara-initiative-work-group-to-foster-global-adoption-of-the-user-managed-access-uma-standard) (accessed 2026-06-24).
- **Healthcare pilot — HIE of One:** Adrian Gropper MD (Patient Privacy Rights
  Foundation) built HIE of One, described as "the only standards-based patient-centered
  record" reference implementation, directly on a self-sovereign UMA Authorization
  Server, aiming to let patients — not institutional health information exchanges — be
  the authorization point for their medical records. This is real-world confirmation that
  UMA's authorization pattern is technically usable for personal-data consent — and also
  the clearest evidence it stayed a pilot/reference-implementation exercise rather than a
  deployed institutional standard. Sources:
  [HIE of One — Wikipedia (via search snippet)](https://en.wikipedia.org/wiki/HIE_of_One);
  [Harlow on Healthcare profile](https://healthblawg.com/2018/08/gropper-hie-one.html) (accessed 2026-06-24).

### What UMA does NOT define — verified, this is the load-bearing fact for the PDPP contrast

UMA is **purely an authorization/access-control protocol.** It standardizes resource
*registration* (an opaque resource ID + scopes at the AS), the permission-ticket flow, and
token issuance/introspection between client, resource server (RS), and authorization
server (AS). It explicitly declines to define:

- **A resource data model.** Per the UMA core spec itself: the RS "MAY register a single
  resource for protection that, from its perspective, has multiple parts, or has dynamic
  elements such as the capacity for querying or filtering, or otherwise has internal
  complexity" and "any such partitioning by the resource server or owner is outside the
  scope of this specification." The RS alone owns any mapping between its internal data
  and the resource IDs/scopes the AS knows about.
- **A query or read API.** How a client actually reads data back — REST, GraphQL, a web
  page, an email link — is explicitly out of scope: "the resource server might have a
  programmatic API or it might serve up simple web pages... outside the scope of this
  specification."
- **Any collection/ingestion story.** UMA has nothing to say about how data gets into the
  resource server in the first place.
- **Cross-AS federation as a first-class mechanism.** An academic analysis notes UMA
  "does not prescribe any interaction between multiple ASs" and so doesn't deliver
  interoperable cross-domain delegation out of the box; it is "primarily focussed on
  access control in the narrow sense, not the broader usage control."

Source: [UMA core spec text via search synthesis](https://docs.kantarainitiative.org/uma/rec-uma-core.html);
corroborating analysis: [arXiv 2411.05622, "From Resource Control to Digital Trust with
User-Managed Access"](https://arxiv.org/pdf/2411.05622) (accessed 2026-06-24).

**This is precise and important: UMA solved delegated authorization and left "what is a
personal-data record, what fields does it have, how do you query it" completely
unspecified** — which is exactly the gap PDPP's record model + resource-server query
interface (spec-core.md §4, §8) fills.

### Why it never broadened — synthesized causes

1. **Architectural complexity out of proportion to the problem most teams had.** UMA
   requires a heavier, five-party model (resource owner, requesting party, client, RS,
   AS) versus the two/three-party mental model developers already had from plain OAuth.
2. **UMA 1.0's own design assumptions broke on contact with a real deployment.**
   Justin Richer (security architect, contributed to UMA) documented that a healthcare
   team trying to let a patient delegate access to her own records to arbitrary outside
   physicians hit a wall: UMA 1.0 required the requesting party to already be able to
   get an OAuth access token from *the resource owner's authorization server* before the
   flow could even start — which only works if the requester is already inside the same
   institutional boundary (e.g., "doctors from a single practice"), defeating the actual
   use case of sharing outside your institution.
   Source: [Justin Richer, "UMA 2.0" — Medium](https://justinsecurity.medium.com/uma-2-0-437c293c3283) (accessed 2026-06-24).
3. **Its own designers found much of the spec's flexibility was unused dead weight** —
   this is the most direct "complexity" evidence, because it comes from the maintainers,
   not outside critics. The object/list-typed extension points in 1.0 were never used by
   any real deployment ("nobody took advantage of the additional flexibility") and were
   flattened to plain strings/numbers in 2.0. The AAT (Authorization Access Token), an
   entire additional token type in 1.0, turned out to serve exactly one action across all
   known deployments and was dropped entirely in 2.0. Same source as #2.
4. **No IETF adoption — stayed a single-organization (Kantara) niche standard.** UMA was
   presented to the IETF OAuth Working Group at IETF 104 (March 2019); this did not result
   in any UMA specs being taken up by IETF. It never got the "blessed core web standard"
   network effect that OAuth 2.0 and OIDC have.
5. **No data model, so no reason for a demand-side ecosystem to form around it.**
   Because UMA is authorization-only (see above), there was nothing for a client
   developer to build against beyond the auth dance itself — no common record shape, no
   query surface, nothing analogous to "point your app at this and get structured personal
   data back." This is a *design* gap, not an execution failure: UMA's authors deliberately
   scoped it that way, correctly, as an authorization primitive — but it left the
   demand-side value proposition entirely to be invented per-deployment, which never
   happened at scale.
6. **No forcing function and no natural demand-side actor.** UMA's target scenarios
   (patient delegating records to an outside doctor, a person sharing photos with a
   parent) are real but not urgent/regulated enough to force institutional adoption the
   way SMART on FHIR or Open Banking were forced (see §4). And the "requesting party" in
   most UMA scenarios was a human clicking through a claims-gathering UI — not a
   software agent that could consume a structured, machine-legible grant at scale.

**Confidence:** high on architecture/scope facts (directly quoted from the spec and a
core contributor's retrospective). Medium on "why it never broadened broadly" as a full
causal account — this is my synthesis across several partial sources, not a single
authoritative post-mortem; I did not find one canonical "UMA post-mortem" essay, only
scattered practitioner retrospectives (mainly Richer's).

---

## 2. Solid / Inrupt

### Backing and funding

Solid (the protocol: decentralized "Pods," Linked Data, WebID) was created by Tim
Berners-Lee, developed initially at MIT. Inrupt, the commercial venture co-founded by
Berners-Lee (with John Bruce) to build a business around Solid, launched in 2018.
Inrupt raised a **$30M Series A in December 2021**, led by Forte Ventures, with
participation from Akamai Technologies, Glasswing Ventures, Allstate, and the Minderoo
Foundation's Frontier Technology Initiative. At the time, Inrupt reported roughly
$225K revenue for the prior year and had signed government contracts (Sweden, Argentina,
the Basque Country) plus enterprise clients.
Sources: [TechCrunch, 2021-12-09](https://techcrunch.com/2021/12/09/tim-berners-lee-inrupt-fundraise/);
[Axios, 2021-12-10](https://www.axios.com/2021/12/10/inrupt-internet-data-control-tim-berners-lee) (accessed 2026-06-24).

### Current state (2024-2026)

- **October 2024:** the Open Data Institute (ODI) — co-founded by Berners-Lee and Nigel
  Shadbolt — became the organizational steward of the Solid *project* (protocol +
  community), moving primary stewardship away from Inrupt. Inrupt frames this as a
  partnership, committing to help ODI with "community operations" and to "expand the
  Solid-based services it can offer," not a withdrawal.
  Source: [ODI, "Solid's next chapter"](https://theodi.org/news-and-events/blog/solids-next-chapter-returning-the-web-to-its-people-first-roots/) (accessed 2026-06-24).
- **Inrupt's own pivot:** by 2024-2025 Inrupt's public positioning shifted toward
  AI-adjacent framing — "infrastructure to make AI memory work the way it should" — and
  it shipped a developer preview of a "Data Wallet" on its Enterprise Solid Server
  (Sept 2024). Revenue estimates found (Latka, low-confidence, self-reported-style
  aggregator data) put Inrupt around **$3.2M ARR** with a **$9.6M valuation** as of the
  2025 snapshot — i.e., a small business three years after a $30M raise, not evidence of
  broad platform-side adoption. Treat the ARR/valuation figures as directional only;
  Latka aggregates self-reported data of uneven reliability.
  Source: [Latka company page](https://getlatka.com/companies/inrupt.com) (accessed
  2026-06-24, low-confidence figures flagged as such).
- **Community continuity:** Solid Symposium has run yearly (Nuremberg 2023, Leuven 2024,
  Leiden 2025), with a 2026 edition planned in London under ODI — so the *protocol
  community* persists, but this is conference/standards-body activity, not platform
  adoption.
  Source: [ODI, Solid Symposium 2026 announcement](https://theodi.org/news-and-events/news/announcing-the-solid-symposium-2026/) (accessed 2026-06-24).
- I found **no report of Inrupt layoffs** in 2024-2025 search results, only the general
  2024 tech-industry layoff wave (unrelated). Absence of evidence is not evidence of
  absence here — I did not find a dedicated post-mortem/layoff story either way.

### Why adoption stalled — the requirement-that-platforms-adopt problem

- **Fundamental business-model conflict.** As one Solid community-forum poster put it
  directly: "Why would any of the big internet companies (GAFAM and others) start
  adopting Solid, since the vast majority of them have a business model based on user
  data?" Solid requires the *platform holding your data* to expose it via a Pod (or the
  user to re-host it themselves) — there is no mechanism that lets a third party stand up
  Solid support *without* the platform's cooperation. This is the single most load-bearing
  fact for the PDPP contrast.
  Source: [Solid Community Forum, "How could solid be one day broadly adopted?"](https://forum.solidproject.org/t/how-could-solid-be-one-day-broadly-adopted/4853) (accessed 2026-06-24).
- **No standardized API/data-interop layer even among Solid apps themselves.**
  Researcher Ruben Verborgh: "the Solid Protocol is not a Web API — rather, it allows and
  requires each individual app to decide where and how they store Linked Data." Because
  Solid apps don't have to publish a documented API contract the way REST/GraphQL APIs
  do, apps built by different teams often can't productively reuse each other's data even
  within the Solid ecosystem, undercutting the "one Pod, many apps" promise.
  Source: [Ruben Verborgh, "Let's talk about pods," 2022-12-30](https://ruben.verborgh.org/blog/2022/12/30/lets-talk-about-pods/) (accessed 2026-06-24).
- **No fine-grained access control in practice.** Access control historically applied to
  a whole Pod rather than to individual resources/fields inside it, forcing users toward
  maintaining multiple Pods to get different sharing scopes for different audiences —
  the opposite of PDPP's field/view-level grant model.
  Source: [Leigh Dodds, "Confused by SOLID," 2024-03-12](https://blog.ldodds.com/2024/03/12/baffled-by-solid/) (accessed 2026-06-24).
- **Onboarding/login UX is the practical death-by-a-thousand-cuts blocker.** Long-time
  Solid developer Noel De Martin: the "log in with Solid" step is "the single most
  important issue holding Solid back" — for a newcomer to Mastodon/the fediverse you can
  point them at one big default instance (mastodon.social) and they're moving; in Solid,
  the only viable on-ramp is "become a Pod provider yourself," and the most commonly
  recommended provider (solidcommunity.net) has a rough UI, while most Solid apps are
  "experimental, unmaintained, or straight up don't work."
  Source: [Noel De Martin, "Why Solid?"](https://noeldemartin.com/blog/why-solid) (accessed 2026-06-24).
- **Slow real-world vertical uptake even in the most favorable use case.** Solid
  developer Jackson Morgan is quoted noting healthcare — often cited as Solid's best-fit
  vertical — has seen adoption that is "super slow" in the US.
- **Confusing value proposition to newcomers.** One developer's blunt read: having to
  trust and manage access across *multiple* Pod providers (rather than one) doesn't
  intuitively read as "more control," and building on Solid means implementing security
  protocols yourself rather than using an off-the-shelf library, which developers resist.
  Source: [The New Stack, "The Developer Case for Using Tim Berners-Lee's Solid"](https://thenewstack.io/the-developer-case-for-using-tim-berners-lees-solid/) (accessed 2026-06-24).

**Confidence:** high on funding/stewardship facts (multiple independent, dated sources
agree). High on the qualitative adoption-blocker list — it's directly sourced to named
practitioners in the Solid community itself (De Martin, Verborgh, Dodds), which is
stronger evidence than outside commentary because these are people with a stake in Solid
succeeding, saying so publicly. Medium on Inrupt's financial trajectory (Latka figures
are low-confidence aggregator data, flagged above).

---

## 3. The smaller graveyard — one paragraph each

**DataPortability.org** (founded November 2007 by Chris Saad and Ashley Angell,
Faraday Media). Peaked January 2008 when Google, Facebook, and Plaxo joined the workgroup
(soon followed by Drupal, Netvibes, LinkedIn, Flickr, Twitter, Digg, Microsoft), generating
"bombshell"/"brilliant PR" press coverage — but membership meant only agreeing "to engage
in the conversation," not committing to ship anything on a timeline. By late 2008 the
narrative had shifted to Facebook's own proprietary answer (Facebook Connect) rather than
the open blueprint DataPortability.org was pushing, and by 2009 Saad was writing about
"Facebook's continued resistance to true DataPortability." The org is listed as
permanently closed on Crunchbase. Textbook case of a coalition with platform members but
no forcing mechanism and no technical spec of its own — pure advocacy, out-competed the
moment an incumbent shipped a proprietary substitute.
Sources: [Chris Saad blog](https://www.chrissaad.com/workblog/2008/12/an-update-on-the-data-portability-landscape);
[AdWeek Q&A](https://www.adweek.com/digital/facebook-and-data-portability-qa-with-dataportabilityorg-chairperson-chris-saad/) (accessed 2026-06-24).

**The Locker Project / Singly.** Locker (BSD-licensed OSS, created by Jeremie Miller,
originator of XMPP) let a user collect their "digital wake" (site visits, purchases,
activity) via connectors/"synclets," funded by the startup Singly (founded 2010, backers
included Venrock, True Ventures, TechStars principals). Locker hit v1.0 in October 2011
with connectors for Facebook, LinkedIn, Twitter, Fitbit, RunKeeper, Instagram — this is
the closest historical analog to PDPP's connector model. By end of 2012 Singly pivoted
away from the open Locker platform to a narrower mobile-API-integration product; the
open-source Locker repo went inactive; Singly was acquired by Appcelerator in August 2013
for undisclosed terms, described at the time as having "much promise" but "only a few
customers." The contemporaneous "personal data ecosystem" consortium it had joined also
dissolved around 2013. Failure mode: a real connector/collection architecture with no
durable demand-side consumer (no App Store equivalent of "apps that want this data"), so
the company had to pivot to survive and the open project starved.
Sources: [O'Reilly Radar, 2011](http://radar.oreilly.com/2011/02/singly-locker-project-telehash.html);
[Forbes, 2011-10-19](https://www.forbes.com/sites/smcnally/2011/10/19/jeremie-miller-and-the-locker-project-at-1-0/);
[AllThingsD, Appcelerator acquisition, 2013-08-22](https://allthingsd.com/20130822/appcelerator-buys-api-connector-singly/) (accessed 2026-06-24).

**Mydex CIC.** Founded 2007 (David Alexander), Edinburgh, structured deliberately as a
Community Interest Company (CIC) rather than a VC-backed startup, on the theory that a
personal-data-store operator has to be visibly trustworthy ("trustworthy by design") and
that the CIC's asset lock + profit-reinvestment rules signal that credibly. It became one
of the earliest identity providers in the UK government's GOV.UK Verify program, but by
late 2017 did not go through Verify's second procurement round and was not carried
forward as a certified identity provider in the next framework — though it kept advising
government on policy/consent-management questions (e.g., DWP Universal Credit
data-sharing). Mydex's own 2021 strategy paper is unusually candid: it explicitly does
"not expect or plan for large-scale adoption in the short term," describing a
deliberately incremental, cluster-by-cluster growth strategy rather than a mass-market
push — a rare case of a personal-data-store operator stating its own niche status as
strategy rather than having it diagnosed from outside. Still an active, filing UK company
as of 2025/2026 per Companies House, but has never approached platform-scale adoption.
Its own CIC structure — a 35% dividend cap — also foreclosed the kind of venture capital
that could have funded aggressive scaling, a direct trade-off between trust-signaling and
growth capital.
Sources: [Mydex, "Achieving Transformation at Scale" (2021 PDF)](https://mydex.org/resources/papers/AchievingTransformationAtScale/AchievingTransformationatScaleMydexCIC-2021-04-14.pdf);
[UK Companies House filing](https://find-and-update.company-information.service.gov.uk/company/SC319767) (accessed 2026-06-24).

**Hub-of-All-Things (HAT) / Dataswift / Dataswyft.** Originated as a UK Research
Councils-funded (~£1.2-3M) academic project (2013, six/seven universities, Warwick-led),
publicly launched as "HAT Foundation" in February 2016 (Dataswift Ltd + HAT Community
Foundation), with the thesis that personal data could power a genuine "multi-sided
market" if individuals held their own "HAT" microservers. Raised a £1.8M seed round in
September 2019 (IQ Capital-led). Rather than shutting down outright, the company appears
to have cycled through rebrands (Dataswift → "Dataswyft" → apparently back to
"Dataswift"-branded materials) and pivoted toward a "self-sovereign data wallet" product
(CheckD, 2024) and an "AI memory" framing similar to Inrupt's — but independent technical
signals (its `@dataswift/hat-js` npm package showing no releases in 12+ months as of the
search date, "very low activity" per aggregator data) suggest the platform never reached
meaningful third-party developer traction despite ten-plus years of runway and an
academic-research pedigree. I could not confirm a definitive formal-shutdown date — the
most honest characterization is "faded/rebranded rather than a documented failure," which
is itself a data point: these efforts often don't die with a bang, they quietly stop
mattering.
Sources: [Dataswift company site](https://dataswift.webflow.io/about/about-dataswift);
[Snyk npm package health for @dataswift/hat-js](https://snyk.io/advisor/npm-package/@dataswift/hat-js) (accessed 2026-06-24).

---

## 4. What made SMART on FHIR and UK Open Banking succeed where these failed

(Brief — a companion research lane covers the regulatory angle in full depth; this is
just the contrast needed for the synthesis table below.)

**SMART on FHIR:** the 21st Century Cures Act (2016) directed a "universal API" for
patient access to structured health data; ONC's 2020 Interoperability Final Rule *named
SMART as that API* and made SMART support **a certification requirement for Health IT
Modules** as of May 2020. CMS regulations independently pushed payer systems the same
direction. Result: by 2022, over two-thirds of US hospitals reported FHIR-API-enabled
patient access (up 12 points YoY); Epic, Cerner/Oracle Health, Allscripts all ship SMART
support as a compliance necessity, not a choice.
Source: [ONC/Cures Act coverage, aggregated via Descope/SecurityBoulevard summaries](https://www.descope.com/learn/post/smart-on-fhir) (accessed 2026-06-24).

**UK Open Banking:** originated from the CMA's 2016 finding that incumbent banks
dominated the market to consumers' detriment. The CMA legally **mandated** the nine
largest banks (CMA9, >90% of UK consumer/SME accounts) to build common APIs, and — this
is the important design detail — two CMA officials involved explicitly said a voluntary
approach was rejected because "the firms whose active cooperation was required had both
the ability and incentive to frustrate it." Open Banking Ltd was created (Sept 2016)
specifically to run **conformance monitoring**: a pass/fail conformance tool, published
certificates, monthly conformance reporting to a Trustee, and escalation to formal CMA
Directions and mandated "Performance Improvement Plans" for non-conformant banks.
Security conformance (FAPI) was independently certified by the OpenID Foundation with
its own public pass/fail certificate table. Result: near-100% CMA9 conformance, roadmap
declared fully complete September 2024, 11.3M+ monthly active users and a >£4B ecosystem
by mid-2024, and the model has been emulated in ~60 other jurisdictions.
Source: [Open Banking Ltd, CMA roadmap completion announcement](https://www.openbanking.org.uk/news/cma-confirms-full-completion-of-open-banking-roadmap-unlocking-a-new-era-of-financial-innovation/) (accessed 2026-06-24).

**The pattern in both cases:** (1) a regulator with actual enforcement power over the
specific *incumbents holding the data*, (2) a **legal mandate**, not a voluntary
standard, (3) an explicit **conformance/certification regime** with a pass/fail tool and
public certificates — not just a spec document — and (4) real consequences for
non-conformance (blocked certification revenue in health IT; CMA Directions in banking).
Every prior-art failure in §§1-3 lacked at least the first two of these; several also
lacked #3 even in concept.

---

## 5. Synthesis table

| Project | No supply-side forcing function | No demand-side actor | No data model / query interface | Complexity (spec or architecture) | Required platform cooperation |
|---|---|---|---|---|---|
| **UMA 1.0/2.0** | Yes — voluntary Kantara standard, no regulator, no IETF blessing | Partial — requesting parties were mostly individual humans, not software at scale | Yes — by design, scoped out; the RS's data model/API is explicitly "outside the scope" | Yes — 5-party model; 1.0's own AAT/object-typed extensions were unused dead weight per its own authors | Yes — needs the resource server operator to implement UMA, i.e., the platform |
| **Solid** | Yes — no regulator; a voluntary W3C-adjacent community spec | Partial — mostly privacy-motivated individuals and a few governments, no software-agent demand class | No — Solid explicitly *does* define a data model (Linked Data/RDF) and storage protocol; its actual gap is a documented, common app-facing API contract, not the model itself | Yes — RDF/Linked Data has a steep authoring curve; login/auth UX is a widely cited practical blocker | Yes, most acutely — needs either the platform to expose a Pod, or the user to migrate off-platform entirely; direct conflict with ad-supported business models |
| **DataPortability.org** | Yes — pure advocacy coalition, no spec of its own, no enforcement | No — was itself trying to represent user/developer demand, but had no artifact for that demand to consume | Yes — never shipped a technical spec, only a "blueprint"/conversation | Low (little to implement) but that's also *why* it had no teeth | Yes — entirely dependent on member platforms voluntarily building something; Facebook shipped its own proprietary alternative instead |
| **Locker Project / Singly** | Yes — no regulator, no standard body at all, single-vendor OSS project | Yes, this is its core gap — no durable class of apps wanted "digital exhaust" data at the time | No — it *did* define a record/connector model (closest historical analog to PDPP's collection layer) | Moderate — connector architecture itself was tractable, complexity wasn't the killer | Partial — used platform APIs/connectors rather than requiring platform redesign, but still hostage to per-platform API access & goodwill |
| **Mydex CIC** | Yes — no mandate; relied on voluntary government partnership that didn't scale (Verify procurement) | Partial — UK government was a real early demand-side actor, but not durable/broad enough | No — has an actual PDS product with a defined data model | Low-moderate technically, but the CIC governance structure itself capped growth capital | Partial — needed government agencies and, eventually, businesses to integrate; explicitly chose incremental cluster adoption over a forcing function |
| **HAT / Dataswift** | Yes — no regulator, pure market-based multi-sided-market thesis | Yes — the "multi-sided market" demand side (buyers of a person's HAT data) never materialized at scale | No — HAT explicitly is a data-model/microserver spec (its distinguishing feature) | Moderate — microserver-per-user infra is nontrivial to run at scale | Yes — depends on a market of data-buyers and data-providing platforms both showing up; neither did durably |
| **SMART on FHIR** *(success case)* | **No — ONC certification mandate (2020) + CMS payer rules** | Yes, mandate created captive demand (any EHR selling into US healthcare must support it) | No — FHIR *is* the data model + query API, jointly | Moderate (FHIR is a real spec to implement) but absorbed because certification requires it | No — the mandate forces exactly the platform cooperation the others couldn't get voluntarily |
| **UK Open Banking** *(success case)* | **No — CMA legal Order + conformance certification regime** | Yes — TPPs (300+ regulated firms) exist because the mandate guarantees API access | No — the Open Banking Standard defines both data model and API | Moderate (real API/security spec, FAPI) but absorbed under legal compulsion | No — CMA9 legally compelled; explicitly rejected a voluntary approach as unworkable |

---

## 6. Honest assessment: what PDPP has actually mitigated, and what it has not

### Mitigated (with the actual mechanism, not just the claim)

- **"No data model / no query interface" — this is UMA's gap specifically, and PDPP
  closes it directly.** UMA scoped out the record model and the read/query API by design;
  PDPP's spec-core.md §4 (record model: streams, primary keys, blobs, resource
  references) and §8 (resource server interface: filter, project, expand, paginate,
  incremental sync, schema discovery — see `docs/positioning/the-read-surface.md`) are
  exactly the missing normative layer. This is a precise, verifiable claim: it is *not*
  true of Solid, HAT, or Mydex, all of which *did* define data models — so PDPP's
  differentiation from those three is narrower (see below) than its differentiation from
  UMA.
- **"Requires platform cooperation" — PDPP's collection profile is a genuine, if
  partial, answer that none of these six had.** Solid's most-cited failure mode is that
  it needs the incumbent platform to expose a Pod, or the user to fully migrate away.
  PDPP's Collection Profile (browser-automation/scraping-based connectors, per
  `docs/research/collection-*` and the connector manifest model) is a bootstrap path that
  does not require Instagram, Amazon, etc. to adopt anything — it acquires the data on
  the user's behalf and re-serves it under the PDPP grant/query model regardless of
  whether the source platform ever cooperates. This is the one mechanism among the
  graveyard that has a real analog only in the Locker Project's connector model (which
  had the collection idea right but no durable demand side) — PDPP is closer to "Locker
  Project's collection layer + UMA's authorization rigor + FHIR/Open-Banking's normative
  data model," which is a real synthesis, not a novel primitive.
- **"No demand-side actor" — the AI-agent thesis is PDPP's stated bet, and it's a
  plausible answer to the one gap every graveyard project shared.** DataPortability.org,
  Locker/Singly, and HAT all ultimately failed for want of a durable buyer/consumer of
  the data once collected. `docs/positioning/why-a-horizontal-consent-layer-why-now.md`
  already states this precisely as "a bet on a newly-viable demand-side actor, not a
  claim that the market is already pulling for it" — that hedge is correct and should
  stay in place. AI agents consuming a machine-legible, field-scoped grant is a
  structurally different demand-side actor than "a photo-sharing website in 2011," but
  it is unproven at the scale that would falsify the graveyard pattern.

### NOT mitigated — the honest gap list

- **Still one implementation, not an ecosystem.** UMA's adoption ceiling was partly that
  it stayed inside Kantara and never reached IETF-level, multi-vendor network effects.
  PDPP today has the reference implementation in this repo and no independent
  second-party implementation. Every one of PDPP's "differentiators" above is a claim
  about the *spec*, and specs with a single implementer have historically been
  indistinguishable from a well-documented single product (this is exactly Mydex's and
  HAT's situation — both had real, working data models and real production code, and
  neither became a multi-vendor standard).
- **No certification/conformance regime.** §4 shows this is the single sharpest
  discriminator between the graveyard and the two success cases: SMART on FHIR and Open
  Banking both paired a mandate with a pass/fail conformance tool and public
  certificates. PDPP's spec-core.md explicitly defers this ("A conformance test suite
  for this specification is planned but is not defined in v0.1," §1). Until that exists,
  PDPP has no mechanism analogous to what made the two success cases stick, and no
  regulator is mandating PDPP the way ONC mandated SMART or the CMA mandated Open
  Banking — `why-a-horizontal-consent-layer-why-now.md` is correct that this is "a bet,"
  not a forcing function PDPP itself supplies.
- **Platform hostility to scraping-based collection is a real, live risk, not a solved
  problem.** The Collection Profile bootstraps supply *without* platform cooperation, but
  "without cooperation" cuts both ways — it also means operating against platforms'
  wishes (ToS, anti-bot measures, legal risk under CFAA-adjacent theories depending on
  jurisdiction), which is categorically different from Open Banking's or SMART's
  legally-compelled, platform-cooperative data access. This is closer to Locker/Singly's
  position (connector-based collection against platform APIs, informal or adversarial)
  than to the regulated success cases, and Locker/Singly's collection layer did not save
  it from the demand-side failure. PDPP inherits the adversarial-collection risk profile
  even though it has (arguably) solved the demand-side and data-model gaps that sank
  Locker/Singly and UMA respectively.
- **The "requesting party as software agent, not human" distinction from UMA is
  currently more architectural than proven.** UMA's requesting-party flows assumed a
  human doing claims-gathering through a UI; PDPP's grant is machine-legible RFC 9396
  `authorization_details`, which *should* be more consumable by an autonomous agent —
  but no evidence gathered in this pass demonstrates agents actually driving PDPP grant
  flows at any meaningful volume yet. Mark this as a design intent, not a demonstrated
  outcome.

---

## Draft position: why not UMA?

*(Written in the format used by `docs/positioning/*.md` — this section is a draft only;
it has not been reviewed or added to `docs/positioning/README.md`'s index. Treat as input
to a future positioning file, not a settled position yet.)*

**Status:** Draft — evidence gathered 2026-06-24; not yet reviewed against the "Why a
horizontal consent layer, why now" and "PDPP and OAuth" positions for consistency, and
not yet added to the positioning index.

### Asked as

- "UMA already solved this — why does PDPP exist?"
- "Isn't PDPP just UMA with extra steps?"
- "What's different from User-Managed Access?"

### Short answer

UMA and PDPP solve different halves of the same problem. UMA is a rigorous,
Kantara-ratified OAuth extension for *party-to-party authorization* — letting a resource
owner grant a third party access asynchronously — and it deliberately leaves the
resource's data model, query interface, and collection mechanism entirely undefined,
by design, out of scope. PDPP assumes an OAuth 2.0 + RFC 9396 authorization layer (in the
same family UMA occupies) and defines the piece UMA explicitly declined to: a record
model, field-level grants, and a normative resource-server query interface for personal
data specifically. PDPP is closer to "what UMA would need paired with" than a competitor
to it.

### Why it's true

- **UMA's own spec text puts its data-model/API silence on the record.** The core UMA
  spec says resource partitioning, internal complexity, and the RS's actual interface
  (programmatic API vs. simple web pages) are all "outside the scope of this
  specification." This is not a gap critics inferred — it's stated scope.
- **UMA never broadened even within its narrower authorization scope**, for reasons
  mostly orthogonal to the data-model gap: no regulator or IETF forcing function, a
  5-party architecture heavier than the OAuth flows most teams needed, and (per UMA
  co-designer Justin Richer's own retrospective) 1.0-era design assumptions that broke on
  first real-world contact in a healthcare pilot, requiring a full rewrite in 2.0.
- **The record-model/query gap is exactly PDPP's normative core** (spec-core.md §4, §8;
  `docs/positioning/the-read-surface.md`), so the two specs are complementary layers, not
  overlapping alternatives, in the same way SMART on FHIR pairs OAuth with the FHIR
  Consent/data model rather than replacing OAuth.

### What we do NOT claim

- We do **not** claim UMA is poorly designed for what it set out to do — its scope
  discipline (staying authorization-only) is defensible and its own maintainers'
  post-hoc simplifications (dropping the AAT, flattening extension points) show a healthy
  spec-evolution process, not incompetence.
- We do **not** claim PDPP has solved UMA's adoption problems structurally — PDPP has the
  same missing pieces UMA lacked when it stalled: no regulator-backed forcing function,
  no certification/conformance regime, and (so far) one implementation. The data-model
  gap is closed on paper; the adoption-mechanism gap is not.
- We do **not** claim PDPP requires or depends on UMA. PDPP profiles OAuth 2.0 + RFC 9396
  directly; it does not build on UMA's permission-ticket/RPT flow. The comparison is
  useful because UMA is the closest prior art to PDPP's authorization half, not because
  PDPP extends it.

### References

- `apps/site/content/docs/spec-core.md` §4 (record model), §8 (resource server
  interface), §1 (conformance test suite deferred).
- `docs/positioning/pdpp-and-oauth.md`, `docs/positioning/the-read-surface.md`,
  `docs/positioning/why-a-horizontal-consent-layer-why-now.md`.
- Primary UMA sources cited in §1 above, especially the Kantara core spec's scope
  language and Justin Richer's UMA 2.0 retrospective.
