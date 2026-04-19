# Landing Page Framing Memo

**Date:** 2026-04-15
**Status:** Directional recommendation for the next PDPP landing-page iteration

---

## Bottom line

The PDPP landing page should market **enforceable, granular personal data access**, not **personal servers** and not **collection infrastructure**.

The opening should answer:

1. Why should I care?
2. Why should I believe you?
3. How does it work?

In that order.

---

## What the research says

- Leading technical sites make one promise and one proof unavoidable above the fold.
- Infrastructure sites still lead with the outcome, not the topology.
- The best proof pattern for PDPP is a real artifact that both humans and engineers can read.
- The transition from value to mechanism usually happens within one viewport.

For PDPP, that means:

- hero = value claim
- hero or first scroll = proof artifact
- immediate next section = technical flow

---

## What this means for PDPP

### The page should teach

- `PDPP = a consent-and-enforcement model for personal data access`
- `A personal server is one way to realize that model today`
- `Native platform support, browser automation, and import are realization paths, not the thesis`

### The page should not teach

- `PDPP = run your own personal server`
- `PDPP = connectors / browser automation / scraping`
- `PDPP = a spec you only understand by reading protocol prose`

---

## Recommended narrative order

- **Hero**: precise, revocable, server-enforced personal data access
- **Opening proof**: show a real consent/request/grant or enforcement artifact immediately
- **Technical flow**: request -> consent -> grant -> enforce -> sync -> revoke
- **Realization paths**: native support, browser automation, import, and where personal-server deployment fits
- **Generalization**: same protocol semantics across platforms and deployment models

---

## What should change first

### 1. Hero

Replace the current protocol-definition opener with a value statement. The hero should not center `your server` as the defining object.

### 2. First scroll section

Do not open with connector/runtime detail. Open with proof that the model is real.

### 3. Ingest

Reframe it as an adoption-path section rather than the conceptual premise of the story.

### 4. Multi

Use it to generalize across platforms and deployment models, not to repeat the collection-method story.

---

## Preserve

- Consent -> grant -> enforcement shared state
- Two-level disclosure: narrative plus JSON/HTTP/spec depth
- Collection-method agnosticism: native APIs, browser automation, and import remain valid

---

## Working rule for the next iteration

> Lead with the protocol's value. Prove it with one real artifact. Explain realization paths after the reader already wants the model.

