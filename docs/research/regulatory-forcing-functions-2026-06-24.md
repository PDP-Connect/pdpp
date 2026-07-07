# Regulatory Forcing Functions for a Standardized Personal-Data Authorization + Portability Protocol

Status: captured
Owner: reference implementation owner
Created: 2026-07-06 (task dated 2026-06-24; research conducted and this file written 2026-07-06)

## Question

Which current and incoming regulations create demand for a standardized personal-data
authorization + portability protocol — something PDPP-shaped: OAuth-profile consent,
field-level grants, continuous standing access, a queryable read surface? And exactly
how did regulation-to-standard coupling work in the two clearest success precedents
(SMART on FHIR in US healthcare, UK Open Banking)?

## Method and confidence discipline

This report was compiled from four parallel research passes (EU DMA/Data Act; GDPR
Art. 20 + US CFPB 1033 + SMART on FHIR; UK Open Banking + Australia CDR; India/Brazil/UK
Smart Data/DTI), each independently sourced and cross-checked. Every claim below carries
an inline citation with URL and access date (**all URLs accessed 2026-07-06** unless
otherwise noted) and, where sourcing is secondary rather than a directly-fetched primary
text, an explicit confidence flag. Several primary regulatory domains (EUR-Lex,
federalregister.gov, meity.gov.in, bcb.gov.br, planalto.gov.br) were blocked or
unreadable by the fetch tooling used in this session — those claims rest on
cross-corroborated secondary sources (law-firm trackers, official-agency blog posts,
peer-reviewed retrospectives) rather than a direct Official-Journal/Federal-Register
read, and are flagged inline. Litigation status and EC guidance are moving targets;
treat every date-stamped claim as accurate as of 2026-07-06 and re-verify before relying
on it later.

---

## 1. EU DMA Article 6(9) — continuous, real-time, free portability

### What it literally requires

Article 6(9) of the Digital Markets Act (Regulation (EU) 2022/1925) is an affirmative
"let data out" obligation on designated gatekeepers: they must provide end users, and
third parties authorized by end users, with **effective portability of data provided by
the end user or generated through their activity**, including **continuous and
real-time access**, free of charge. (Cross-corroborated secondary mirror of the
statutory text, https://www.eu-digital-markets-act.com/Digital_Markets_Act_Article_6.html,
accessed 2026-07-06 — EUR-Lex itself was unreachable this session; confidence: high on
substance, medium on exact wording pending a direct EUR-Lex re-check.)

This is distinct from — and should not be conflated with — **Article 5(2)** (restricting
combining/cross-using personal data across a gatekeeper's own services without consent)
and **Article 6(2)** (restricting a gatekeeper's use of non-public business-user data).
Those are *data-use restriction* provisions governing what a gatekeeper may do
internally with data it already holds. **6(9) is the only DMA provision that mandates an
outbound, continuous, real-time portability channel** — which is exactly the PDPP-shaped
capability (standing access, not a one-shot export).

### Scope

As of this research pass, 7 gatekeepers and 23 core platform services are designated on
the Commission's Gatekeepers Portal: Alphabet, Amazon, Apple, Booking.com, ByteDance,
Meta, Microsoft. (https://digital-markets-act.ec.europa.eu/gatekeepers-portal_en,
accessed 2026-07-06; confidence: high.) Article 6(9) applies uniformly across all
designated core platform services for each of these gatekeepers.

### What gatekeepers actually shipped (2024-2026)

At the first compliance-report deadline (March 2024), **no gatekeeper shipped a
purpose-built Article 6(9) portability API** — all retrofit-then-matured existing
GDPR-era export tooling instead of building something new for the DMA:

- **Google:** Data Portability API (the same API documented in the PDPP corpus's own
  `google-maps-data-portability-api-timeline-2026-06-11.md` note — OAuth consent,
  time-based archive initiation, polling, signed-URL download).
- **Amazon:** Data Portability API.
- **Apple:** Account Data Transfer API / AppMigrationKit.
- **Booking.com:** Data Portability API.
- **ByteDance/TikTok:** Data Portability API.
- **Meta:** notably slower — only merged its separate "Download Your Information" (DYI)
  and "Transfer Your Information" (TYI) tools into a unified "Export Your Information"
  flow in the 2026 compliance cycle, roughly two years after the March 2024 deadline.
- **Microsoft/LinkedIn:** Member Data Portability APIs.

(Per-company compliance-report links and the independent SCiDA project's "DMA Compliance
Reports in Year Three" analysis,
https://scidaproject.com/2026/04/02/dma-compliance-reports-in-year-three-reading-between-the-many-lines/,
accessed 2026-07-06; confidence: medium-high — corroborated by the research agent's
per-company source table, but individual gatekeeper compliance-report URLs were not
independently re-verified by the synthesizing pass. Recommend spot-checking the most
load-bearing claim (Meta's ~2-year lag) directly against Meta's published DMA compliance
report before quoting in an external-facing document.)

### Enforcement — the key negative finding

**No Commission enforcement action, non-compliance decision, or specification
proceeding has ever targeted Article 6(9) specifically.** By contrast, the Commission
opened detailed, highly prescriptive **Article 6(7)/6(11)** specification proceedings
against Apple (Sept 2024, interoperability for connected devices/accessories) and Google
(Jan 2026, self-preferencing in search results) — showing the Commission *can and does*
mandate granular technical specificity via the DMA's specification-proceeding mechanism
when it chooses to. **It has never done so for portability.** (Cross-corroborated across
specialist DMA trackers; confidence: high on the negative finding — absence of
enforcement is easier to confirm across sources than presence.)

The closest thing to formal EU guidance touching 6(9) is the **October 2025 joint
EDPB/European Commission Guidelines** clarifying the DMA-GDPR interplay — interpretive
only, not a binding technical specification. (Confidence: medium — the existence of
joint guidance is well corroborated; its exact scope re: 6(9) specifically was not
independently verified against the primary EDPB text this session.)

### Is there ANY technical standard? — Verifying the core hypothesis

**The hypothesized gap is real and confirmed by two independent negative findings:**

1. **BEREC's substantive DMA role is on Article 7** (messaging-service interoperability,
   e.g., WhatsApp/iMessage), **not Article 6(9)**. No BEREC opinion, technical report, or
   guidance on portability technical standards was found. (Confidence: medium-high — a
   focused search found no BEREC 6(9) output; this is a negative finding, harder to prove
   exhaustively than a positive one, so treat as "no evidence found" rather than "proven
   absent.")
2. **The Data Transfer Initiative (dtinit.org)** — the industry consortium backed by
   Apple, Google, and Meta as Founding Members (Amazon and Ernie App as Partners; Twitter/X
   is **not** currently a member) — has engaged extensively and explicitly with Article
   6(9), including a formal written submission to the European Commission's 2025 DMA
   one-year-review consultation (dated 22 Sept 2025,
   `dtinit.org/assets/DTI-Response-to-DMA-One-Year-Review.pdf` — URL/existence confirmed,
   PDF content not directly readable by tooling this session; confidence: medium on exact
   quoted content, high on the submission's existence). DTI's own blog post "Putting a
   price on portability" (dtinit.org/blog/2026/02/24/..., directly read, accessed
   2026-07-06) states: *"If you are asking me should Article 6(9) of the DMA be viewed as
   a positive success story, then I would say absolutely, yes! It has been a catalyst for
   major progress..."* — but DTI **explicitly and repeatedly disclaims building or
   endorsing one shared technical standard**. From "Progress towards real world
   portability solutions" (dtinit.org/blog/2024/03/26/..., directly read, accessed
   2026-07-06): *"designated gatekeepers have developed... interfaces... not reliant on a
   shared data model or open source code base... There is no silver bullet for data
   portability, now or in the future."* DTI's own Data Transfer Project (DTP) codebase is
   explicitly **not** positioned as "the" Article 6(9) compliance mechanism — DTI reserves
   DTP for narrower verticals (photo/playlist transfer) instead. (Confidence: high — both
   quotes are from directly-read DTI blog posts, primary source for DTI's own position.)

**Net finding: DMA Article 6(9) creates a live, unfilled standards gap.** The obligation
exists, gatekeepers are shipping divergent bespoke APIs, no regulator has stepped in to
mandate a common technical shape, and the one industry body positioned to fill the gap
(DTI) has explicitly declined to converge on a single protocol — instead pursuing a
narrower "trust/authorization layer" play (see §6d below) rather than standardizing the
transfer layer itself. This is the strongest single confirmation in this research that
**the gap the user hypothesized is real, not assumed.**

---

## 2. EU Data Act (Regulation (EU) 2023/2854)

### Application date

Entered into force 11 January 2024; **applies from 12 September 2025**.
(https://digital-strategy.ec.europa.eu/en/policies/data-act, accessed 2026-07-06;
confidence: high — this is the Commission's own policy page.) Note: Article 3(1)'s
"access by design" obligation (requiring connected products to be designed so data is,
by default, directly accessible) is delayed to **12 September 2026** for newly placed
products — a second, later deadline that's easy to miss.

### Articles 3-5 — connected-product data access

Binds **"data holders"** — product manufacturers and related-service providers (SMEs are
exempted). Requires that data generated by connected products/related services be made
available to the user free of charge, in a structured, commonly used, machine-readable
format, **"continuously and in real-time" where technically feasible**, including to a
user-designated third-party **"data recipient."** Notably, **Article 5(3) explicitly bars
DMA gatekeepers from being eligible data recipients** under the Data Act — an
anti-circularity provision preventing gatekeepers from using Data Act rights to acquire
more third-party data even as they're separately obligated to give up their own under DMA
6(9). (Cross-corroborated secondary sources; EUR-Lex unreachable this session;
confidence: medium-high on substance, and the anti-circularity point (5(3)) is a specific,
checkable detail worth re-verifying directly against EUR-Lex before publishing
externally.)

This in-statute format language ("structured, commonly used, machine-readable," "real
time where technically feasible") is **more prescriptive than DMA 6(9)'s vaguer
"effective portability"** — the Data Act's drafters clearly had GDPR Article 20's
underdelivery in mind (see §3).

### Interoperability articles — number correction

**Important correction to the original research brief's assumption:** the operative
interoperability provisions in the **final adopted text** are **Articles 33-36**, not
"28-30" (28-30 was draft/trilogue-stage numbering that shifted before final adoption;
final Article 30 in the adopted Regulation actually concerns cloud-switching, an
unrelated topic). Article 33 sets essential requirements for data-space and
data-sharing-mechanism interoperability; Article 36 sets essential requirements for smart
contracts used to execute data-sharing agreements. (Confidence: medium-high — this
numbering correction came from the research agent's synthesis of official EU sources;
recommend a direct EUR-Lex table-of-contents check before citing article numbers in any
externally-facing document, since getting this wrong would undermine credibility with a
regulatory audience.)

### Standard-setting status — thin and incomplete as of mid-2026

The Data Act defers technical interoperability specification to **CEN/CENELEC/ETSI**
standardization under **Commission Mandate M/614** (accepted 7 July 2025), which calls
for 4 European Standards + 3 Technical Specifications. **Only one deliverable has been
published so far: EN 18235-1:2026 (terminology), March 2026.** The interoperability-
specific Part 3 of that standards package isn't due until **May 2027**. No delegated or
implementing act (the Commission's fallback "common specifications" mechanism if
harmonized standards aren't ready in time) has been adopted as of 2026-07-06. Separately,
a pending **"Digital Omnibus" proposal** (Nov 2025) would roll back parts of the Article
36 smart-contract regime — but as of mid-2026 only the AI-law track of that omnibus
package had passed, not the Data Act rollback. (Confidence: medium-high — the M/614
mandate and single-deliverable status are specific, checkable facts from the research
agent's pass; worth a direct CEN/CENELEC standards-catalog check before quoting a
completion percentage externally.)

**Net finding: the Data Act's own interoperability standard is roughly 1-of-7
deliverables (~15%) complete, nearly a year after the Act's application date.** This is
a second, independent confirmation that EU technical-standard-setting for data
portability/interoperability lags far behind the legal mandate — a structural pattern,
not a one-off gap specific to the DMA.

---

## 3. GDPR Article 20 — why it underdelivered (brief)

**Literal text** (Regulation (EU) 2016/679, Art. 20(1)-(3)): the data subject has the
right to receive personal data they provided to a controller, in a structured, commonly
used, machine-readable format, and to transmit it to another controller "without
hindrance"; Art. 20(2) adds a right to *direct* controller-to-controller transfer "where
technically feasible." (https://gdpr-info.eu/art-20-gdpr/, accessed 2026-07-06 — mirrors
the EUR-Lex consolidated text; confidence: high.)

**Recital 68** is the crux of why it underdelivered: it states the right "should not
create an obligation for controllers to adopt or maintain processing systems which are
technically compatible" — i.e., **interoperability is explicitly encouraged, not
required.** (Same source; corroborated by Article 29 Working Party Guidelines WP242
rev.01, https://www.edpb.europa.eu/our-work-tools/our-documents/guidelines/guidelines-right-data-portability-under-regulation-2016679_en,
accessed 2026-07-06; confidence: high — this is the EDPB's own primary guidance.)

Four compounding reasons for underdelivery, in order of evidentiary strength:

1. **Scope limitation**: Article 20 only covers data the subject *actively provided*
   (by consent or contract), not observed/derived/inferred data. (WP242, as above;
   confidence: high.)
2. **No mandated format/interoperability**: WP242 only "encourages" interoperable
   formats; combined with Recital 68's explicit no-obligation clause, this is why
   practice converged on one-shot "download my data" JSON/CSV dashboards rather than
   continuous API access — the direct-transfer right in 20(2) applies only "where
   technically feasible," and for most controllers it simply isn't, by design.
3. **Low usage — the Commission's own words.** The European Commission's first GDPR
   evaluation report (COM(2020) 264 final, 24 June 2020) explicitly names "**Unused
   Potential of Data Portability Rights**" as a problem area and commits to "explore
   practical means to facilitate increased use." (Directly sourced from the primary
   Commission PDF,
   https://www.europarl.europa.eu/RegData/docs_autres_institutions/commission_europeenne/com/2020/0264/COM_COM(2020)0264_EN.pdf,
   accessed 2026-07-06; confidence: high.)
4. **The Commission's own fix wasn't to amend Article 20 — it was to legislate
   elsewhere.** The Commission's second Article 97 evaluation report (2024,
   COM(2024)357) does not revise Article 20 itself; instead it points to the **Data Act**
   (a stronger, connected-product-specific portability right with "technically possible"
   language) and the **DMA** (6(9)'s continuous-real-time-access mandate) as the
   practical remedies. (Search-engine-synthesized from COM(2024)357; the primary EUR-Lex
   text (CELEX:52024DC0357) was not directly fetched this session; confidence:
   medium-high — recommend direct confirmation before verbatim quoting.)

**Bottom line for the report's thesis:** GDPR Article 20 is the negative control case —
a general-purpose portability right with no named technical standard and no downstream
enforcement lever beyond DPA complaint-driven enforcement. The EU's own evaluation
process concluded the fix wasn't fixing Article 20, but building narrower, sector/
platform-specific mandates around it (DMA, Data Act) — exactly the pattern the rest of
this report traces.

---

## 4. United States

### 4a. CFPB Section 1033 (Personal Financial Data Rights Rule, 12 CFR Part 1033)

**Finalized 22 October 2024**, implementing Section 1033 of the Consumer Financial
Protection Act (Dodd-Frank), 12 U.S.C. § 5533; codified at 12 CFR Part 1033.
(https://www.consumerfinance.gov/rules-policy/regulations/1033/, and eCFR,
https://www.ecfr.gov/current/title-12/chapter-X/part-1033, accessed 2026-07-06;
confidence: high.)

**Technical mechanics — no single mandated API, industry-recognized standard-setter
model instead.** The rule requires "developer interfaces" meeting performance/security
specs, but delegates the actual technical standard to a CFPB-recognition process for
"industry standard-setting bodies" (openness, transparency, balanced decision-making,
consensus, due-process/appeals criteria, finalized June 2024, 89 FR 49084). On **8
January 2025**, CFPB formally recognized the **Financial Data Exchange (FDX)** as the
first (and to date only) such body, for five years through January 2030.
(https://files.consumerfinance.gov/f/documents/cfpb_standard-setter-decision-and-order-of-recognition-fdx_2025-01.pdf,
accessed 2026-07-06; confidence: high — primary CFPB order.) FDX's API reportedly served
~94 million consumer records (~75% of the addressable market) at recognition time,
growing to a reported ~130 million connected accounts by early 2026 (industry-tracker
claim, https://financialdataexchange.org/cfpb-1033/, confidence: medium on the 2026
figure specifically).

**Litigation status as of 2026-07-06 — the load-bearing, currently-unresolved fact:**

- Filed same-day as finalization (22 Oct 2024): Forcht Bank, Bank Policy Institute (BPI),
  and Kentucky Bankers Association sued CFPB in the **U.S. District Court for the
  Eastern District of Kentucky**, arguing CFPB exceeded its statutory authority.
  (https://bpi.com/section1033/, accessed 2026-07-06; confidence: high.)
- May 2025: Financial Technology Association granted intervenor status defending the
  rule.
- **23 May 2025: CFPB itself, under new (Trump-era) leadership, reversed position** —
  its own chief legal officer filed a status report stating "Bureau leadership has
  determined that the Rule is unlawful and should be set aside," followed by a 30 May
  2025 motion for summary judgment asking the court to **vacate its own rule**.
  (Corroborated across two independent law-firm trackers plus BPI's own site;
  confidence: high.)
- **~29 July 2025**: rather than pursue outright vacatur, CFPB petitioned to **stay the
  litigation** to run a **new rulemaking** to "substantially revise" (not simply kill)
  the rule. Judge Danny Reeves granted the stay.
- **21-22 August 2025**: CFPB issued an Advance Notice of Proposed Rulemaking (ANPR)
  soliciting comment on (a) the meaning of "representative" (fiduciary-type vs. any
  authorized third party — this directly threatens the rule's "authorized third party"
  mechanism, the closest analog to a PDPP-style grant), (b) fee structures for data
  access, (c) data-security cost/benefit, (d) privacy threat picture. ~13,979 comments
  received. (Federal Register,
  https://www.federalregister.gov/documents/2025/08/22/2025-16139/personal-financial-data-rights-reconsideration,
  accessed 2026-07-06; confidence: high.)
- **Late October 2025: Judge Reeves lifted the stay and issued a preliminary
  injunction enjoining CFPB from enforcing the rule** pending reconsideration —
  specifically blocking the first compliance deadline. The court found plaintiffs
  likely to succeed on two grounds: (1) statutory interpretation — "representative"
  must be read as fiduciary-type (agent/trustee), not any CFPB-authorized commercial
  third party, directly undercutting the rule's core third-party-access mechanism; (2)
  arbitrary-and-capricious — CFPB failed to weigh cumulative data-security impact and
  didn't adequately justify the fee prohibition/fixed deadlines. (Corroborated across
  multiple independent law-firm client alerts and BPI's own site; confidence: high.)
- **Bottom line as of 2026-07-06: the rule is enjoined, not vacated.** It remains on the
  books, but CFPB cannot enforce it while it runs a new rulemaking. The first phased
  compliance deadline (largest institutions, originally targeted around April 2026)
  passed without becoming a binding enforcement trigger. No final resolution is in
  sight; expect continued limbo through 2026 given typical agency-rulemaking timelines
  and CFPB's reported staffing constraints. (Confidence: high on "enjoined not vacated"
  as the current status; medium on the forward-looking "expect continued limbo"
  characterization, which is necessarily speculative.)

**Regulatory-forcing-function implication — a cautionary case, not a clean win.** Section
1033 used a model structurally close to what a PDPP-shaped standard advocate would want
(developer-interface mandate + CFPB-recognized industry standard body, FDX). It got
enjoined largely on **US-specific statutory-authority and Administrative Procedure Act
grounds**, not because the technical design was flawed — a reminder that in the US,
forcing functions built on executive-branch agency rulemaking (rather than direct
statute) are comparatively litigation-fragile.

### 4b. US state privacy laws (CCPA/CPRA, Colorado, Virginia)

**No US state comprehensive privacy law mandates a technical portability standard or
continuous-access API.** All use GDPR-Art.-20-style "structured, commonly used, machine-
readable... to the extent technically feasible" language, satisfied in practice by
one-shot exports:

- **CCPA/CPRA** (Cal. Civ. Code §1798.100(d), §1798.130(a)(2)): "technically feasible"
  is undefined in statute, left to enforcement interpretation. 45-day response window
  (extendable by 45 more). (Confidence: medium-high — synthesized from multiple
  secondary legal-analysis sources; raw statutory text not independently re-verified
  this session.)
- **Colorado (CPA)**: notably broader than Virginia — the portability right is not
  explicitly limited to consumer-*provided* data — but adds a throttling mechanic not
  seen elsewhere: **capped at twice per calendar year**.
- **Virginia (VCDPA)**: right limited to data the consumer previously provided,
  mirroring GDPR Art. 20's scope limitation.
- Connecticut's CTDPA reportedly uses substantially the same formulation as VA/CO.

(Confidence: medium-high throughout — consistent across multiple independent law-firm
comparisons, not independently checked against raw statutory text.)

**Net finding: Section 1033 is the only US regime attempting an actual API-mandate-with-
recognized-standard-body model, and it is currently enjoined.** State privacy law
portability rights are uniformly one-shot-export-shaped, same as GDPR Art. 20.

### 4c. ONC / SMART on FHIR — see §6a below (full mechanics, the key positive precedent)

---

## 5. Other jurisdictions (briefer treatment)

### 5a. Australia — Consumer Data Right (CDR), focus on expansion

CDR rolled out banking first (2020), then energy (phased in 4 tranches per a Feb 2025
compliance guide). A July 2024 independent **CDR Strategic Review** delivered a harsh
verdict: after 4 years, **only 0.31% of bank customers had an active data-sharing
arrangement** at end of 2023, against ~AU$1.5 billion in banking-industry compliance
spend since 2018.
(https://www.ausbanking.org.au/wp-content/uploads/2024/07/CDR-Strategic-Review_July-2024.pdf,
accessed 2026-07-06; confidence: medium-high — hosted by an industry association
describing a government-commissioned review; the primary Treasury original was not
independently fetched.)

The government's response (Aug 2024) was **reform and re-funding, not abandonment**:
expansion to non-bank lending and BNPL, targeting mid-2026 operational status, plus
AU$88.8 million in further funding over two years. As of a July 2026 industry tracker,
"the CDR has expanded to include large non-bank lenders and BNPL providers"
(https://www.ausbanking.org.au/priorities/open-banking/, accessed 2026-07-06;
confidence: medium — industry self-report, not a Treasury primary source, but the most
current dated claim found). **Action initiation** (write access, CDR's payment-
initiation analog to PSD2) was legislated via the Treasury Laws Amendment (Consumer Data
Right) Act 2024. **Characterize this precisely**: a critical strategic review prompting
a "reset," not a rollback — expansion continued on a revised timeline with new funding
attached. (Confidence: medium-high overall.)

### 5b. India — DPDP Act 2023: confirmed absence of portability, real precedent lies elsewhere

**The enacted DPDP Act has no data-portability right.** Chapter III grants only four
data-principal rights: access (§11), correction/erasure (§12), grievance redressal
(§13), nomination (§14) — no provision requiring structured/machine-readable export for
transfer to a competing fiduciary. (Cross-checked bare-act mirrors against PRS
Legislative Research's clause-by-clause summary,
https://prsindia.org/billtrack/digital-personal-data-protection-bill-2023, accessed
2026-07-06; confidence: high — the primary MeitY PDF was fetch-blocked, but the negative
finding is corroborated across independent secondary summaries.)

This is a **deliberate removal, not an oversight**: the 2018 Srikrishna draft and 2019
PDP Bill both included GDPR-Art.-20-style portability; the 2021 Joint Parliamentary
Committee actually recommended *strengthening* it; the government then withdrew that
bill entirely (Aug 2022), and the replacement draft dropped portability and right-to-be-
forgotten, carrying through unchanged into the enacted 2023 Act. (Confidence:
medium-high, convergent law-firm commentary.)

Implementation is also still phasing in: **Phase 1 (13 Nov 2025)** brought only
administrative provisions and Data Protection Board of India (DPBI) establishment into
force; substantive data-principal rights don't commence until **Phase 3 (13/14 May
2027)**. The DPBI is legally established but not yet operational as of mid-2026 (no
confirmed Chairperson appointment found), and the Act itself faces an unresolved
constitutional challenge referred to a larger bench in Feb 2026. (Confidence:
medium-high, consistent secondary sourcing.)

**The real India precedent is the Account Aggregator (AA) framework under DEPA**,
entirely outside the DPDP Act — RBI-regulated (Master Directions, most recently
consolidated Nov 2025), commercially live since Sept 2021. Mechanics: a three-party
model (Financial Information Provider, licensed NBFC-Account-Aggregator as a "data-blind
pipe," Financial Information User), with each data-sharing request generating a
cryptographically signed, time-bound, purpose-bound **"consent artifact"** — the closest
India-Stack analog to an OAuth-style scoped grant. It spans four financial regulators
(RBI, SEBI, IRDAI, PFRDA) via the Financial Stability and Development Council. Scale (2
Sept 2025, PIB primary source): 17 licensed AAs, 2.2 billion accounts enabled, 112.34
million users linked. **Crucially, participation by data holders (FIPs) and requesters
(FIUs) is voluntary/market-driven** — no law compels a bank to join, which explains
incomplete penetration despite the framework's technical maturity. (PIB press release,
https://www.pib.gov.in/PressReleasePage.aspx?PRID=2162953&reg=48&lang=2, accessed
2026-07-06, directly fetched; confidence: high on architecture and scale figures.)

**Synthesis: India is a clean case of a jurisdiction explicitly rejecting general-law
portability while building one of the world's most successful sectoral,
consent-artifact-based, continuous-access data-sharing infrastructures entirely outside
that law** — evidence that sectoral financial-data mandates, not omnibus privacy
legislation, are the actual forcing function that produces PDPP-shaped infrastructure.

### 5c. Brazil — Open Finance (strongest single non-US/UK precedent) and LGPD

**Open Finance Brasil** is regulated jointly by Banco Central do Brasil (BCB) and the
Conselho Monetário Nacional (CMN) via administrative "Resolução Conjunta" instruments
(foundational: Resolução Conjunta nº 1/2020). Mandate mechanism is distinct from both
the UK's CMA-order (named-incumbents) model and PSD2's single-directive model: a
central-bank administrative resolution, phased by institutional size, progressively
broadened (Resolução Conjunta nº 10/2024 extended mandatory participation to
institutions with 5M+ clients from Jan 2025, targeting ~95% coverage up from ~51%).
(Confidence: medium-high, consistent secondary legal sourcing; primary BCB text
fetch-blocked.)

**Technical standard is confirmed FAPI-based**: OAuth 2.0, PKCE, OIDC, FAPI-1-
Baseline/Advanced, with Brazil-specific hardening (mandatory ID-token encryption, `cpf`
claim, parameterized "FAPI-LIP" scopes for granular consent), certified via OpenID
Foundation conformance testing — **the same technical family as UK Open Banking**.
Governance sits with "Associação Open Finance" (a nonprofit, since Jan 2025). (Official
Open Finance Brasil developer wiki, directly corroborated via GitHub mirror, accessed
2026-07-06; confidence: high.) Scope expanded from "Open Banking" to "Open Finance" via
Resolução Conjunta nº 4/2022 (card-acquiring, forex, investments, insurance, pensions);
credit portability rolled to the general public from Feb 2026. Ecosystem scale (Jan 2026
secondary estimate): ~171 million active data-sharing authorizations, ~103 million
accounts, ~9 billion API calls/week; consent max validity 12 months, non-extendable.
(Confidence: medium-high on structure, medium on the specific numeric figures.)

**LGPD Article 18 portability, by contrast, is unregulated and GDPR-Art.-20-like.**
ANPD's own official regulations index (directly fetched,
https://www.gov.br/anpd/pt-br/acesso-a-informacao/institucional/atos-normativos/regulamentacoes_anpd,
accessed 2026-07-06) lists **no resolution regulating Article 18 portability** among its
~12 published resolutions — the delegation exists (LGPD Art. 40) but hasn't been
exercised. Open Finance and LGPD portability are **legally independent tracks**; Open
Finance runs on LGPD's *consent* legal basis (Art. 7, I) but is not framed by any
regulator as an implementation of Art. 18. (Confidence: high on the "no ANPD resolution
exists" finding — directly verified against ANPD's own primary index.)

**Synthesis: Brazil is the strongest existing precedent for a PDPP-shaped protocol at
national, continuous-access scale** — FAPI/OAuth2/OIDC-based, cross-regulator
governance, granular scoped consent, near-universal mandated participation — and it grew
entirely out of a sector-specific financial-regulator mandate, not the country's general
privacy law.

### 5d. UK Smart Data schemes beyond Open Banking

The Data (Use and Access) Act 2025 (Royal Assent 19 June 2025) is a **legislative
enabling framework for fragmentation-by-design**, not a single cross-sector standard.
Part 1 (ss.1-24) lets the Secretary of State/Treasury make secondary-legislation
regulations requiring a "data holder" to share "customer data" — but this power is
**exercised separately per sector**, each with its own data holders, data types, and its
own designated "interface body" (a generalized Open Banking Implementation Entity
model). (Directly fetched from legislation.gov.uk, accessed 2026-07-06; confidence:
high.)

Per the "Smart Data 2035" strategy (DBT, 26 March 2026): target of 5+ active schemes by
2030, 20+ by 2035, across 10 sectors. As of mid-2026: **energy** is at scoping/
pre-consultation only (Ofgem responses due 14 July 2026); **telecoms** ("Open
Communications") notably **backed away from a statutory mandate** in the March 2026
strategy in favor of a floated voluntary industry-led scheme; **Pensions Dashboards**
runs under an entirely separate legal basis (Pension Schemes Act 2021) and is not a
DUAA scheme at all. No cross-sector technical framework exists yet — DSIT's only
coordination tool is a non-binding "Smart Data Guidebook" due early 2027. (Confidence:
high on the absence of both live non-banking schemes and a cross-sector standard; medium
on future-dated specifics like the Guidebook's contents.)

**Synthesis: DUAA is evidence that even a deliberate, well-funded cross-sector agenda
can still produce N different sectoral technical standards rather than one** — a weaker
forcing function toward a single standardized protocol than Brazil's FAPI-unified Open
Finance.

---

## 6. Precedent mechanics — HOW regulation and standard actually coupled

### 6a. SMART on FHIR / ONC Cures Act certification

This is the strongest positive precedent and merits full sequencing.

**Step 1 — Statute (21st Century Cures Act, 2016).** Requires certified health IT to
provide API access to all data elements of a patient's EHR "without special effort."
**The statute itself does not name FHIR or any technical standard** — it delegates
definition of the API requirement, and the "information blocking" enforcement regime,
to HHS/ONC rulemaking. (Confidence: high on the "delegates, doesn't name FHIR" point —
well-corroborated regulatory history; raw statutory text not independently re-pulled
this session.)

**Step 2 — ONC's 2020 Cures Act Final Rule ratifies FHIR by reference.** The operative
"Conditions and Maintenance of Certification" requirement sits at **45 CFR
170.315(g)(10) — "Standardized API for patient and population services."** This
criterion **explicitly names**, by exact version: **"HL7 FHIR Release 4, Version 4.0.1:
R4, October 30, 2019, including Technical Correction #1, November 1, 2019,"** plus the
**SMART Application Launch Framework** (the OAuth2-based authorization layer) and the
**FHIR Bulk Data Access** implementation guide. (ONC's own Interoperability Standards
Platform page,
https://www.healthit.gov/isp/svap-reference-standard/ss-170315g10-standardized-api-patient-and-population-services,
and the HL7-hosted PDF of the criterion, accessed 2026-07-06; confidence: high — this
is ONC's own primary regulatory-standards documentation with an exact version citation.)
This criterion is folded into the "2015 Edition Base EHR" definition — not optional, but
baked into the baseline bar essentially all US certified EHR systems must clear.

**Step 3 — the selection mechanism: bottom-up standard, top-down ratification.** This is
not a story of ONC building something custom:

1. **~2010**: ONC itself funded (a $15M grant) Boston Children's Hospital's
   Computational Health Informatics Program and Harvard Medical School's Department of
   Biomedical Informatics to build **SMART** (Substitutable Medical Applications,
   Reusable Technologies) — a write-once-run-anywhere app platform for EHRs. One of
   several ONC-sponsored research pilots, not yet a mandate.
2. **2013**: the SMART team ported its platform onto HL7's then-draft **FHIR**
   standard, contributing an OAuth2-based "SMART App Launch" authorization framework
   into the FHIR standards process — this became **"SMART on FHIR."**
   (https://academic.oup.com/jamia/article/23/5/899/2379865, the peer-reviewed JAMIA
   paper, accessed 2026-07-06; confidence: high.)
3. **2014**: the **Argonaut Project** launched under HL7, explicitly
   **industry-funded and industry-initiated** — per ONC's own National Coordinator at
   the time, Micky Tripathi: *"It's completely private sector initiated and funded, not
   an ONC edict."* Brought together EHR vendors (Epic, Cerner, athenahealth, MEDITECH,
   McKesson) and providers (Mayo Clinic, Partners HealthCare, Intermountain, Beth Israel
   Deaconess, Boston Children's) to accelerate practical FHIR implementation and build
   the "US Core" implementation-guide profiles. (HealthcareITNews,
   https://www.healthcareitnews.com/news/argonaut-project-building-success-fhir-implementation-guide,
   accessed 2026-07-06; confidence: high on the industry-driven framing.)
4. **2015**: Argonaut performed a security review of SMART on FHIR's OAuth2-based
   authorization, feeding lessons into the US Core Implementation Guide.
5. **2020**: ONC's rulemaking then **ratified this already-mature, industry-converged
   standard by name** (FHIR R4 + SMART App Launch + Bulk Data Access) into 45 CFR
   170.315(g)(10), rather than commissioning a bespoke government API spec.

**The pattern, stated plainly: government-funded seed research (SMART, ~2010) → an
industry consortium (Argonaut, 2014) matures and converges the standard over several
years of real implementation → the regulator references the now-mature, already-adopted
private-sector standard by name in a binding certification rule (2020).** Government did
not write the spec; it funded the seed, then ratified what industry converged on once
that convergence was proven in the market.

**Step 4 — phased enforcement dates:** 15 Dec 2021 real-world-testing plans due; 1 Apr
2022 first Conditions-of-Certification attestation; **31 Dec 2022** the FHIR v4 API
capability (g(10)) had to actually be live. (Confidence: medium-high — dates
consistently corroborated across ONC/HIMSS secondary summaries; raw Federal Register
preamble table not directly re-pulled due to a fetch-tool domain restriction this
session.)

**Step 5 — the enforcement lever that made it bite: "information blocking," not just
certification.** Certification alone only binds health IT *developers/vendors*. The
separate information-blocking prohibition (effective 5 Apr 2021, amended by the Dec 2023
HTI-1 rule) extends the forcing function to **providers and health information
exchanges/networks directly**:
- Health IT developers/HIEs/HINs: enforcement began 1 Sept 2023, penalties up to
  **$1,000,000 per violation** (stackable), plus potential loss of ONC certification —
  existential for a vendor, since certification gates customers' CMS incentive-program
  reporting.
- Healthcare providers: no monetary fine, but "disincentives" via CMS payment programs
  effective 1 July 2024 — loss of 3 quarters of the Medicare Promoting Interoperability
  market-basket increase for hospitals; a MIPS Promoting-Interoperability score of zero
  for clinicians (~25% of total MIPS composite score); reduced reimbursement for
  critical-access hospitals (101%→100% of costs).

(HHS OIG, https://oig.hhs.gov/reports/featured/information-blocking/, and the Federal
Register disincentives rule, both accessed 2026-07-06; confidence: high — dollar figures
and dates corroborated across HHS OIG, Federal Register, and multiple law-firm alerts.)

**Why this is the strongest precedent overall:** a three-stage forcing function —
(1) statute sets an outcome-based mandate without naming a technology; (2) a
pre-existing, federally-seeded-but-industry-matured open standard is available for the
regulator to ratify by reference at the right moment; (3) enforcement is two-pronged
(certification, upstream/vendor-facing/monetary+existential; information-blocking,
downstream/provider-facing/incentive-linked) so the mandate can't be satisfied on paper
while blocked in practice. This is structurally the opposite of GDPR Art. 20 (no named
standard, weak enforcement) and more robust than CFPB 1033 (single-agency rule,
vulnerable to APA/statutory-authority challenge — and, as shown above, that
vulnerability materialized).

### 6b. UK Open Banking — CMA Order → OBIE → Open Banking Standard

**The CMA Retail Banking Market Investigation Order 2017 does not itself specify a
technical standard — it mandates an institutional process.** Verbatim from Part 2,
Article 10 of the Order
(https://www.gov.uk/government/publications/retail-banking-market-investigation-order-2017/the-retail-banking-market-investigation-order-2017,
directly fetched, accessed 2026-07-06; confidence: high):

> "Providers shall... within 2 weeks of this Article coming into force set up an entity
> (the 'Implementation Entity') that will agree, consult upon, implement, maintain and
> make widely available, without charge open and common banking standards for: read
> only access to data... (the 'Read-only Data Standard'); and both read and write
> access... (the 'Read/Write Data Standard')... which has the features and elements
> necessary to enable Providers to comply with the requirements to provide access to
> accounts subject to this Part 2 of the Order under PSD2."

**Exact chronology (this resolves the "which came first" question):**

1. **9 Aug 2016** — CMA publishes its Retail Banking Market Investigation Final Report,
   concluding an "Open Banking" data-sharing remedy is needed — an abstract policy
   conclusion, no technical spec yet.
2. **Sept 2016** — the CMA9 (Barclays, HSBC, Lloyds, RBS/NatWest, Santander, Nationwide,
   Danske, Bank of Ireland, AIBG) **voluntarily incorporate Open Banking Ltd**, ahead of
   the formal Order — explicitly anticipated and accommodated by the Order's own text
   ("if not done in advance of the date of this Order..."). (Confidence: medium-high,
   consistent secondary sourcing.)
3. **Oct-Dec 2016** — OBIE drafts the technical standard **from scratch** (no
   pre-existing standard adopted); a first draft is published around year-end 2016.
   (Confidence: medium, secondary/insider retrospective sourcing.)
4. **2 Feb 2017** — the Order is formally made, retroactively/formally mandating the
   entity, its CMA9 funding obligation, an Implementation Trustee, and an agreed
   timetable.
5. **13 Jan 2018** — Read/Write API go-live deadline (Article 14), coinciding with UK
   transposition of PSD2 via the Payment Services Regulations 2017.

**Who proposed the standard to the regulator?** The Order's "Agreed Arrangements"
(funding/governance/composition of the Implementation Entity) were **proposed by the
banks themselves (the CMA9) and then formalized/mandated by the CMA** — the regulator
compelled the *creation* of a standard-setting process and funded it via the regulated
parties, but the technical standard itself was authored by the industry body the Order
created, not by the CMA.

**PSD2 vs. CMA — two tracks that converged, not one implementing the other.** PSD2 (EU,
maximum-harmonisation directive) gave third-party providers a legal right of access
EU-wide and set security/authentication floors via its RTS on Strong Customer
Authentication — but **did not mandate any specific API technology or format**, leaving
standardization to the market. The CMA Order is UK-specific and narrower (only the
CMA9) but **deeper**: it compelled those nine banks to collaboratively build *one*
common technical API — going beyond what PSD2 required. The Order's own text
subordinates its standards to PSD2 (they must not conflict with it) but PSD2 itself
never specified the technical shape. **Net: PSD2 = legal right + security floor,
non-prescriptive on format; CMA Order = UK-specific compulsion to build one common API,
which many EU banks/fintechs then informally converged toward even though PSD2 never
required it.** (Confidence: medium-high — the primary Order's subordination clause is
directly quoted/verbatim (high confidence); the "PSD2 non-prescriptive" characterization
is medium-high, sourced from industry-body commentary contemporaneous with the Order.)

**Enforcement mechanism beyond the Order itself:** FCA authorization of third-party
providers (AISPs/PISPs) under the Payment Services Regulations is technology-agnostic in
principle (PSD2/RTS don't name a standard) — but in practice, adherence to the
OBIE-authored Standard became the near-universal path to compliance because the CMA9
built their PSD2 "dedicated interfaces" to it. (Flagged explicitly as a synthesis
inference, not sourced to one primary document — medium confidence.)

**Current governance status — a material update most secondary sources still miss.**
JROC (the multi-regulator Joint Regulatory Oversight Committee — FCA, PSR, CMA, HM
Treasury) has been **wound down**. Per the FCA's own words (Feedback Statement FS25/4,
published 8 Aug 2025, updated 3 Dec 2025, directly fetched): *"The National Payments
Vision (NPV) named the FCA as the lead regulator to progress open banking. JROC has been
wound down."* The FCA states it **"no longer plan[s] to set up an interim entity"** —
the earlier JROC parent/subsidiary "Interim Entity" plan has been abandoned/superseded.
As of a Jan 2026 FCA letter to trade associations, the FCA is commissioning an
independent (KPMG-facilitated) assessment of industry proposals for who leads the
"Future Entity's" establishment, with legislation under DUAA expected in 2026 to grant
the FCA formal new rule-making powers. **Bottom line: governance is mid-transition as of
mid-2026 — Open Banking Limited (formerly OBIE) still runs day-to-day operations, but
no permanent successor governance body exists in final form yet.** Any claim that "JROC
governs Open Banking" is stale as of 2025-2026 primary sources. (https://www.fca.org.uk/publications/feedback-statements/fs25-4-design-future-entity-open-banking,
directly fetched, accessed 2026-07-06; confidence: high.)

### 6c. Cross-precedent synthesis — the shared shape

Both success precedents (SMART on FHIR, UK Open Banking) share a specific sequence that
is *not* "regulator writes spec, industry complies":

1. **Regulator mandates an outcome and/or an institutional process** ("API access
   without special effort" / "set up an Implementation Entity that will build open
   common standards") **without dictating the technical spec itself.**
2. **A standard is authored either by a pre-existing, gradually-maturing industry/
   academic effort (FHIR/Argonaut, ~4-6 years of prior work) or by a newly-mandated
   industry body working at speed under the regulator's clock (OBIE, ~4-5 months from
   entity formation to first draft).**
3. **The regulator then locks the standard in by reference** — either directly into a
   binding certification rule (ONC's 45 CFR 170.315(g)(10) naming FHIR R4 by exact
   version) or indirectly by making the mandated entity's standard the only practical
   path to a separate compliance obligation (OBIE's Standard as the de facto path to
   PSD2 dedicated-interface compliance).
4. **A second, independent enforcement lever reaches the parties the primary
   rule can't** — ONC's certification only binds vendors, so "information blocking"
   was added to bind providers directly via CMS payment incentives; the CMA Order only
   binds the CMA9, but FCA/PSD2 authorization requirements for third-party providers
   extend the practical reach to the whole ecosystem.

**DMA Article 6(9) and the EU Data Act, by contrast, are currently stuck at step 1** —
an outcome mandate exists, but no step-2 standard-authoring process has been triggered
by the regulator (DTI, the closest industry candidate, has explicitly declined to
converge on one), and no step-3 lock-in has occurred. This is exactly the open window
the report's hypothesis identifies.

---

## 7. Synthesis

### 7a. Ranked table of regulatory hooks by fit-to-PDPP and timeline

| Rank | Hook | Jurisdiction | Status (2026-07-06) | Standard exists? | Fit to PDPP shape | Timeline for action |
|---|---|---|---|---|---|---|
| 1 | **DMA Article 6(9)** | EU | Live since March 2024 compliance deadline; no enforcement action on 6(9) specifically to date | **No** — confirmed gap; DTI explicitly declined to converge on one | Excellent — literally requires continuous, real-time, free, third-party-authorized access | Open now; EC one-year-review consultation closed Sept 2025, outcome pending |
| 2 | **EU Data Act Art. 33-36 interoperability** | EU | Applies from 12 Sept 2025; CEN/CENELEC/ETSI mandate M/614 ~15% delivered | **No** (1 of 7 standards deliverables published; interoperability part due May 2027) | Strong — connected-product access + explicit interoperability essential-requirements track with a real standardization process already underway (unlike DMA, which has none) | 2026-2027 window while CEN/CENELEC drafts remaining deliverables |
| 3 | **US CFPB Section 1033 / FDX** | US | Enjoined by court order (Oct 2025), CFPB running a new rulemaking | Yes (FDX recognized), but the *rule itself* is stalled | Good technical fit (developer interface + recognized standard body) but currently a legally unstable hook | Watch, don't lead with — outcome of ANPR-driven revised rule unknown, could take 1+ year |
| 4 | **UK DUAA Smart Data (non-banking sectors)** | UK | Enabling framework live (June 2025); no non-banking sector schemes operational yet | No cross-sector standard by design; each sector may pick its own | Moderate — mechanism is proven (Open Banking) but DUAA explicitly fragments future sectors | Multi-year; earliest new sector schemes still in consultation/scoping as of mid-2026 |
| 5 | **Brazil Open Finance** | Brazil | Live, mature, expanding (credit portability to general public Feb 2026) | Yes — FAPI/OAuth2/OIDC, already standardized and governed | Excellent technical fit, but standard is already locked (adoption-by-reference target, not a green-field hook) | Already converged — engage as a reference implementation/interop partner, not a standard-setting opportunity |
| 6 | **GDPR Article 20** | EU | Static since 2018; Commission's own evaluation redirected fixes elsewhere | No, and Commission has effectively abandoned fixing it directly | Weak as an active hook (no live rulemaking), but useful as the "here's what NOT having a standard looks like" argument | N/A — background/context, not a target |
| — | **India DPDP Act** | India | Portability absent by design; Act still phasing in through May 2027 | N/A | None via the Act; the real hook is DEPA/Account Aggregator, but that's finance-sector-specific and already has its own (voluntary-participation) standard | N/A for the Act; DEPA is analogous to Brazil (already converged) |
| — | **Australia CDR** | Australia | Live, expanding to non-bank lending/BNPL (mid-2026), low consumer engagement (~0.3%) | Yes — CDR has its own standard (Data Standards Body) | Moderate — proven mandate mechanism but a cautionary tale on low real-world uptake despite heavy compliance spend | Watch as a usage-adoption cautionary case, not a standard-setting target |

**The hypothesis is confirmed: DMA Article 6(9) is the strongest hook**, precisely
because (a) the legal obligation is live and binding today, (b) it explicitly requires
the PDPP-shaped capability (continuous, real-time, free, third-party-authorized access —
not a one-shot export), and (c) — the decisive point — **no technical standard exists
and the one industry body positioned to build one (DTI) has explicitly declined to
converge on a single protocol**, instead pursuing a narrower trust/accreditation layer
play. That is a genuine, unfilled standard-setting vacancy, not a crowded field. The EU
Data Act's interoperability track (rank 2) is the second-best hook specifically because
it already has an official standardization process underway (CEN/CENELEC mandate M/614)
that PDPP could feed into — a lower-friction entry point than DMA 6(9), which currently
has no formal process at all to plug into.

### 7b. The concrete play for each top hook

**#1 — DMA Article 6(9):**
- **EC DG CONNECT** is the natural first contact — it runs DMA implementation and the
  one-year-review consultation process that DTI itself submitted to (Sept 2025). A
  PDPP-shaped submission to any future DMA review consultation, framed around "Article
  6(9) has no technical standard and DTI has explicitly said there should be none — here
  is a concrete, neutral, conformance-testable candidate," is the most direct path.
- **BEREC** appears to have no substantive role on 6(9) specifically (its DMA work is
  concentrated on Article 7 messaging interoperability) — deprioritize as a primary
  contact, but worth a direct confirmation before ruling it out entirely (this was a
  negative finding, harder to prove exhaustively than a positive one).
- **DTI (dtinit.org)** is not a gatekeeper to route through — it's a potential ally or
  competitor for the same standard-setting vacancy. DTI's own posture ("no silver
  bullet," pluralist) means it is unlikely to object to a competing standard proposal,
  but its "Data Trust Registry"/accreditation layer (piloted through April 2026, badge
  launched June 2026) is worth studying closely — if PDPP wants the *authorization/trust*
  layer (which is exactly its own thesis — OAuth-profile consent, field-level grants),
  DTI may already be building an adjacent or overlapping piece. Read DTI's LOLA
  (Live, On-Line Account Portability) spec inside the W3C Social Web Working Group
  (dtinit.org/blog/2026/05/26/...) — it's a directly relevant existing OAuth-scoped-
  grant design for portability that a PDPP standard proposal should either interoperate
  with or explicitly differentiate from.
- **Individual gatekeepers** (Google, Meta, Apple, Microsoft, Amazon, ByteDance) each
  already have working (if divergent) 6(9) APIs — a pragmatic near-term play is a
  connector/adapter layer normalizing across their existing APIs (which is closer to
  what PDPP already does for consumer-facing connectors) rather than waiting for a
  single standard to emerge, while separately pursuing the regulatory-standard-setting
  track for the long game.

**#2 — EU Data Act interoperability (Articles 33-36):**
- The live channel is the **CEN/CENELEC/ETSI standardization process under Mandate
  M/614** — this is a formal, open standards-development process (unlike DMA 6(9), which
  has none) that PDPP could seek to participate in or submit input to, especially since
  only 1 of 7 deliverables (terminology) is published and the interoperability-specific
  Part 3 isn't due until May 2027 — there's a real window before the standard locks in.
- The relevant EU-side contact is likely **DG CONNECT** again (Data Act policy owner)
  plus whichever CEN/CENELEC technical committee is running the M/614 work items —
  needs a follow-up search to identify the specific committee/working-group ID.
- Given the Data Act's explicit format language ("structured, commonly used, machine-
  readable... continuously and in real-time where technically feasible") is already
  closer to PDPP's own shape than DMA 6(9)'s vaguer text, this may be the more
  natural-fit hook for a formal standards submission, even though DMA 6(9) is the more
  urgent one.

**#3 (watch-only) — CFPB 1033/FDX:** don't lead with this — it's legally unstable. If
engaging at all, engage with **FDX** (the recognized standard-setting body) directly
rather than CFPB, since FDX's governance (open/transparent/consensus-based, per its
CFPB-recognition criteria) is the actual technical-standard locus regardless of the
rule's litigation status.

### 7c. What a "standard adopted by reference" path requires of PDPP

Both precedents converge on the same checklist for what a regulator needs before it will
name a standard in binding text (à la 45 CFR 170.315(g)(10) naming FHIR R4 by exact
version):

1. **Proven, working implementations before the ask** — FHIR had ~7 years of prior
   HL7/SMART/Argonaut work and multiple live EHR-vendor implementations before ONC
   named it; OBIE built and shipped a working standard before the CMA's Read/Write
   deadline. **A standard proposed cold, with no running implementations, does not get
   adopted by reference.** PDPP's own live deployment (multiple connectors, an actual
   read surface, actual grants) is the necessary evidence base — this needs to be
   documented as a track record, not just an architecture.
2. **A neutral, multi-stakeholder governance body**, not a single vendor's private spec.
   Argonaut explicitly brought in *competing* EHR vendors (Epic, Cerner, athenahealth,
   etc.) and *competing* provider systems; OBIE was funded and staffed by all nine CMA9
   banks jointly, under an independent Trustee. FDX's CFPB-recognition criteria
   explicitly required openness, transparency, balanced decision-making, consensus, and
   due-process/appeals — this is a checkable, articulated bar (CFPB's actual recognition
   order is the primary text to study for exactly what a US regulator asks for). **A
   protocol proposed and controlled by one company will not clear this bar** — PDPP
   would need a genuinely independent steering structure with multiple, ideally
   competing, implementers before a regulator would name it.
3. **A conformance-testing/certification mechanism.** FHIR/SMART on FHIR compliance is
   verified through ONC-Authorized Certification Bodies (ONC-ACBs) testing against the
   named criterion; Open Banking API compliance is verified through OBIE's own
   conformance suite; FDX has its own certification program. **A standard without a
   testable conformance suite is not adoptable by reference** — a regulator needs a way
   to know, mechanically, whether a given implementation actually complies. PDPP needs
   this built (or credibly plannable) before approaching any regulator.
4. **A version-pinning discipline.** ONC's rule names an *exact* FHIR version and
   technical-correction number, not "FHIR" in the abstract — regulators need to cite
   something stable and precisely versioned in binding text. PDPP's own spec needs
   formal versioning with the kind of precision a regulation can point to unambiguously.
5. **A second, independent enforcement lever beyond the primary rule** is what made both
   precedents actually bite in practice (ONC's information-blocking regime reaching
   providers beyond vendor certification; OBIE's Standard becoming the de facto PSD2
   compliance path for TPPs beyond the CMA9 itself). This isn't something PDPP builds
   directly, but it's worth identifying, for any jurisdiction being targeted, what the
   *second* lever might be (e.g., for DMA 6(9), is there an analog to
   "information blocking" that could reach parties beyond the seven designated
   gatekeepers?) — this is a genuinely open research question this pass did not resolve
   and would need a dedicated follow-up.

**Honest gap assessment:** this research did not find, in any jurisdiction, a clean
"industry proposes standard, regulator adopts by reference" story that happened faster
than several years (FHIR: ~2010-2020, a decade; OBIE: compressed to under 18 months,
but only because the CMA Order created a hard deadline and full bank-funding on day
one). **A standard-adoption path via regulatory reference should be treated as a
multi-year play, not a near-term one** — the near-term value of engaging with DMA 6(9)
or the Data Act processes now is establishing PDPP's position and track record early in
a still-open window, not expecting rapid formal adoption.

---

## Sources index (representative, not exhaustive — see inline citations throughout for full list)

- Google Data Portability API documentation — https://developers.google.com/data-portability (accessed 2026-06-11, prior corpus entry; re-confirmed relevant 2026-07-06)
- Digital Markets Act gatekeepers portal — https://digital-markets-act.ec.europa.eu/gatekeepers-portal_en (accessed 2026-07-06)
- SCiDA Project, "DMA Compliance Reports in Year Three" — https://scidaproject.com/2026/04/02/dma-compliance-reports-in-year-three-reading-between-the-many-lines/ (accessed 2026-07-06)
- Data Transfer Initiative blog — https://dtinit.org/blog/ (multiple posts, 2024-2026, accessed 2026-07-06)
- European Commission, Data Act policy page — https://digital-strategy.ec.europa.eu/en/policies/data-act (accessed 2026-07-06)
- GDPR Article 20 — https://gdpr-info.eu/art-20-gdpr/ (accessed 2026-07-06)
- EDPB WP242 rev.01 — https://www.edpb.europa.eu/our-work-tools/our-documents/guidelines/guidelines-right-data-portability-under-regulation-2016679_en (accessed 2026-07-06)
- European Commission COM(2020) 264 final — https://www.europarl.europa.eu/RegData/docs_autres_institutions/commission_europeenne/com/2020/0264/COM_COM(2020)0264_EN.pdf (accessed 2026-07-06)
- CFPB, 12 CFR Part 1033 — https://www.consumerfinance.gov/rules-policy/regulations/1033/ (accessed 2026-07-06)
- CFPB FDX recognition order — https://files.consumerfinance.gov/f/documents/cfpb_standard-setter-decision-and-order-of-recognition-fdx_2025-01.pdf (accessed 2026-07-06)
- Bank Policy Institute, Section 1033 litigation tracker — https://bpi.com/section1033/ (accessed 2026-07-06)
- CFPB ANPR, Federal Register — https://www.federalregister.gov/documents/2025/08/22/2025-16139/personal-financial-data-rights-reconsideration (accessed 2026-07-06)
- ONC Interoperability Standards Platform, 45 CFR 170.315(g)(10) — https://www.healthit.gov/isp/svap-reference-standard/ss-170315g10-standardized-api-patient-and-population-services (accessed 2026-07-06)
- JAMIA, "SMART on FHIR" — https://academic.oup.com/jamia/article/23/5/899/2379865 (accessed 2026-07-06)
- HealthcareITNews, Argonaut Project — https://www.healthcareitnews.com/news/argonaut-project-building-success-fhir-implementation-guide (accessed 2026-07-06)
- HHS OIG, information blocking — https://oig.hhs.gov/reports/featured/information-blocking/ (accessed 2026-07-06)
- CMA Retail Banking Market Investigation Order 2017 — https://www.gov.uk/government/publications/retail-banking-market-investigation-order-2017/the-retail-banking-market-investigation-order-2017 (accessed 2026-07-06)
- FCA Feedback Statement FS25/4 — https://www.fca.org.uk/publications/feedback-statements/fs25-4-design-future-entity-open-banking (accessed 2026-07-06)
- legislation.gov.uk, Data (Use and Access) Act 2025 — https://www.legislation.gov.uk/ukpga/2025/18/contents/enacted (accessed 2026-07-06)
- PIB India, Account Aggregator ecosystem — https://www.pib.gov.in/PressReleasePage.aspx?PRID=2162953&reg=48&lang=2 (accessed 2026-07-06)
- PRS Legislative Research, DPDP Bill 2023 — https://prsindia.org/billtrack/digital-personal-data-protection-bill-2023 (accessed 2026-07-06)
- ANPD (Brazil) regulations index — https://www.gov.br/anpd/pt-br/acesso-a-informacao/institucional/atos-normativos/regulamentacoes_anpd (accessed 2026-07-06)
- Open Finance Brasil developer wiki — https://openfinancebrasil.atlassian.net/wiki/spaces/OF/pages/240649123 (accessed 2026-07-06)
- Australian Banking Association, CDR Strategic Review — https://www.ausbanking.org.au/wp-content/uploads/2024/07/CDR-Strategic-Review_July-2024.pdf (accessed 2026-07-06)

## Confidence and follow-up flags (consolidated)

- **EUR-Lex, federalregister.gov, meity.gov.in, bcb.gov.br, planalto.gov.br** were
  unreachable or fetch-blocked across all four research passes this session. Every
  claim sourced only to a secondary mirror of these primary texts is flagged inline
  above; before this report is used in any external-facing or legally load-bearing
  context, re-verify the highest-stakes claims (exact DMA 6(9) statutory wording, Data
  Act article numbering, LGPD Art. 18/40 text, DPDP Act Chapter III text) directly
  against the primary source.
- **Da Vinci Project's specific role in 45 CFR 170.315(g)(10)** could not be confirmed
  in this pass — flagged as an open question; Da Vinci is more likely relevant to CMS's
  separate 2020 Interoperability and Patient Access rule than to ONC's Cures Act rule.
- **The "second enforcement lever" for DMA Article 6(9)** (an information-blocking
  analog reaching beyond the seven designated gatekeepers) is a genuinely open question
  this research did not resolve and is a natural next research task if PDPP pursues the
  #1-ranked hook.
- **Litigation status (CFPB 1033) and EU guidance (DMA/Data Act) are moving targets** —
  every date-stamped claim in this report is accurate as of 2026-07-06 and should be
  re-verified before being relied upon in any later planning cycle.
