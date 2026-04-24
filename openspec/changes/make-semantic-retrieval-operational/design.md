## Context

The semantic retrieval extension and its implementation exist, but the operational story is incomplete. The reference can advertise `capabilities.semantic_retrieval.supported: true` and `index_state: "built"` while all real polyfill manifests contribute zero semantic fields. That state is technically consistent with "the endpoint exists", but it is misleading for an internal reviewer trying to verify that semantic retrieval works over real data.

Existing semantic design notes reviewed:

- `openspec/changes/reference-implementation-program/design-notes/semantic-retrieval-status-options-2026-04-23.md`
- `openspec/changes/reference-implementation-program/design-notes/semantic-retrieval-reference-experiment-2026-04-23.md`
- `openspec/changes/reference-implementation-program/design-notes/semantic-retrieval-experimental-extension-2026-04-23.md`
- `openspec/changes/reference-implementation-program/design-notes/semantic-retrieval-metadata-carrier-2026-04-23.md`
- `openspec/changes/reference-implementation-program/design-notes/semantic-retrieval-first-implementation-shape-2026-04-24.md`
- `openspec/changes/add-polyfill-connector-system/design-notes/semantic-retrieval-surface-open-question.md`

Those notes settle status, carrier, first implementation shape, and sqlite-vec constraints. None directly covers operational corpus coverage, a dashboard deployment inspector, or multilingual embedding configuration. This change fills that gap without re-opening the public semantic retrieval contract.

Hugging Face currently documents Transformers.js with `import { pipeline } from '@huggingface/transformers'`, and its v4 announcement continues the `@huggingface/transformers` package name. The older worker suggestion used `@xenova/transformers`; implementation should verify package/runtime compatibility but should not start from the deprecated package assumption.

## Goals / Non-Goals

**Goals:**

- Make semantic retrieval visibly useful against first-party polyfill data after a normal `pnpm run dev` startup.
- Make zero semantic participation obvious in the dashboard instead of letting reviewers discover it through empty searches.
- Provide a real local embedding backend with no hosted API key requirement.
- Keep the deterministic stub backend for tests, offline CI, and exact-match contract tests.
- Allow an operator to choose a multilingual embedding profile for Italian or other non-English data, with language bias displayed in metadata and diagnostics.
- Rebuild or reconcile existing local databases after manifest semantic-field coverage changes.

**Non-Goals:**

- Do not add public caller-selected `model=`, `embedding=`, `vector=`, reranking, score, or debug parameters.
- Do not stabilize the semantic retrieval extension.
- Do not add multiple simultaneous semantic indexes or query-time model fan-out.
- Do not add a hosted embedding provider as the default.
- Do not promise language detection, translation, or cross-lingual quality beyond the configured model's known capabilities.

## Decisions

### 1. Treat coverage as an operational readiness axis, not a new public API contract

The public semantic advertisement already declares backend facts: model, dimensions, distance metric, and index state. It intentionally does not enumerate per-stream `semantic_fields`. This change should not add a public per-stream capability report to RS metadata.

Instead, the reference will compute diagnostics for:

- backend availability
- index kind and state
- configured embedding profile
- language bias
- count of participating connectors, streams, and fields
- list of participating `(connector_id, stream, field)` tuples for operator inspection
- explicit warning when backend/index are ready but participation is zero

The dashboard can use these diagnostics to make the system inspectable. Public clients still rely on the existing semantic capability and stream metadata.

### 2. Add semantic_fields to real first-party polyfill manifests

The unused native `reference-implementation/manifests/reddit.json` is not enough. First-party polyfill manifests should declare semantic fields for top-level string fields that contain natural language and are safe to embed under the existing grant rules.

Implementation should audit before editing. Priority candidates include message text, email subject/snippet/body-like fields, issue/PR titles and bodies, chat messages, code-assistant conversation text, Reddit post/comment text, and YNAB payee/memo-style fields if present as top-level strings. The validator remains strict: no nested paths, arrays, blobs, non-string scalars, or invented fields.

### 3. Use a real local embedding backend for operational mode, keep the stub for tests

The deterministic stub is valuable for contract tests because it is fast, deterministic, offline, and exact-match-reflexive. It is not a convincing product demo: paraphrase and multilingual behavior are explicitly non-promises.

The reference should add a local transformer embedding backend that can run without a hosted API key. The implementation should evaluate `@huggingface/transformers` because it is the current Transformers.js package, supports local model execution, and works with Hugging Face model IDs tagged for Transformers.js. The final implementation should pin the dependency and model behavior through tests and startup diagnostics rather than relying on prose.

The default profile should be chosen after a small evaluation of install size, first-run cache behavior, query latency, and English/non-English quality. If the default remains English-biased for speed, the multilingual profile must be one env/config switch away and documented. If the performance cost is acceptable, prefer a multilingual default because the reference is meant to be internationally legible.

### 4. Model selection is server/operator configuration

The public endpoint continues rejecting model selectors. Operators configure one active embedding profile for the reference process. The profile supplies:

- `profile_id`
- Hugging Face model ID or named preset
- dimensions
- distance metric
- language bias metadata
- cache directory
- whether downloading is allowed on startup

Changing the profile is a semantic index drift event. The reference must mark the index stale and rebuild from records before claiming built coverage for that profile.

### 5. Italian support is a profile requirement, not a separate endpoint

An Italian deployment should be able to choose a multilingual sentence-embedding model through configuration, for example a multilingual MiniLM-family model if implementation verifies it works with Transformers.js. The dashboard and RS metadata should publish language bias, such as `primary: "multi"` or `primary: "it"` plus a note. The API request remains `GET /v1/search/semantic?q=...`.

Multiple simultaneous models are deferred. Supporting both English and Italian profiles concurrently requires index namespacing by `embedding_profile_id`, handling different dimensions, model-specific cursors, and query merge semantics. That is a separate design problem, not an implementation detail inside this tranche.

### 6. Add a read-only deployment page

Add `/dashboard/deployment` as an operator diagnostic page. It should be read-only and should not require protocol changes. It should surface:

- local topology and relevant URLs
- advertised public capabilities
- semantic backend/index state
- participating semantic streams and fields
- loaded manifest source/provenance
- local database path and vector backend kind
- relevant env vars with secrets redacted and provenance where available
- warnings for zero participation, stale index, missing model cache, disabled downloads, and sqlite-vec fallback

This page is not a public PDPP API. It is reference operator UI, similar in spirit to run timelines and control-plane diagnostics.

## Risks / Trade-offs

- **First-run model download is slow or flaky** -> Make cache path explicit, show cache state in deployment diagnostics, and keep a stub/offline mode for tests.
- **Embedding model dependency causes native/runtime friction** -> Prefer the current package, pin versions, and keep graceful disablement with an honest advertisement when unavailable.
- **Manifest semantic fields accidentally embed low-value or sensitive fields** -> Require top-level string fields only, audit field choice, and add tests that grant projections bound embedding/snippets.
- **A multilingual model is slower than English MiniLM** -> Evaluate both and document the default. Preserve an operator switch so Italian deployments do not require a fork.
- **`index_state: "built"` remains ambiguous for empty corpora** -> Do not overload public `index_state`; add deployment diagnostics with explicit participation counts and warnings.
- **Existing databases keep stale manifest/index state** -> Use existing reconcile/backfill patterns to update first-party manifests and rebuild semantic indexes idempotently.

## Open Questions

- Should the default operational profile be multilingual, or English-biased with a documented multilingual preset?
- Should a future public semantic capability include aggregate coverage fields, or is stream metadata plus reference diagnostics sufficient?
- What is the right future model for multiple simultaneous profiles: per-profile index tables, per-profile vector dimensions, or separate RS instances?
