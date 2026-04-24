# Framing: PDPP's trust model, for decisions that look different across parties

Status: captured
Owner: project owner
Created: 2026-04-20
Updated: 2026-04-24
Related: `openspec/changes/add-polyfill-connector-system/design-notes/partial-run-semantics-open-question.md`, `openspec/changes/add-polyfill-connector-system/design-notes/cursor-finality-and-gap-awareness-open-question.md`, `openspec/changes/add-polyfill-connector-system/design-notes/gap-recovery-execution-open-question.md`, `openspec/changes/add-polyfill-connector-system/design-notes/blob-hydration-open-question.md`, `openspec/changes/add-polyfill-connector-system/design-notes/credential-storage-open-question.md`

**Status:** reference framing (not an open question)
**Raised:** 2026-04-20
**Purpose:** Many of the open-question notes in this directory have answers that depend on which PDPP party the decision is optimized for. This framing note is the canonical place to spell that out, so each individual note can reference it once instead of re-litigating the framing internally.

## The three parties

PDPP is a three-party protocol, consistent with the OAuth family it builds on.

1. **Owner.** The person whose data it is. Runs the AS + RS (or has them run on their behalf by a hosting provider they trust). Controls who gets grants.

2. **Client.** Any application the owner has granted scoped access to. This category is deliberately broad: it includes the owner's own personal agent, a third-party SaaS (e.g., a productivity tool wanting Gmail threads), a research tool acting on behalf of a different user, an LLM wrapper startup, a fitness app wanting aggregated health data, and so on. The owner's own agent and a Series-B SaaS vendor are *both* clients; the spec treats them symmetrically modulo grant scope.

3. **AS / RS.** The owner's personal server — authorization server (issues grants, mints tokens) and resource server (enforces grants, serves records). Together they enforce the consent the owner has given.

## Why the framing matters

Many decisions in these notes look clean when you assume a single party of interest and ambiguous when you account for all three. Examples:

- **Embedding-model choice in semantic retrieval**
  - Owner-focused frame: owner picks, done. Model upgrades are a local decision.
  - Multi-client frame: a third-party client needs to know what model each owner's RS uses, or scores aren't comparable.

- **API discoverability**
  - Owner-focused frame: owner knows their own data, hardcoded connector lists suffice.
  - Multi-client frame: a client written once against N owners' servers needs capability discovery.

- **Approve-time authentication**
  - Owner-focused frame: OS-level trust on localhost is plenty.
  - Multi-client frame: owner might approve from a different device than where their server runs — needs a browser auth flow.

- **Search ranking**
  - Owner-focused frame: the owner's agent reranks, server ships raw candidates.
  - Multi-client frame: a dashboard consumer doesn't want to implement a reranker; needs server-side default ranking.

- **Self-export artifact format**
  - Owner-focused frame: whatever the owner's own toolchain prefers.
  - Multi-client frame: portable across implementations — which means standardized.

- **Partial-run / gap semantics**
  - Owner-focused frame: the owner's dashboard shows a "missing data" badge.
  - Multi-client frame: a third-party client polling `known_gaps` needs a machine-readable taxonomy.

In every case, the owner-only frame suggests a narrower, simpler answer; the multi-client frame suggests a richer, more constrained answer. Neither is wrong. **The spec has to serve both**, and any specific decision should be explicit about which party it's optimizing for.

## What the framing is NOT

- **Not a decision.** This note doesn't say "always optimize for third-party clients" or "owner-only is the real use case." Both are real. The framing just makes the ambiguity legible.

- **Not a claim about adoption.** Whether most PDPP deployments in practice end up as single-owner + single-agent or multi-owner + many-clients is an empirical question with no data yet. The spec's job is to not foreclose either.

- **Not a recommendation about which options to pick.** Each open-question note enumerates options. This note helps a reader evaluate those options, not narrow them.

## How the open-question notes should use this

Each open-question note that touches a decision with this asymmetry should:

1. Reference this note near the top ("see `pdpp-trust-model-framing.md`") so readers have the framing before they encounter options.
2. Note explicitly which party each option serves best, where that's a real distinction.
3. Avoid embedding a unilateral choice ("the owner's agent is the primary client") in framing language, unless a separate decision-of-record has been made to that effect.

## Cross-reference

Notes that have decisions shaped by this framing:

- `owner-authentication-at-approve-time-open-question.md`
- `rs-api-discoverability-open-question.md`
- `semantic-retrieval-surface-open-question.md`
- `blob-hydration-open-question.md`
- `rs-storage-topology-open-question.md`
- `partial-run-semantics-open-question.md`
- `cursor-finality-and-gap-awareness-open-question.md`
- `gap-recovery-execution-open-question.md`
- `owner-self-export-open-question.md`
- `connector-configuration-open-question.md`

## Why a separate framing note rather than a paragraph in each

Two reasons.

First, each open question has its own scope and options; re-litigating the framing in every note adds noise and risks framing drift (different notes describe "the three parties" slightly differently, and those differences start to matter). A canonical framing note eliminates the drift.

Second, the framing itself might evolve. A future spec decision might narrow PDPP to a specific subset of client types, or generalize to a fourth party (escrow, delegation chains, attestation). When that happens, one note updates instead of ten.
