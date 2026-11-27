# PDPP Representation and Approval Evidence (draft)

Status: Draft for discussion. Not normative. Do not implement.
Date: 2026-09-25

---

## 1. Introduction

This document covers two cases that Core's single `subject` did not express: a person approving a grant on behalf of someone else, and a third party verifying who approved a grant.

It has two parts. Core carries a small hook: an optional `grantors` list that records who approved when that person is not the subject, and a grant `extensions` object for profile data. Core's "Representative approval" subsection lists the obligations of an authorization server that issues such a grant. This document describes the optional capabilities built on that hook. Section 2 covers how an authorization server establishes a representative's authority. Section 3 covers approval evidence that a third party can check, and section 4 covers approval by an agent acting under the owner's policy. Deployments and sector profiles choose the accepted evidence and legal rules; PDPP defines what must be established and recorded, not which registry to query.

## 2. Representative authority

### 2.1 Relationship is evidence; authority is the decision

A relationship record, such as "this person is the child's mother", is evidence. The decision is narrower: may this person approve disclosure of this subject's selected data to this client, for this purpose and duration? Authority to view a record is not authority to authorize a third party to receive it. A profile states which capacities exist and what each permits.

### 2.2 How authority is established

A profile names the accepted ways to establish authority. Deployed precedent offers three, and a profile can accept any subset:

| Method | Example |
|---|---|
| A verified legal document | A birth certificate, adoption order or power of attorney |
| An authoritative register | A civil or population register, a guardianship register, or a mandate register |
| Vouching by an accountable professional | An accountable professional attesting to incapacity or to a documented representative relationship; the attestation alone does not confer disclosure authority |

The authorization server keeps what it relied on: the method, the evidence reference, the time it checked, and any validity limit. It does not send identity documents or register records to clients; `grantors` carries only an opaque identifier and a capacity URI.

### 2.3 Several representatives

Some legal regimes require every holder of authority to agree, for example every guardian of a minor. A profile states whether one representative suffices or all must approve. When all must approve, each is listed in `grantors`, and the grant is issued only after all of them approve the same final approval artifact.

### 2.4 When authority changes

Authority changes: a child grows up, a guardian is replaced, a power of attorney ends. A record that a parent validly approved a grant at birth stays true. Whether that grant continues is a separate question. A profile states, for each capacity:

- whether an issued grant depends on the representative's continuing authority;
- what ends that authority, such as an age, an expiry date or a register change;
- what happens to a dependent grant then: it continues, it expires, or the subject or a new representative must approve again.

When a grant depends on continuing authority and the authorization server learns that the authority has ended, it makes the grant inactive. The resource server learns this through introspection, as with any revocation. It never interprets custody law itself.

## 3. Approval evidence a third party can verify

### 3.1 What it proves

The goal is evidence that a specific person approved a specific grant. A third party can verify that a bound key signed an artifact. Independent verification of the approver's identity, authority, and grant contents requires trust anchors and binding rules that this draft does not yet define. The approver's own device or key signs what they approved. An authorization-server signature over the grant proves only that the server says so.

### 3.2 The signature must cover what was shown

A signature over a digest the person never saw is weak evidence. A passkey signs a challenge but does not show the person what the challenge stands for. Payment standards close this gap. PSD2's dynamic-linking rule ([Delegated Regulation (EU) 2018/389](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32018R0389), Article 5) ties the authentication code to the displayed amount and payee, and any change invalidates it. W3C Secure Payment Confirmation has the browser display the payee and amount and then signs those same fields. Approval evidence for PDPP needs the same structure:

1. A trusted confirmation surface shows or makes accessible every decision field in Core's immutable final approval artifact, including instance handles, resources, temporal bounds, retention, and rendered client claims.
2. The signed artifact binds that complete decision and the representation displayed for approval.
3. The authorization server retains approval evidence separately. A profile may place a client-disclosable evidence reference in the grant's `extensions`; it must define what that reference reveals and who may resolve it.

### 3.3 Keys

The approver's public key can be bound in the evidence in the manner of the RFC 7800 `cnf` claim or SD-JWT key binding (RFC 9901). A single stable key links the approver across clients. A profile should allow a separate key per client, as wallets commonly use a separate key per relying party.

### 3.4 Limits

A signature can establish that a bound key signed the approval artifact. Whether a verifier can establish the approver's identity, authority, and displayed decision depends on the trust anchors and binding rules this draft has yet to define. It does not prove that the grant is still active; revocation still requires a status check, for example introspection. It does not prove the approver's legal authority either; that rests on section 2.

## 4. Approval by an agent acting under the owner's policy

An owner may let an agent or a standing policy approve some requests on their behalf. Core's `grantors` identifies people and does not represent an automated agent as an approver. An agent-approval profile must identify the accountable approving person or propose a Core change. The open design questions are which requests may be approved this way, how the owner reviews and withdraws the delegation, and which purposes always require the owner's direct approval, for example training a model on the owner's data.

## 5. Use cases

| # | Use case | Expected result |
|---|---|---|
| 1 | A mother approves disclosure of her newborn's health record to a public benefit service. | The child is the subject. The mother is the grantor with a parental capacity. Her authority is checked against the civil register before the child's data is shown. |
| 2 | Two guardians share custody, and the jurisdiction requires both to agree. | Both are listed in `grantors`. The grant is issued after both approve the same final approval artifact. |
| 3 | The child reaches the age at which they act for themselves. | The profile states whether grants approved by the parent continue, expire or need the child's approval. The parent's past approval remains on record. |
| 4 | An adult holds power of attorney for a parent who can no longer act. | The parent is the subject; the attorney is the grantor. The capacity limits what the attorney may approve. |
| 5 | An agent approves a low-risk request under the owner's standing policy. | Core does not list the agent in `grantors`. The profile identifies the accountable approving person, or proposes a Core change. Section 4's open questions apply. |
| 6 | A third party checks, offline, who approved a grant. | It verifies signed approval evidence over the displayed fields. It still needs a status check to know whether the grant is active. |

## 6. Open issues

- Should Core name a small set of capacity URIs, or leave every capacity to profiles and deployments?
- May a representative's authority to manage an existing grant differ from their authority to approve a new one?
- What is the smallest first version of approval evidence? One candidate is a single-signer, display-bound confirmation with a per-client key.
- How does approval evidence relate to record evidence (the record evidence draft)? Both could share one evidence envelope.

## 7. Related work

- [HL7 FHIR R5 Consent](https://hl7.org/fhir/R5/consent-definitions.html) separates the consent's subject from its grantor, and allows several grantors.
- [RFC 8693](https://www.rfc-editor.org/rfc/rfc8693.html) (OAuth 2.0 Token Exchange) distinguishes the subject from the acting party with its `act` and `may_act` claims.
- NHS England, "Proxy access standard for health and care services" (DAPB3051), version 12.01, names the three ways to establish a proxy's basis for access, limits scope, and sets age-based reviews.
- [Suomi.fi e-Authorizations](https://www.suomi.fi/instructions-and-support/e-authorizations/using-suomifi-e-authorizations-as-a-person/granting-mandates-as-a-person/how-guardians-grant-mandates-for-managing-the-affairs-of-a-child) checks representation rights against national registers and requires every guardian of a minor to confirm a mandate.
- [W3C Secure Payment Confirmation](https://www.w3.org/TR/secure-payment-confirmation/) signs the payment details the browser displayed.
- [RFC 7800](https://www.rfc-editor.org/rfc/rfc7800.html) and [RFC 9901](https://www.rfc-editor.org/rfc/rfc9901.html) bind a holder key to an issued artifact.
