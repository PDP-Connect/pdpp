## Context

The current website has protocol docs and the live dashboard in the same app. That is convenient during development, but it creates a category problem: PDPP is a protocol with a reference implementation, not one SaaS product. A live operator dashboard, a protocol spec page, a reference implementation overview, and a mock sandbox have different authority, data sensitivity, caching behavior, auth requirements, and release cadence.

Prior-art grounding:

- Kubernetes separates concepts, tutorials, tasks, setup, and reference documentation, and treats the Dashboard as a deployable/accessed UI for a live cluster rather than as the docs site itself. Its Dashboard docs also emphasize access/auth and that the UI is not deployed by default.
- Matrix keeps the Matrix specification separate from Synapse documentation; Synapse describes a homeserver implementation, not the normative protocol itself.
- OAuth.com presents an OAuth playground as a simulated authorization server for learning flows, not as an operational account dashboard.
- Stripe is less analogous because it is a product, but its docs still distinguish API reference, test mode, and account-specific dashboard state.

The current repo already has partial guardrails:

- `openspec/specs/reference-implementation-architecture/spec.md` says `apps/web` is a downstream consumer and `_ref` routes are reference-only.
- `openspec/specs/reference-web-bridge-contract/spec.md` says web bridge routes must not invent a stronger reference contract.
- `openspec/README.md` says OpenSpec is not the normative PDPP protocol spec.

What is missing is the public surface topology: where each artifact lives, how it is labeled, and what it must not imply.

## Goals / Non-Goals

**Goals:**

- Make artifact category visible in route structure, navigation, metadata, and page copy.
- Keep protocol docs audience-neutral and free of live operational state.
- Give the reference implementation a public explainer home with coverage honesty and clone/run/deploy CTAs.
- Treat `/dashboard` as a self-hosted/live-instance operator surface with owner auth, state, noindex, and dynamic rendering.
- Define a future mock sandbox that teaches the protocol without touching real owner data.
- Preserve the ability to run everything under one local Next app during development while avoiding authority blur in production presentation.

**Non-Goals:**

- Do not split the monorepo or require separate deploys in this change.
- Do not implement hosted multi-tenant reference operation.
- Do not build the sandbox runtime in this change.
- Do not redefine PDPP protocol semantics.
- Do not remove the dashboard from local development.

## Decisions

### 1. Use route families as artifact boundaries

The route taxonomy should be:

- `/docs/**`: protocol documentation and extension docs. Public, static where possible, audience-neutral, no live owner state.
- `/reference/**`: public reference-implementation explainer. Covers architecture, design principles, implementation status, coverage matrix, clone/run/deploy instructions, and links to GitHub.
- `/dashboard/**`: live operator control plane for a running reference instance. Owner-authenticated when enabled, stateful, dynamic, noindex, and allowed to expose live traces/runs/records/deployment diagnostics.
- `/sandbox/**`: mock-backed educational instance. Public and resettable; no real credentials, no real owner data, no promise that it is a hosted operational reference.
- `/openspec/**`: project planning/governance viewer. Public only if intentionally enabled; labeled as project planning, not protocol truth.

This can remain one Next app locally. The point is category labeling and policy, not necessarily physical deployment.

### 2. Make the reference implementation a first-class public artifact

The sub-agent is right that GitHub README alone is weak for CEO-to-investor or standards-reviewer traversal. Add `/reference` as the product-quality explainer for the reference implementation:

- what it is and is not
- architecture diagram or surface map
- coverage matrix
- "try sandbox" CTA
- "clone and run" CTA
- "read architecture" CTA
- "view OpenSpec/change history" CTA

The reference page must not speak as the protocol. It should point to `/docs` for normative behavior and to code/tests for current implementation behavior.

### 3. Add a coverage matrix as a public honesty artifact

The coverage matrix should answer: which protocol concepts, flows, and optional extensions are specified, documented, implemented, tested, demonstrated in sandbox, and visible in live reference diagnostics.

Do not wait for perfection. The matrix is valuable precisely because it makes gaps falsifiable. It should include status labels such as `specified`, `documented`, `implemented`, `tested`, `demoed`, `deferred`, and `not-applicable`, with source links to docs/tests/routes where possible.

### 4. Treat hosted live dashboard as optional and probably off by default

A hosted public live reference dashboard creates hard questions: whose data is it, what breaks during demos, who is the owner, what secrets exist, and how incidents are handled. The honest default is self-hosted/local. Public `pdpp.dev` can show reference explanation and sandbox, but it should not imply that Vana operates a canonical live reference instance with real data unless that becomes an explicit product decision.

If a hosted live instance exists later, it needs a separate deployment plan, seed data policy, auth policy, reset policy, incident posture, and no personal credentials.

### 5. Sandbox is a fourth artifact, not a fake dashboard

The sandbox should be a mock-backed pedagogical environment. It can share UI components with `/dashboard`, but its data and copy must make clear that it is simulated. It exists to teach protocol flows and API calls, not to operate a user's reference instance.

### 6. Deployment diagnostics belong to live dashboard, but can be linked from reference docs

The `/dashboard/deployment` page from `make-semantic-retrieval-operational` is live-instance diagnostics. It belongs under `/dashboard`. The public `/reference` page can show screenshots or describe the diagnostic capability, but it must not embed live operational state in protocol docs.

## Risks / Trade-offs

- **Route split feels heavier than one simple docs app** -> Keep one Next app initially; enforce boundaries through route families, labels, auth, metadata, and navigation.
- **Reference page becomes marketing slop** -> Tie claims to coverage matrix rows and links to tests/docs/routes.
- **Coverage matrix creates visible gaps** -> That is the point; reviewers trust falsifiable status more than broad claims.
- **Sandbox can be mistaken for live reference** -> Give it distinct chrome, reset semantics, mock labels, and no credential entry points.
- **Dashboard links leak into public docs** -> Use intentional CTAs and labels; protocol docs can mention that reference diagnostics exist without making them protocol authority.

## Migration Plan

1. Inventory current pages and classify every route into protocol, reference, live dashboard, sandbox, or project planning.
2. Add shared surface-category metadata and navigation labels.
3. Create `/reference` and the initial coverage matrix.
4. Move or relabel reference implementation docs out of the protocol-docs mental model where needed.
5. Harden `/dashboard` as live-instance only: dynamic/noindex, owner-authenticated when configured, clear local/self-hosted copy.
6. Add a sandbox placeholder page with explicit design, even before full mock runtime exists.
7. Update README and docs navigation to match the topology.

## Open Questions

- Should `/reference` live at the root route family or under `/docs/reference` with stronger labeling?
- Should `/openspec` remain public on hosted builds, or only in local/internal builds?
- What is the minimal useful coverage matrix data model, and should it be generated from docs/tests/routes or maintained manually at first?
- Should the sandbox be same-origin under `pdpp.dev/sandbox` or a separate subdomain once it has state?
