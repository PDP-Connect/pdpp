# Attribution Split Prior Art

Research question: has any standards body, academic project, or commercial vendor tried to specify a consent surface where the *protocol itself* — not just the UI — distinguishes platform-enforced claims from client-committed claims, with formal attribution to the party making each statement?

Short answer: **the idea has been attempted in pieces for twenty-five years, and one current effort (EUDI ARF + HAIP + OID4VP verifier_info) is converging on something architecturally similar to PDPP's attribution split — but no prior art makes the specific move PDPP makes, which is to mandate at the protocol level that consent surfaces render client-authored claims with explicit attribution ("[client name] says") and that manifest-authored descriptions be visually distinguishable from client-authored ones.** Every prior effort either (a) kept the split in the data model but left UI presentation as implementer discretion, (b) enforced verified identity attributes but never extended the split to data-handling commitments, or (c) became a self-declaration regime with no attribution at all. The failure modes are instructive and the opportunity is real, but PDPP is closer to "last mile of a crowded road" than to "undiscovered country." See the synthesis at the end.

---

## 1. Kantara Consent Receipt / ISO/IEC TS 27560:2023

**What was tried.** A JSON / JSON-LD data structure that records the fact that a data subject consented, including: who the PII controller is, the purposes consented to, the categories of PII, the legal basis, retention, and who receives the data. The specification was designed so a data subject could receive a machine-readable artifact after giving consent and later use it to prove, revoke, or audit the consent grant.

**Who tried it.** Kantara Initiative's Consent & Information Sharing Working Group (CISWG, ~2013–2018), led by people including Mark Lizar and John Wunderlich. Became ISO/IEC TS 27560:2023. DPV provides an RDF implementation profile (`dpv-27560`). Kantara's successor work is the ANCR (Anchored Notice and Consent Receipts) Working Group.

**When.** CR v1.0 in 2017, v1.1 in 2018, ISO/IEC TS 27560 published 2023. Still current but adoption is concentrated in regulated sectors and academic implementations; very little consumer-facing deployment.

**How close to PDPP.** Not close on the attribution split specifically. The receipt structure has `piiController`, `services[]`, `purposes[]`, `retentionPeriod`, `thirdPartyDisclosure` — all of these are *claims by the controller about themselves*, rendered with no formal distinction from any other field. There is no notion that `retentionPeriod` is a promise while `expiry` (if present) is enforced. Kantara CR treats the entire record as a testimonial artifact authored by the controller, notarized by the data subject's act of consent. It has optional Dublin Core `dct:creator` / `dct:publisher` / `dct:provenance` fields that could in principle be used for provenance, but these are not used to mark individual claims with per-field attribution, and the spec explicitly says "security, communication, and maintenance of this information is outside the scope of this document."

**Why it didn't get widely adopted.** Three reasons I can substantiate from primary sources:

1. **No enforcement hook.** A consent receipt is a receipt, not a gate. Issuing one doesn't constrain the controller's subsequent behavior. It's useful for compliance demonstration and for user-side portability but doesn't change any runtime data flow.
2. **DPV captured the semantic layer.** DPVCG's later work on DPV (Data Privacy Vocabulary) effectively became the machine-readable semantic layer that CR needed, but DPV is a vocabulary, not a protocol — so the hand-off between the vocabulary and any actual enforcement/presentation mechanism was never specified.
3. **It solved the wrong audience's problem.** The primary consumer of a Kantara CR is a DPO or auditor, not an end user mid-flow. Nothing in the spec tells an OAuth server how to surface the receipt at consent time or how to render it comprehensibly to a human, so implementers built what they wanted and the UX converged back on the same undifferentiated block of text PDPP is trying to fix.

## 2. W3C Data Privacy Vocabulary (DPV)

**What was tried.** A formal RDF vocabulary for consent, personal-data processing, legal bases, purposes, rights, technical and organizational measures, processing contexts, and consent lifecycle states. Extensions for EU-GDPR and ISO/IEC 27560. Intended to make privacy policies, consent records, and data-processing records machine-readable and interoperable.

**Who tried it.** W3C Data Privacy Vocabularies and Controls Community Group (DPVCG). Key contributors: Harshvardhan Pandit, Axel Polleres, Sabrina Kirrane, Rigo Wenning, Bert Bos, others.

**When.** 2018–present. DPV 1.0 in 2022, DPV 2.0 in late 2024. Active.

**How close to PDPP.** Close on vocabulary, not on the attribution split. DPV has a rich `ConsentStatus` hierarchy (`ConsentGiven`, `ConsentWithdrawn`, etc.) that captures operational state, and it models obligations (`TechnicalOrganisationalMeasure`, `RetentionPeriod`, `PurposeSpecification`) as RDF concepts. But there is no type that says "this is enforced by the platform" versus "this is a commitment by the controller." DPV is descriptive — a shared language for saying what a policy claims — not prescriptive about who said it or whether it is mechanically backed. The DPVCG has discussed provenance and attribution in issue threads but no attribution-source primitive exists in the core vocabulary.

**Why it didn't get widely adopted at the consent-surface level.** DPV is alive and reasonably successful as a vocabulary (EU semantic-web / regulator / academic communities), but it hasn't driven any consent UI change because it has no normative guidance on presentation. It is agnostic by design: the community took the position that UI rendering is a deployment concern outside their scope. That's a common and defensible W3C-CG stance but it means DPV never forces the attribution question into implementations.

## 3. W3C Verifiable Credentials

**What was tried.** A data model where claims about a subject are bundled into a cryptographically signed credential with an explicit `issuer`. Verifiers can mechanically prove that a given claim was asserted by a given issuer and has not been tampered with. The holder controls presentation via Verifiable Presentations, which can be selectively disclosed.

**Who tried it.** W3C Verifiable Credentials Working Group. Key people: Manu Sporny, Dave Longley, Drummond Reed, Daniel Hardman, many others.

**When.** VC 1.0 in 2019, VC 2.0 in 2025. Active and widely cited.

**How close to PDPP.** The *mechanism* of per-claim issuer attribution is exactly right and is the closest structural analogue to PDPP's "[client name] says" split. Cryptographically, VC proves provenance of every claim. **But** VC has only ever been applied to claims *about the subject* (identity attributes, credentials, degrees, licenses), never to claims *about the verifier's own data handling* (how the receiving party promises to treat data post-receipt). VC has no standard credential type for "we will delete this in 30 days" because the verifier in a VC exchange is the recipient of claims, not the subject of them. Nothing in the data model prevents a self-issued credential where the verifier attests to its own data practices, but as of 2026 no such credential type has been standardized, and no wallet UI renders such things as "client says" alongside platform-verified issuer claims. This is arguably a missed opportunity rather than a dead end.

**Why it didn't extend to data-handling commitments.** VC's design center is "issuer asserts claim about subject." Inverting that ("subject attests about how they will handle data they are about to receive") cuts across the trust model and nobody has championed it. The closest is a patent application (US 20230032782) that uses VCs for retailer consent processing, but the commitment is encoded as the scope of what can be disclosed, not as independent data-handling promises.

## 4. Solid Project (the owner Berners-Lee)

**What was tried.** A decentralized data-storage protocol where users store data in personal "pods" and grant applications scoped access via Web Access Control (WAC) and later Access Control Policy (ACP). Later research layers (Debackere et al. 2022, Esteves et al. 2023) proposed grafting ODRL / SPECIAL / DPV policy languages on top to express purpose, legal basis, and retention declaratively.

**Who tried it.** Core Solid team at MIT/Inrupt. Policy-layer research primarily from IDLab Ghent (Debackere, Verborgh, Van de Wynckel) and ADAPT Centre Dublin (Esteves, Pandit).

**When.** Solid protocol 0.9 ~2018, policy research concentrated 2020–2024. Active but niche.

**How close to PDPP.** This is the prior art that most explicitly *names* the gap PDPP addresses. Multiple Solid papers explicitly identify that WAC/ACP are low-level access-control mechanisms that cannot express higher-level regulatory concepts like purpose of processing and retention, and that these higher-level concepts are promises a client makes which Solid cannot enforce. Debackere et al. (CONSENT '22) proposed an architecture that binds technical access control rules to higher-level concepts "such as the legal basis and purpose for data processing." **But** the research stopped at data modeling and policy evaluation; no proposal mandated that the consent-granting UI render client-declared purpose separately from pod-enforced access control with formal attribution. The distinction lives in the papers' analysis, not in a normative protocol requirement.

**Why it didn't get widely adopted.** Solid itself has limited deployment, and its policy-layer research never became part of the core protocol. The research community acknowledged (per the 2023 arXiv paper "Assessing the Solid Protocol in Relation to Security & Privacy Obligations") that full GDPR compliance requires components Solid doesn't specify. The attribution distinction is present conceptually in the literature but hasn't been normatively written into any protocol.

## 5. OpenID Connect for Identity Assurance (OIDC IDA / eKYC-IDA)

**What was tried.** A dedicated `verified_claims` container in the ID Token / UserInfo response that wraps identity claims together with verification metadata (trust framework, evidence type, verification date, verifying authority). The explicit design goal, quoted from the spec: *"This way, it is explicit which claims are verified, reducing the risk of RPs accidentally processing unverified claims as verified claims."*

**Who tried it.** OpenID Foundation eKYC and Identity Assurance Working Group. Final in 2023.

**When.** Draft work began ~2019, final in 2023. Active, deployed in several European eKYC contexts.

**How close to PDPP.** Architecturally the closest hit on the "don't mix verified and unverified" design principle. The `verified_claims` container is *exactly* the move PDPP wants to make, at least at the data layer: claims that can be backed up are separated from claims that cannot, and the receiving party can mechanically tell which is which. **But** the scope is strictly identity attribute verification — the claims inside `verified_claims` are things like "the OP verified this user's name against a passport under eIDAS." It is unidirectional: OP asserts things about the user. It does not model the inverse PDPP cares about, where the *RP* is making claims about itself (its own data handling) that the platform cannot verify. And critically, the IDA spec does not mandate how the RP's consent screen must render the distinction. The spec is about the wire format between OP and RP, not about what the RP shows the user. Presentation is left to the implementer.

**Why it didn't extend to what PDPP needs.** The spec is scoped — deliberately and reasonably — to identity attribute assurance. Extending it to "RP self-declared data-handling commitments" would be a different specification with a different working group charter. Nobody has written that spec. This is the strongest "this is prior art for a neighboring problem" finding in the research.

## 6. IAB Europe Transparency & Consent Framework (TCF)

**What was tried.** A protocol and data format (the "Consent String" / "TC String") that encodes which vendors on a Global Vendor List (GVL) the user has consented to, for which of a small set of IAB-defined purposes, under which legal basis (consent or legitimate interest). CMPs display notices to users; vendors read the TC String and are contractually bound to honor it. TCF v2.3 (2025) adds a mandatory "Disclosed Vendors" segment to address ambiguity about which vendors were actually shown to the user.

**Who tried it.** IAB Europe, IAB Tech Lab.

**When.** TCF v1.0 in 2018, v2.0 in 2020, v2.2 in 2023, v2.3 in 2025. Active, with hundreds of vendors in the GVL.

**How close to PDPP.** This is the closest *deployed* system with per-claim-source attribution at scale. The TCF actually does distinguish vendor-declared information from framework-enforced information: a vendor declares which purposes it uses on the GVL, the CMP shows those purpose-vendor pairings to the user, and the TC String is the enforcement handle that downstream vendors must read. Purpose text comes from the IAB framework (common across vendors), vendor names and privacy policy links come from the vendor itself. There is a structural distinction.

**But** the TCF does not mandate an attribution UX. It publishes policies vendors must follow and it publishes CMP certification requirements, but the rendering of "[vendor name] says it uses data for X" versus "the framework defines X" is not mandated; it's left to CMPs and has famously been used for dark patterns (the Belgian DPA's 2022 decision against IAB Europe specifically criticized how ambiguous the distinction became in practice). And the TCF is narrowly scoped to ad-tech purposes — it has no model for per-vendor data handling promises beyond the IAB-defined purpose list.

**Why its attribution signal degraded.** Three reasons documented in the GDPR enforcement record against IAB Europe (Belgian DPA 2022, upheld with modifications 2023):

1. Vendor self-declarations on the GVL are not audited. A vendor can say "I use purpose 2 under legitimate interest" and the TCF has no mechanism to contest it at runtime.
2. CMPs are optimized for click-through, not for comprehension. Even when the data model distinguishes sources, the UI collapses them.
3. The "legitimate interest" legal basis created a second surface where vendors could process data without consent, and the TCF's encoding of this was found to be misleading to users.

The TCF story is the cautionary tale for PDPP: having the data distinction is necessary but not sufficient. Without mandatory normative UI rendering and audit of client claims, the attribution signal is eroded by the entity most incentivized to erode it.

## 7. P3P and EPAL (the grandparents)

**What was tried.** P3P (Platform for Privacy Preferences, W3C Recommendation 2002) let websites publish a machine-readable privacy policy as XML. Browsers could read it and compare it to user preferences. EPAL (Enterprise Privacy Authorization Language, IBM 2003) was designed as the *enforcement* counterpart: where P3P was the external promise, EPAL was the internal access-control policy that was supposed to back the promise up. Barth & Mitchell (Stanford, WITS '05) formalized the relationship — they defined an "enforces" relation between a detailed EPAL/DPAL enforcement policy and a coarser P3P promise, and gave an algorithm for deriving the most-restrictive P3P policy an enterprise could honestly publish given its EPAL rules.

**Who tried it.** W3C P3P Working Group (1997–2006). IBM's privacy research group (Günter Karjoth, Matthias Schunter, Els Van Herreweghen) for EPAL and E-P3P. Adam Barth and John C. Mitchell at Stanford for the formal model.

**When.** P3P Rec in 2002, obsoleted by W3C in 2018. EPAL submitted to W3C in 2003, never standardized. Barth-Mitchell paper 2005.

**How close to PDPP.** This is the direct conceptual ancestor. Barth & Mitchell's model is the cleanest formalization I can find of the exact split PDPP is making: P3P is the promise, EPAL is the enforcement, and the paper's contribution is a formal relationship connecting them. The difference is that Barth-Mitchell kept the two layers separate — the user saw the P3P promise, the enterprise ran EPAL internally, and the formal model was a tool for the enterprise to verify it was honest. There is no user-facing artifact that distinguishes "this is enforced" from "this is promised." PDPP is proposing to collapse that boundary into the consent surface itself.

**Why it died.** Lorrie Cranor's 2012 obituary "P3P is dead, long live P3P!" is the primary source. The short version:

1. **No enforcement.** P3P was voluntary. Major sites including Google deliberately posted fake P3P policies (Google's said literally "This is not a P3P policy") because IE used P3P for cookie-blocking decisions and a compliant-looking string bypassed the block. The FTC never enforced against deceptive P3P policies. Cranor's verdict: "Until we see enforcement actions to back up voluntary privacy standards... users will not be able to rely on them."
2. **No incentives for adoption.** Only IE implemented P3P seriously. No regulator required it. Firefox and Chrome never supported it.
3. **Complexity.** The XML vocabulary was dense, compact policies were unreadable, and CMPs (the modern equivalent of P3P user agents) didn't exist yet.
4. **EPAL wasn't standardized.** W3C declined to pursue it. Without the enforcement counterpart, P3P was just a promise with a schema.

This is the failure mode most directly relevant to PDPP. The attribution split without enforcement, incentives, and normatively mandated UI rendering collapses into theater.

## 8. Apple Privacy Nutrition Labels / Privacy Manifests

**What was tried.** Apple's 2020 App Store "Privacy Nutrition Labels" require developers to self-declare what data their app collects and for what purposes, rendered as a standardized block on the app's store page. In 2023 Apple added "Privacy Manifests" (`PrivacyInfo.xcprivacy`), a machine-readable file that ships with the app and transitively with any third-party SDK, declaring data collection and "required reason API" usage. Google Play's "Data Safety" section (2022) is a parallel self-declaration regime.

**Who tried it.** Apple, Google.

**When.** Labels 2020, Manifests 2023/2024. Active.

**How close to PDPP.** Design-wise very close — the Apple store literally renders a structured list of developer-declared claims next to platform-verified metadata (app name, signing cert, store review status), and the store UI is a standardized rendering that the developer cannot control. This is attribution-split-by-UI. It's not a protocol specification in the IETF sense, but App Store Connect is effectively a protocol between developer and platform, and the rendering is normatively fixed. **But**, crucially, the labels are pure self-declaration: Apple does not audit them, and the Washington Post's 2021 investigation (which triggered a Congressional inquiry) found that a third of apps with "Data Not Collected" labels were in fact collecting data. Apple's enforcement response: "apps that fail to disclose privacy information accurately may have future app updates rejected." That's an accountability mechanism, not a runtime enforcement mechanism.

**Why it's an imperfect model for PDPP.** The labels *are* attributed to the developer — the store UI is clear that the developer provided the information — and they are consistently rendered. This is the one prior art where the attribution split is actually visible in a mass-market UI. But it demonstrates the failure mode of self-declaration without audit: accuracy collapses, regulators notice, trust in the label erodes, and the platform has to add downstream mechanisms (privacy manifests, required-reason-API declarations, SDK signatures) to shore it up. The lesson for PDPP: if you make client-attributed claims render distinctly, you have to decide in advance what happens when the client lies, or the signal will degrade.

## 9. Data Transfer Initiative (DTI) and the Data Trust Registry

**What was tried.** A nonprofit successor to the Data Transfer Project (Apple / Google / Meta, 2018) that operates a "Data Trust Registry" vetting third-party recipients of user-initiated data transfers. Trust Level 1 requires provision of organizational identity, a privacy policy, and a self-attestation of data security practices; Trust Level 2 adds an outside audit and deeper vetting of "whether consent mechanisms meaningfully reflect what the company will do with the data."

**Who tried it.** Data Transfer Initiative (2023–), incorporating work from the Data Transfer Project.

**When.** Trust Registry pilot 2024–2025. Active, early-stage.

**How close to PDPP.** DTI identifies the same problem — that user-initiated transfers to third parties require trust that the recipient will honor its claims — and tries to solve it by out-of-band vetting rather than by in-band protocol attribution. There is no DTI specification that mandates a consent-screen attribution split; the trust mark is a registry lookup, not a protocol field. DTI is arguably the adjacent work most likely to become relevant to PDPP over time, but today the overlap is thematic not structural.

**Why it's not widespread yet.** Too new, and the trust-mark approach has the same adoption curve problem as Kantara: it's useful for compliance but it doesn't change the runtime UX.

## 10. CFPB Section 1033 (Personal Financial Data Rights)

**What was tried.** A US rule (finalized October 2024) requiring data providers (banks) to make consumer data available to authorized third parties, with mandatory requirements on how third parties must obtain express informed consent, limit use and retention to what is "reasonably necessary," make revocation easy, and certify in the authorization disclosure that they agree to these obligations.

**Who tried it.** CFPB under Rohit Chopra.

**When.** Finalized October 2024, stayed pending litigation 2025, in reconsideration as of August 2025, compliance dates pushed. Status: legal limbo.

**How close to PDPP.** Regulatory, not protocol. The rule mandates *what* a third party must promise (purpose limitation, retention limits, deletion on revocation) and requires the third party to "certify" this in the authorization disclosure, but it does not specify a machine-readable protocol for attributing these claims nor require a particular consent-UI rendering. The rule is a floor on the promises; the UI rendering is left to the third party. The attribution split exists implicitly — the rule distinguishes what the data provider enforces (authentication, access, tokens) from what the third party promises (use, retention, no sale) — but no protocol artifact carries the distinction.

**Why it stalled.** The rule is currently under political/legal siege (CFPB itself now arguing it exceeds its statutory authority). Even if it survives, it is a regulatory overlay, not a protocol.

## 11. IETF GNAP and OAuth working-group traffic

**What was tried.** GNAP (RFC 9635, October 2024) is the most recent formal attempt to re-design grant negotiation with explicit accommodation of verifiable claims and client attestation. It allows a client to present unverified identifiers *and* verifiable assertions to the AS, and to exchange identity claims from OIDC, SAML, or W3C VCs.

**Who tried it.** IETF GNAP Working Group. Authors include Justin Richer, Fabien Imbault, others.

**When.** 2019–2024. RFC published October 2024, WG closed.

**How close to PDPP.** GNAP models the infrastructure for distinguishing attested from self-asserted information at the request level, but it does this for authentication, not for data-handling commitments. The protocol has no concept of "this client's retention promise" as a distinct class of claim. It's a general-purpose authorization grant protocol; the attribution question never surfaced as a design driver in WG traffic I could find. Searching the mailing list archives for terms like "client claims attestation data handling" returned no hits on the protocol-mandating-attribution framing PDPP uses.

**Why the attribution question didn't come up.** The working group's charter was explicitly about generalizing OAuth 2.0 delegation, not about rethinking consent UX. The human-facing surface was treated the same way OAuth 2.0 treats it: as out-of-scope.

## 12. EUDI ARF + HAIP 1.0 + OpenID4VP `verifier_info` (THE closest current work)

**What was tried.** The EU Digital Identity Wallet Architecture and Reference Framework (ARF) defines a two-certificate model for Relying Parties that request attributes from wallets:

- A **Relying Party Access Certificate (RPAC)** authenticates *who* the RP is, chained to a trust list of authorized RPs.
- A **Relying Party Registration Certificate (RPRC)** specifies *what* data that authenticated RP is entitled to request, and for which **registered intended use / purpose**.

The wallet must authenticate the RP, verify that the RP's request is within its registered intended use, and **abort the presentation if the request exceeds the declared intended use**. The German EUDI Blueprint documents this explicitly: "The EUDI Wallet ensures that RP presentation requests align with their declared intended use... EUDIW fails the process if the request exceeds the declared intended use."

HAIP 1.0 (High Assurance Interoperability Profile) layers on top of OpenID4VP to mandate signed authorization requests with X.509 chains, trust-list lookup, and — most importantly for PDPP — that wallets **display the RP's registered name from the Trust List, not the self-declared `client_name` from the request**. In production EUDI deployments the wallet is forbidden from showing the attacker-controlled client-metadata name when a trust-list-verified name is available.

OpenID4VP 1.0 also introduces a `verifier_info` parameter: "a non-empty array of attestations about the Verifier relevant to the Credential Request" intended to "support authorization decisions, inform Wallet policy enforcement, or enrich the End-User consent dialog." The explicit framing is that these attestations come from a trusted third party (e.g. a registrar) and are separate from whatever the verifier says about itself.

**Who.** European Commission (DG CNECT), the EUDI Wallet Consortium, the OpenID Foundation, various national implementation bodies (German BSI/BMI Blueprint, Spanish EUDI pilot, etc.). Key contributors include Torsten Lodderstedt (sphereon/yes.com), Kristina Yasuda, Oliver Terbu.

**When.** ARF drafts 2022–, ARF 2.4.0 in 2025, HAIP 1.0 in 2025, OID4VP 1.0 final in 2025. Active, with production mandates tied to eIDAS 2.0 compliance deadlines.

**How close to PDPP.** This is the closest extant work. It does three things PDPP does:

1. **Structurally separates attested-from-third-party information (the trust list) from self-declared information (the client metadata) in the protocol itself.**
2. **Mandates which one the wallet UI shows when they conflict** (trust-list name wins; self-declared name is suppressed).
3. **Binds declared purpose / intended use to an authorizing certificate** so that a client who exceeds its declared purpose has its request aborted by the wallet — that is, the platform mechanically enforces the boundary of what the client claimed it needed the data for.

**But** it is not identical to PDPP:

- The attested side is a third party (the registrar / trust list / Access Certificate Authority), not "the protocol spec itself." PDPP's claim that the manifest is authored by the protocol is a lighter-weight version of the same architectural pattern, but without the CA infrastructure.
- The EU framework does not (as of 2026 Q2) define a generic "client data-handling commitment" slot. The registered purpose is about *which attributes the RP can request*, not about *what the RP promises to do with them after receipt*. Retention, no-resale, deletion-on-revocation — these are not in the RPRC. They are handled at the regulatory layer (GDPR) and at the audit layer (RP registration), not at the wallet protocol layer.
- HAIP mandates trust-list name display but does not mandate a broader attribution split. The rest of the consent dialog — purpose text, data categories — is still rendered however the wallet chooses.

**Why it might get adopted (or fail).** EUDI has two things previous efforts didn't: a legal mandate (eIDAS 2.0), and a funded ecosystem with compliance deadlines. If it succeeds, it will be the first large-scale deployment of protocol-level attribution of RP identity and purpose. The risks are the usual: complexity of CA infrastructure, national fragmentation, and the historical pattern of wallet vendors collapsing structured data into undifferentiated UI for conversion. The verifier_info array in OID4VP is *explicitly* discretionary ("it is at the discretion of the Wallet whether it uses the information from verifier_info"), which is already a concerning hedge — the same hedge that let TCF CMPs collapse attribution into dark patterns.

## 13. Academic HCI / SOUPS / CHI literature

**What was tried.** I searched for usable-security research specifically on consent UI attribution ("who says" framing, source-of-claim trust signals) across SOUPS, CHI, USEC, and PETS proceedings. The established literature is dense on *consent dialog design*, *dark patterns*, *comprehension failures*, and *privacy nutrition label readability* (Kelley et al., Schaub et al., the AppCensus / Reyes et al. audits). There is also sustained work on *contextual integrity* (Nissenbaum, Barth-Datta-Mitchell-Nissenbaum 2006) and on *privacy policy machine-readability* in general.

What I could not find is a specific research thread that frames the problem as "consent surfaces should render client-authored vs platform-authored claims with formal attribution, and this should be a protocol-level requirement rather than an implementer choice." The Kelley et al. nutrition label work comes closest in spirit but is a UI proposal, not a protocol proposal. The closest academic analysis of the split itself is the Barth-Mitchell 2005 paper already covered.

**Interpretation.** There is a large and rigorous literature on consent UX, dark patterns, and machine-readable policies. Within that literature, the attribution-split framing PDPP uses does not appear to have been named or formally proposed as a design principle to be standardized. Researchers have identified every piece of the problem — the gap between promises and enforcement, the dark-pattern erosion of consent signals, the readability failures of nutrition labels, the difficulty of verifying retention promises — but I could not find a paper that says "the protocol should mandate that UIs attribute these separately." The Kantara ANCR ("Anchored Notice and Consent Receipts") work is the closest, and "anchored" is suggestive, but ANCR anchors the notice, not the attribution of individual claims within it.

---

## Synthesis

### 1. Is PDPP's attribution split genuinely novel, or has it been done?

**It is a novel synthesis of pieces that already exist, not a genuinely novel primitive.** Every ingredient is prior art:

- OpenID IDA has `verified_claims` as a dedicated container to prevent confusion between verified and unverified claims.
- W3C Verifiable Credentials has cryptographic issuer attribution per claim.
- HAIP 1.0 mandates that the wallet display trust-list-verified names *instead of* self-declared client metadata.
- EUDI ARF binds declared purpose to an authorizing certificate and mechanically enforces the boundary.
- IAB TCF has vendor-attributed purpose declarations in a deployed ecosystem.
- Apple Privacy Nutrition Labels render a consistent, platform-controlled UI with explicit developer attribution for self-declared claims.
- Barth & Mitchell (2005) formalized the enforces-relation between a policy promise and an enforcement policy.

What I did not find in any prior art is the specific PDPP move: **a protocol specification that normatively mandates how consent surfaces must render client-authored claims with explicit "[client] says" attribution, visually distinguished from manifest-authored descriptions, as a spec-level requirement.** IDA left UI presentation to implementers. HAIP mandates only RP identity display, not the full attribution split. Apple mandates UI rendering but the platform is proprietary, not a protocol. EUDI's verifier_info is explicitly discretionary. TCF declined to normatively mandate presentation of the source distinction and its absence is the single most-cited cause of the framework's GDPR troubles.

So: PDPP's attribution split is not protocol-novel in its data model (IDA, VC, HAIP, ARF cover that); it *is* novel in saying the protocol must mandate its *presentation* in the consent surface. Whether that specific delta is big enough to matter is a judgment call. I think it is — every prior effort that left presentation to implementers saw the signal erode — but it is a delta, not a category.

### 2. If it's been done and didn't catch on, what failure mode is most likely to repeat for PDPP?

Ranked by historical frequency and relevance:

1. **Voluntary rendering + dark-pattern erosion.** This is the P3P / TCF pattern. A standard defines a structured split in the data model; implementers are allowed latitude in rendering; conversion-optimized CMPs collapse the distinction; regulators complain; the signal becomes useless. Mitigation: PDPP must be normative, not advisory, about how the attribution split is rendered, and must include a conformance test or at least a reference rendering that is hard to quietly subvert. "SHOULD display" has a 25-year track record of becoming "pretend to display."
2. **Self-declaration without audit.** This is the Apple Privacy Nutrition Labels pattern. A consistent render of attributed client claims degrades into theater if clients can lie costlessly. The Washington Post investigation took about 18 months to produce a congressional inquiry; PDPP has to decide in advance what the audit / consequence mechanism is for false client claims, and ideally ship with at least one real consequence (revocation, registry removal, delisting).
3. **Layered-above-OAuth adoption curve.** This is the Kantara CR and DPV pattern. Getting a new consent-layer mechanism adopted requires convincing AS / IdP operators to render new UI elements, convincing clients to author new metadata, and convincing users that the new distinction is meaningful. Without a regulatory forcing function or a dominant-platform forcing function (Apple), these adoption curves are very long. The single most adoption-shaping question for PDPP is: *who, if anyone, is forced to implement it?* EUDI-scale legal mandates worked; standards-community "best practice" notes historically haven't.
4. **Wrong enforcement counterpart.** P3P died partly because EPAL was never standardized. If PDPP mandates presentation of client-committed claims but has no mechanism for what happens when they turn out to be false, it will be correctly criticized as theater. The enforcement counterpart can be legal (CFPB 1033, GDPR), registry-based (EUDI RPAC/RPRC), or reputation-based (Kantara trust marks), but it has to exist.
5. **Vendor capture of the manifest-authored layer.** If large clients can influence what the manifest authors say about "standard" claims (via the working group process, via reference implementations, via certification), the distinction between manifest-authored and client-authored erodes from the other side. This is the most subtle failure mode and doesn't have a single named precedent, but it is consistent with how TCF's purpose list was gradually shaped by the ad-tech industry it was meant to constrain.

### 3. If it's genuinely novel, is the absence of prior art a sign of opportunity or a sign of a non-obvious flaw?

My honest read: **it is a sign of opportunity in a direction several prior efforts were pointing but nobody pushed through.** The gap PDPP is filling has been visible in the literature for 25 years. Barth & Mitchell named it. Cranor's P3P postmortem named it. The Solid research papers named it. The Belgian DPA's TCF decision implicitly named it. The Apple Privacy Nutrition Label controversy named it. The EUDI RPAC/RPRC design names a specific case of it. The absence of a standard that does the thing PDPP wants is explainable by the usual standards-community dynamics (scope discipline, W3C-CG "presentation is out of scope," IETF "out-of-band UX concerns") rather than by a hidden flaw in the design.

The non-obvious flaws I would worry about, in priority order:

- **Attribution fatigue.** If every claim on a consent screen is attributed, the attribution signal flattens. Users may end up treating "[client] says" the same way they treat "I have read the terms" — as noise. The HAIP/EUDI approach of having the trust-list name replace self-declared names when they conflict is more surgical and may be more effective than PDPP's more egalitarian "attribute everything" approach. Worth designing a real user study before committing to the rendering.
- **Cleaving the manifest from the client puts manifest authors in a privileged epistemic position.** Whoever writes the manifest-authored descriptions is making authoritative claims about the protocol's guarantees. If those claims are wrong, inflated, or vague, the attribution split hides client claims behind a more-trusted but possibly equally-flawed platform voice. PDPP needs a discipline for manifest language that is at least as rigorous as its expectations for client claims.
- **Mis-attribution of cross-cutting concerns.** Some claims are neither purely platform-enforced nor purely client-committed. "Your data will be used for the purposes shown" is partly enforced (if scopes limit purpose) and partly committed (because scopes are coarse). Forcing these into one bucket or the other will produce legitimately confusing cases. Worth enumerating the hard cases in the spec and committing to a principled way of resolving them.

### What I looked in and could not find

For transparency, here are places I looked and found nothing directly matching PDPP's specific framing:

- SOUPS / CHI / PETS / USEC academic literature on consent UI attribution at the "[client] says" granularity.
- IETF mailing list archives for "client claims attestation data handling promise" (the relevant WGs are OAUTH, GNAP, HTTPAPI).
- OpenID Foundation working group notes on any proposed extension of `verified_claims` to RP-side data handling.
- OneTrust / TrustArc / Didomi / Cookiebot public architecture documentation for any vendor who publishes a protocol-level attribution scheme.
- W3C DPV issue tracker for discussions of per-claim source attribution.
- Kantara ANCR drafts for claim-level attribution (the "anchor" is on the notice record as a whole, not on individual claims within it).

I did not read every primary source in full — the Kantara CR v1.1 PDF in particular I could only get a summary of — so I cannot rule out that one of these has a field I missed. But I am confident that no widely-known prior art mandates normative consent-UI rendering of client-attributed claims distinct from protocol-authored claims, because if such prior art existed it would show up in the EUDI and HAIP discussions, which are the current frontier, and it does not.

---

## Primary sources

- Kantara Consent Receipt v1.1 — https://kantarainitiative.org/download/7902/
- Kantara CR archived spec — https://kantara.atlassian.net/wiki/spaces/archive/pages/3508790/Consent+Receipt+Specification
- ISO/IEC TS 27560:2023 — https://www.iso.org/standard/80392.html
- DPV (W3C) — https://w3id.org/dpv/ and https://w3c.github.io/dpv/
- DPV + ISO 27560 guide — https://w3c.github.io/dpv/guides/consent-27560
- W3C Verifiable Credentials Data Model 2.0 — https://www.w3.org/TR/vc-data-model-2.0/
- OpenID Connect Core 1.0 — https://openid.net/specs/openid-connect-core-1_0.html
- OpenID Connect Dynamic Client Registration 1.0 — https://openid.net/specs/openid-connect-registration-1_0.html
- OpenID Connect for Identity Assurance 1.0 — https://openid.net/specs/openid-connect-4-identity-assurance-1_0.html
- OpenID Identity Assurance Schema Definition 1.0 — https://openid.net/specs/openid-ida-verified-claims-1_0.html
- OpenID Connect Claims Aggregation 1.0 — https://openid.net/specs/openid-connect-claims-aggregation-1_0.html
- OpenID for Verifiable Presentations 1.0 — https://openid.net/specs/openid-4-verifiable-presentations-1_0.html
- OpenID for Verifiable Credential Issuance 1.0 — https://openid.net/specs/openid-4-verifiable-credential-issuance-1_0.html
- RFC 9635 (GNAP) — https://datatracker.ietf.org/doc/rfc9635/
- UMA 2.0 Core — https://docs.kantarainitiative.org/uma/wg/rec-oauth-uma-federated-authz-2.0.html
- Solid Protocol — https://solidproject.org/TR/protocol
- Solid Application Interoperability — https://solid.github.io/data-interoperability-panel/specification/
- "A Policy-Oriented Architecture for Enforcing Consent in Solid" (Debackere et al., CONSENT '22) — https://www.rubensworks.net/publications/debackere_consent_2022/
- "Is Automated Consent in Solid GDPR-Compliant?" (Florea & Esteves, 2023) — https://www.mdpi.com/2078-2489/14/12/631
- "Assessing the Solid Protocol in Relation to Security & Privacy Obligations" (2023) — https://arxiv.org/pdf/2210.08270
- "You Shall Not Pass (Without Consent): Enforcing Data Sovereignty with Solid Pods" (ACM TWeb, 2026) — https://dl.acm.org/doi/10.1145/3771554
- IAB Europe TCF — https://iabeurope.eu/transparency-consent-framework/
- IAB TCF v2 specification — https://github.com/InteractiveAdvertisingBureau/GDPR-Transparency-and-Consent-Framework/blob/master/TCFv2/IAB%20Tech%20Lab%20-%20Consent%20string%20and%20vendor%20list%20formats%20v2.md
- P3P Wikipedia (for history and obsoletion) — https://en.wikipedia.org/wiki/P3P
- Lorrie Cranor, "P3P is dead, long live P3P!" (2012) — https://lorrie.cranor.org/blog/2012/12/03/p3p-is-dead-long-live-p3p/
- Barth & Mitchell, "Enterprise Privacy Promises and Enforcement" (WITS '05) — https://theory.stanford.edu/~jcm/papers/barth-mitchell-2005.pdf and http://www.adambarth.com/papers/2005/barth-mitchell.pdf
- Apple App Privacy Details — https://developer.apple.com/app-store/app-privacy-details/
- Apple Privacy Manifests — https://developer.apple.com/documentation/bundleresources/privacy_manifest_files
- IDAC policy brief on Apple Privacy Nutrition Labels — https://digitalwatchdog.org/idac-policy-brief-apple-privacy-nutrition-labels/
- "Understanding iOS Privacy Nutrition Labels" (CHI 2022) — https://dl.acm.org/doi/fullHtml/10.1145/3491101.3519739
- Data Transfer Initiative — https://dtinit.org/
- DTI Data Trust Registry — https://dt-reg.org/about/
- CFPB Personal Financial Data Rights (Section 1033 rule) — https://www.consumerfinance.gov/personal-financial-data-rights/
- EUDI ARF — https://eu-digital-identity-wallet.github.io/eudi-doc-architecture-and-reference-framework/
- German EUDI Wallet Blueprint (Relying Party Authentication) — https://bmi.usercontent.opencode.de/eudi-wallet/eidas-2.0-architekturkonzept/content/ecosystem-architecture/trust/wallet-relying-party-authentication/
- "HAIP 1.0 for Verifiable Presentations: Securing the VP Flow" — https://dzone.com/articles/haip-1-0-securing-verifiable-presentations
- UK Digital Identity and Attributes Trust Framework — https://www.gov.uk/government/publications/uk-digital-identity-and-attributes-trust-framework-beta-version/uk-digital-identity-and-attributes-trust-framework-beta-version
- Kantara ANCR (Anchored Notice and Consent Receipt) WG — https://kantara.atlassian.net/wiki/spaces/WA/pages/42008577/
