# PDPP Docs Voice and Framing Guide

Audience: every agent or contributor writing docs, READMEs, design notes, OpenSpec artifacts, marketing/site copy, dashboard text, or release notes for this repo.

Goal: keep PDPP's framing honest, precise, and consistent across normative spec, reference implementation, demo/operator surfaces, and roadmap. Past drafts have drifted into owner-voice, hosted-service promises, and cybersecurity-flavored prose. This page is the durable rulebook so we stop relitigating tone in PRs.

If you only read one thing: PDPP is an **authorization and disclosure protocol for personal data** that sits *above* OAuth 2.0 + RFC 9396 (RAR). The reference implementation, demos, hosted dashboards, connectors, and Vana/DTI context are downstream surfaces — never the headline, never confused with the protocol.

---

## 1. The framing stack (use this order)

When introducing PDPP in any new doc, page, or section, climb down this ladder. Stop at whatever depth the audience needs.

1. **PDPP** — a protocol that defines parameterized, revocable, user-controlled grants for personal data.
2. **OAuth 2.0 + RFC 9396 (RAR)** — the standards envelope PDPP profiles. PDPP is the `authorization_details` `type` for personal data, in the same family as FAPI/FDX (banking) and SMART on FHIR (health).
3. **Reference implementation** — a forkable Node/Postgres implementation that proves the protocol. Not "the product."
4. **Collection Profile** — a *companion* spec for bounded connector runs. Optional. A conformant resource server can serve pre-collected, exported, or manually imported data with no collection machinery.
5. **Polyfill connectors** — one fulfillment mechanism for collection. Browser automation is a *polyfill for missing portability APIs*, not the ideal end state.
6. **Demo / operator console / hosted instances** — operator surfaces on top of the reference. Not the protocol, not promises.
7. **Vana / OpenDataLabs / DTI context** — strategic alignment. Mention only when the document is explicitly about positioning, not when explaining the protocol.

Do not invert this. A reader who lands on a paragraph that opens with "Vana is building a hosted dashboard…" or "PDPP is a tool for collecting your data from Gmail…" is being misled about what the protocol is.

---

## 2. Normative vs. non-normative voice

Different artifacts have different voice contracts. Mixing them is the single most common drift.

| Artifact | Voice | Tense / mood | Allowed claims |
|---|---|---|---|
| `spec-*.md` at repo root | **Standards prose**. Third-person, structural. RFC 2119 keywords (`MUST`, `SHALL`, `SHOULD`, `MAY`). | Present, prescriptive. | Protocol obligations, interfaces, conformance. No deployment details, no roadmap. |
| `openspec/specs/**/spec.md` | **Capability spec**. Normative for the reference implementation. `SHALL` / `SHALL NOT` per requirement, with `WHEN` / `THEN` scenarios. | Present, prescriptive. | Reference-implementation behavior. Not protocol semantics. |
| `openspec/changes/<name>/proposal.md` / `design.md` / `tasks.md` | **Project planning**. Terse. State the change, the rationale, the tradeoff. | Present, declarative. | Why a change exists, what it modifies, acceptance checks. |
| `design-notes/**` | **Requirements discovery**. Question → context → stakes → current leaning → promotion trigger. Not normative. | Mixed. State status (`captured`, `decided`, `superseded`). | Open questions, prior art, decisions not yet promoted. |
| `docs/**` (this folder) | **Contributor / reviewer guides**. Durable explainers, playbooks, audits, research syntheses. | Mixed. | Explain reality. Cite specs and code. Label aspiration. |
| `README.md`, `reference-implementation/README.md`, package READMEs | **Operator-facing**. Describe what the artifact *does today*, with a quick-start that works. | Imperative for instructions, present for descriptions. | Current behavior of the code at this commit. |
| `apps/site/` site copy (`/docs`, `/reference`, `/sandbox`, etc.) | **Public site**. Calm, technical, illustrated. | Present. | Protocol facts, clearly labeled reference behavior, clearly labeled mock specimens. |
| `apps/console/` operator copy (clean owner routes `/`, `/sources`, `/syncs`, `/audit`, …; `/owner/**`) | **Operator console**. UI strings for someone running their own instance. | Imperative or descriptive. | The owner's instance state. Not the protocol. |

A common failure: writing dashboard tooltip text in the voice of a hosted SaaS ("We'll sync your Gmail nightly"). The reference does not offer a service to "us." Use operator-voice: "This connection runs on the schedule you configured."

---

## 3. Surface taxonomy (what each one is, and is not)

`openspec/specs/reference-surface-topology/spec.md` defines this taxonomy normatively. Copy must respect it.

- **`spec-*.md` (repo root)** — *the protocol*. Cite by section number, never paraphrase as if it were settled best practice when it is draft.
- **`/docs/**` on the site** — protocol documentation. Never shows live owner state.
- **`/reference/**`** — public explainer of the reference implementation, including a coverage matrix. Use it to show *what the reference proves today*. It is not the protocol; it is one realization of it.
- **`/sandbox/**`** — mock-backed pedagogical dashboard with deterministic fictional data. Always label specimens as such. Never collects real credentials.
- **clean owner routes (`/`, `/sources`, `/syncs`, `/audit`, `/explore`, `/grants`, `/connect`, `/schedules`, and clean deployment/admin nouns)** — the live owner/operator control plane. Owner-authed. Talk to the operator, not "the user of a service." Removed `/dashboard/**` paths are not compatibility routes; generated owner links use the clean routes directly.
- **`/planning/**`** — OpenSpec viewer. Project planning, not protocol authority.
- **`/design`, `/palette`** — local contributor workbenches. Don't cite them as user-facing surfaces.

When writing, never let `/sandbox` copy sound like the owner control plane ("Your data has been collected"), and never let owner-console copy sound like `/docs` ("PDPP enforces field projection").

---

## 4. Things to never say (and what to say instead)

| Don't say | Why it's wrong | Say instead |
|---|---|---|
| "PDPP collects your data from Gmail/ChatGPT/Chase." | Conflates Core with Collection Profile and connectors. | "PDPP defines how a client gets a grant-scoped view of data already in a personal server. The reference implementation includes connectors that can populate that server." |
| "Connect Gmail with PDPP." | PDPP doesn't connect anything. A connector does. | "Configure the Gmail connector on your reference instance." |
| "PDPP secures your data." / "PDPP protects you from breaches." | Cybersecurity framing. PDPP is a consent/disclosure protocol, not an InfoSec product. | "PDPP makes it possible to grant a specific, scoped, revocable view of personal data instead of broad account access." |
| "Sign in with PDPP." | Implies hosted identity. PDPP isn't an IdP. | "Authorize the client to access your data via a PDPP grant on your personal server." |
| "Our hosted PDPP service…" | We don't operate a hosted service for end users. The reference is forkable and self-hostable. | "The public reference deployment at `pdpp.dev` / `pdpp.vivid.fish` runs the open-source reference image for inspection. Operators self-host their own instances." |
| "PDPP will support …" / "We're building …" | Pulls roadmap into the protocol. | If it's a draft requirement, cite the OpenSpec change. If it's aspirational, label it `Roadmap` or `Aspirational` explicitly. |
| "OAuth scopes are insecure." | False, and picks a fight. | "Standard OAuth scopes are too broad for continuous, real-time portability. PDPP profiles RFC 9396 to express field-, stream-, and time-scoped grants." |
| "Trustless / blockchain-secured grants." | Chris Riley (DTI) explicitly rejected this framing. Vana's Web3 angle should not lead. | "Grants are immutable consent artifacts that any conformant resource server can enforce." |
| "We use AI to extract your data." | Connectors are deterministic runtimes, not LLM agents. | "Connectors are bounded programs that emit RECORD/STATE/DONE messages under the Collection Profile." |
| "PDPP works with Gmail, ChatGPT, Slack, Spotify…" with no qualifier. | Implies all connectors are equally proven. They are not (see `connector-public-listing-honesty-2026-05-15.md`). | "The reference includes connectors for Gmail, ChatGPT, Slack, …. See the connector coverage matrix at `/reference` for current proof state." |
| "Our connector for Gmail is fully working." | Coverage is honest, not aspirational. | Use the maturity vocabulary: `proven_working`, `needs_human_auth`, `local_only`, `unproven`, `test_stub`, `broken_in_current_deployment`. |
| "Browser automation is how PDPP collects data." | Conflates a polyfill with the protocol. | "When a source has no portability API, the reference can drive a real browser session. This is a polyfill for missing APIs, not the ideal." |
| "Built on top of Vana." / "Powered by OpenDataLabs." | PDPP is independent of Vana product surfaces; the brand link is strategic, not architectural. | Mention Vana/OpenDataLabs only in positioning docs, with clear scope. |

---

## 5. Talking about portability without sounding like a security pitch

Personal data portability is the framing. Cybersecurity is not. Use these moves:

- Lead with **consent**: "the user grants a client specific, scoped access".
- Lead with **disclosure**: "the resource server enforces what the client sees".
- Lead with **portability**: "ongoing, parameterized access that can move with the user across apps".
- Lead with **minimization**: "field, stream, time-range, and change projections are protocol-enforced".

Avoid:
- "Breach", "attack surface", "zero-trust", "threat model" — unless you are actually writing the security section of a spec or a security audit.
- "Encryption" as a value proposition (encryption is a substrate, not the protocol's pitch).
- "Privacy-preserving" without saying what is preserved and how — the protocol enforces *disclosure constraints*, not all downstream uses of returned records.

Concrete contrast:

> **Don't:** "PDPP keeps your data safe from third parties by encrypting it end-to-end."
>
> **Do:** "PDPP lets a user grant a client access to a *specific* slice of their data — particular streams, fields, time ranges, and change projections — and revoke it later. The resource server enforces the grant on every request."

Regulatory framing (GDPR Article 20, DMA continuous portability) is legitimate context. Use it sparingly and accurately; the spec lists what is *informative* vs. required.

---

## 6. Connectors and polyfills — precise claims only

Connectors are easy to over-promise. The standing rules:

- **A connector is a Collection Profile runtime**, not a feature of PDPP Core. Describe it as a bounded program that emits RECORD/STATE/DONE.
- **Polyfill connector** means "this connector exists because the source lacks a usable portability API; it works by acting on the user's behalf in a real browser/CLI/filesystem context." It is explicitly framed as a stopgap.
- **Maturity is a state, not a marketing label.** Use the vocabulary from `design-notes/connector-public-listing-honesty-2026-05-15.md`: `proven_working`, `needs_human_auth`, `local_only`, `unproven`, `test_stub`, `broken_in_current_deployment`.
- **Coverage is honest.** If a connector emits zero records in the public reference deployment, don't list it as "working". Cite the coverage matrix or the manifest's `capabilities.public_listing`.
- **Connectors are not "integrations" in the SaaS sense.** They do not establish a partnership with the source platform. Avoid co-branding language that implies otherwise.

When writing about a specific connector, say what runtime it uses (API client, browser binding, local filesystem reader, uploaded artifact ingest), what credentials/attention it needs, and what its current proof state is.

---

## 7. Reference implementation vs. hosted instances

The reference implementation is **forkable**. There is no PDPP-the-company offering a multi-tenant hosted PDPP backend.

- The Docker images at `ghcr.io/vana-com/pdpp/*` are the reference, published for inspection and self-hosting.
- `pdpp.dev` (and any other instance the project runs publicly) is a *public reference deployment* for inspection. It is not a product an end user signs up for, and copy should not invite that interpretation.
- The operator console (the clean owner routes at `/`, `/sources`, `/syncs`, `/audit`, …) is for someone running their own instance. Address that operator directly.

Phrasings that work:

- "Run the reference locally with `pnpm dev` or the Docker compose file."
- "The public reference deployment at `pdpp.dev` runs the open-source images so reviewers can inspect a live instance."
- "Operators configure connectors on their own instance; PDPP does not host data for users."

Phrasings that mislead:

- "Sign up for PDPP."
- "PDPP supports millions of users."
- "Get started by creating a PDPP account."

---

## 8. Vana, OpenDataLabs, and DTI context

PDPP is published under the `@opendatalabs` scope and is informed by Vana's work on personal data, but the protocol stands on its own. Default to protocol-first framing.

- In protocol specs: do not mention Vana or OpenDataLabs except in the DTI alignment / acknowledgments section, if at all.
- In project READMEs and the site: it is fine to identify the stewards and the relationship to OpenDataLabs/Vana, kept short.
- In positioning docs (e.g. DTI engagement, fundraising context): explain the alignment, but avoid cryptographic-trustlessness framing — per `spec-dti-alignment.md`, Chris Riley and DTI explicitly reject that pitch.
- DTI alignment is *complementary*: PDPP defines consent and disclosure; DTI handles transfer mechanics. Do not claim PDPP replaces DTI/DTP, and do not claim DTI has endorsed PDPP.

---

## 9. Aspiration, roadmap, and "future work"

The spec, reference, and OpenSpec change folders all contain forward-looking statements. Keep them distinguishable.

- **Spec roadmap** — anything not in v0.1 is either a `TODO for v0.2` marker in the spec or a deferred design note. Don't pull v0.2 features into v0.1 prose.
- **Reference roadmap** — open OpenSpec changes describe what's *being proposed*. Until they're archived, do not write docs as if the change is done.
- **Aspirational copy on the site** — if a section describes something the reference does not yet do, label it (`Roadmap`, `Aspirational`, `Not yet implemented`). The April 2026 `/reference` audit (`docs/reference-audit.md`) flagged exactly this drift; do not repeat it.
- **Demo specimens** — anything served from `/sandbox` is deterministic fictional data. Label it visually and in copy.

When you find existing copy that violates this, prefer fixing the copy over filing a follow-up — but call it out in the PR so reviewers can sanity-check.

---

## 10. Editorial defaults

- Use precise nouns from the spec: *grant*, *manifest*, *selection request*, *stream*, *record*, *connector*, *resource server*, *authorization server*, *personal server*. Don't invent synonyms.
- Use `connector_id`, `connection`, `connector_instance_id`, `device`, `run`, `schedule`, `coverage`, `grant` as defined in `design-notes/full-context-refresh.md`. These are load-bearing.
- Refer to RFCs by number when relevant (`RFC 9396`, `RFC 7591`, `RFC 6749`). Don't say "OAuth scopes" when you mean RFC 9396 `authorization_details`.
- Date durable artifacts in ISO 8601 (`2026-05-21`), not relative ("last week").
- Prefer short, declarative sentences. Standards readers and engineers both prefer terse to flowery.
- Headings should describe *what the section is about*, not be marketing hooks.
- No emoji in normative or contributor docs. Site marketing copy is the only place emoji might be appropriate, and even there default to no.
- Use sentence case in headings unless a brand mandates otherwise.
- Code, identifiers, env vars, and file paths in `monospace`.

---

## 11. Self-check before you ship docs

Run this checklist before merging any non-trivial docs change.

1. Did I open with PDPP-as-protocol, or did I lead with a connector/dashboard/demo?
2. Did I confuse Core, Collection Profile, reference implementation, polyfill connector, or operator console anywhere?
3. Did I claim hosted-service semantics PDPP does not provide ("sign up", "we sync", "our service")?
4. Are connector claims qualified with maturity / coverage state, or am I implying everything works?
5. Did I use cybersecurity vocabulary when I should have used consent/disclosure/portability vocabulary?
6. Are aspirational statements labeled as such, with a pointer to the OpenSpec change or the spec TODO that owns them?
7. Did I respect the surface taxonomy — protocol vs. reference vs. sandbox vs. operator dashboard?
8. Did I invent terminology that the spec or `concept-inventory.md` already names? If yes, switch to the established noun.
9. If I touched protocol semantics, did I write an OpenSpec change instead of editing `spec-*.md` directly?
10. Did I keep Vana/OpenDataLabs/DTI framing scoped to positioning docs, not protocol prose?

If you can answer all of these, ship it. If not, fix the doc, not the checklist.

---

## Related

- [`AGENTS.md`](../AGENTS.md) — repo-wide rules and OpenSpec usage.
- [`spec-core.md`](../spec-core.md) — normative protocol.
- [`spec-collection-profile.md`](../spec-collection-profile.md) — companion Collection Profile.
- [`spec-dti-alignment.md`](../spec-dti-alignment.md) — DTI positioning and tone constraints.
- [`design-notes/full-context-refresh.md`](../design-notes/full-context-refresh.md) — Core / Collection Profile / reference boundary map and noun model.
- [`design-notes/public-site-vs-reference-server-split-2026-05-21.md`](../design-notes/public-site-vs-reference-server-split-2026-05-21.md) — surface split rationale.
- [`design-notes/connector-public-listing-honesty-2026-05-15.md`](../design-notes/connector-public-listing-honesty-2026-05-15.md) — connector maturity vocabulary.
- [`docs/concept-inventory.md`](concept-inventory.md) — canonical concept names.
- [`docs/reference-audit.md`](reference-audit.md) — prior site audit that motivated several rules here.
- [`openspec/specs/reference-surface-topology/spec.md`](../openspec/specs/reference-surface-topology/spec.md) — normative taxonomy of public surfaces.
