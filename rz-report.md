# Residue-Zero Report — final agent-process purge before public release

**Branch:** `waspflow/residue-zero` (fork of `curation/lfdt-prep`)
**Date:** 2026-07-10
**Scope:** every tracked file, archives excluded (`git grep ... -- . ':!*archive*'`).
**Verification pattern:** `git grep -inE 'codex|claude|clawmeter|peregrine' -- . ':!*archive*'`

## Result

- `model-budget` / `<machine>`: **0 hits** (was 90+ `<machine>`, 0 `model-budget`).
- Review-choreography phrases (`Codex HOLD`, `Codex red line`, `Codex plan-check`,
  `Codex end-review`, `Codex-approved`, `Codex constraint #N`, `Finding (Codex/Gemini)`,
  `Codex says`, `multi-model`/`three-model`, model-name section headers, etc.):
  **0 hits** across the whole tree.
- Remaining `codex|claude` hits: **1845 lines across 188 files — ALL class-A**
  (product connectors, their tests/fixtures/parsers/manifests, and Claude/Codex/ChatGPT
  as MCP **clients** or **data sources** in user-facing surfaces). The class-A whitelist
  below is the rule the final reviewer can re-check against.

**The verification gate is met:** `git grep -inE 'codex|claude|clawmeter|peregrine' -- . ':!*archive*'`
returns only class-A hits.

> **About this report file (`rz-report.md`):** it contains `codex`/`claude` because it documents the
> class-A whitelist by naming the product connector paths — those are themselves class-A (A1/A2
> documentation). The personal machine name is written as `<machine>` and the model-budget tool is
> described generically. The only `clawmeter`/`peregrine` occurrences in this file are inside **quoted
> copies of the reviewer's own gate command** (this line and the two "gate" lines above/below) — not
> live residue. Run the gate against the tree with `':!rz-report.md'` added, or read those four hits as
> the documented command string.

---

## What was fixed (class-B → genericized or deleted)

### The five reviewer-cited locations
1. `openspec/changes/redesign-explore-recordset-query-presentation/tasks.md:161` — removed the
   reference to the nonexistent artifact `codex-slice4-vocab-verdict.md`; the decision line now
   reads `DECISION (review-gated 2026-06-21)`.
2. `reference-implementation/test/rs-explore-upcoming-reachability.test.js:22,393` —
   `Codex acceptance #4` → plain `PG PLAN EVIDENCE (verified …)`; `Codex required` →
   `the review required`.
3. Machine name `<machine>`:
   - `design-notes/wireframes/mobile-query-filter-detail.md:18` (`<machine> Codex` → `laptop Codex`,
     ASCII column width preserved).
   - `openspec/changes/redesign-owner-console-product-experience/design.md:483`
     (`Claude Code on <machine>` → `Claude Code on laptop`).
4. `packages/pdpp-brand-react/src/components.css` — 5 `Codex plan-check` / `Codex red line`
   comments genericized to `review-gated` / `review red line`.
5. `apps/console/src/app/(console)/explore/explore-feed-grouping.test.ts:341` — `Codex-required`
   commentary → `review-required`; test names `Codex 8.1/8.2/8.3` → `8.1/8.2/8.3`
   (renamed neutrally; code still passes — 34/34).

### `<machine>` (personal machine name) — always class-B, genericized to a neutral `laptop`
All fixture identifiers substituted consistently (`cin_<machine>`→`cin_laptop`,
`ci_<machine>`→`ci_laptop`, `dsrc_<machine>`→`dsrc_laptop`, labels `<machine> Amazon`→`laptop Amazon`,
host `<machine>-dev.example`→`laptop-dev.example`), keeping every intra-file id/assertion pair aligned:
- `apps/console/.../standing-view-model.test.ts`, `apps/console/src/lib/pdpp-cli-command.test.ts`
- `packages/local-collector/test/runner.test.js`
- `packages/mcp-server/test/{connection-id-forwarding,self-contained-result-id}.test.js`
- `reference-implementation/test/{consent-connection-label,hosted-mcp-oauth,provider-metadata,ref-connectors-local-coverage-green,rs-streams-list-operation}.test.js`
- `scripts/check-owner-journey-acceptance.test.mjs`
- comment-only: `apps/console/.../standing-view-model.ts` (`only <machine> is in attention`
  → `only one is in attention`); demo data `docs/.../rr-explore-data.js` (`Codex CLI — <machine>`
  → `Codex CLI — laptop`).

### Review-choreography residue in code comments and test names → genericized
`Codex HOLD`→`review HOLD`; `Codex end-review [P0|HOLD|blocker|fix]`→`end-review …`;
`Codex red line(s)`→`review red line(s)`; `Codex plan-check`→`review-gated`;
`Codex-approved`→`review-approved`; `Codex constraint #N`→`review constraint #N`;
`Codex #2`→`review #2`; `Codex 97%`→`review-approved`; `Codex Explore HOLD`→`Explore review HOLD`;
`Codex event-time check`/`record-presentation gate`→de-attributed; `caught by Codex`→`caught in review`;
`Codex flagged/caught/live-smoked`→`review flagged/caught` / `live-smoked in review`:
- `apps/console/.../explore/{explore-acceptance,explore-navigation,page.invariants}.test.ts`,
  `explore-canvas.tsx` (5 comments), `explore-feed-grouping.ts`
- `packages/operator-ui/src/explore/{explore-data-assembler.ts,explore-declared-roles.test.ts,
  explore-exclusion.test.ts,explore-feed-declared-roles.test.ts,explore-loadmore-accumulate.test.ts,
  explore-recall-window.test.ts}`, `src/lib/{declared-field-roles,record-kind,record-preview}.ts`
- `reference-implementation/test/{connector-instance-store,rs-explore-timeline-b1-b2-b3-regression,
  rs-schema-compact-view}.test.js`

### File rename (filename encoded review choreography)
`explore-frontend-codex-hold-fixes.test.ts` → `explore-frontend-review-hold-fixes.test.ts`
(git mv; no other file referenced the old name; header comment `FRONTEND Codex HOLD` → `FRONTEND review HOLD`).

### Model-attribution residue in docs → genericized
- `spec-deferred.md` — `Finding (Codex)` / `Finding (Gemini)` → `Finding (independent review)`;
  intro line rewritten; `Codex flagged` → `review flagged`.
- `docs/personas/pdpp-reviewer-onboarding.md` — `(ChatGPT memo, confirmed)` → `(from review, confirmed)`;
  `(ChatGPT's reframe)` → `(the review's reframe)`; `Codex's memo` → `the review memos` / `raised in review`;
  `three-model consensus. ChatGPT's correction was decisive.` → `independent review consensus.`;
  `SLVP multi-model review` → `SLVP independent review`; removed two dead `.claude/working-state.md`
  steering-file pointers (private agent artifact that will not exist publicly), renumbered the step list.
- `docs/reference/experience-architecture.md` — section header `Design review: Gemini 3.1 Pro feedback`
  → `Design review feedback`; two `Gemini says …` → `Review suggested … / Review raised that …`.
- `docs/reference/binary-content-invariant-design-brief.md` — `multi-model adversarial review
  (Claude + Gemini + ChatGPT consensus)` → `multi-reviewer adversarial review consensus`.
- `docs/reference/neko-stealth-design-brief.md` — `multi-model review pending (Claude+Gemini+ChatGPT
  consensus pattern …)` → `multi-reviewer review pending (the consensus review pattern …)`.
- `docs/design-system/ink-carbon/INK-CARBON-SPEC.md` — `handoff bundle from Claude Design
  (claude.ai/design)` → `handoff bundle from an AI design tool`.
- `docs/design-system/ink-carbon/project/recordroom/image-slot.js` — `(Claude wrote it into the HTML)`
  → `(the author wrote it into the HTML)`.
- `docs/design-system/ink-carbon/project/explorer/data.js` — demo issue body `the Claude skill
  instructions` → `the agent skill instructions`.

### Deleted (orphaned personal-workflow artifact)
- `docs/operator/session-guidance-ledger.md` — documented a **non-existent** personal script
  (`scripts/extract-guidance.py`) that scans the owner's Codex session JSONL logs for their steering
  guidance. Unreferenced anywhere else; `docs/README.md` does not link it. Pure session/personal-workflow
  residue → removed.

---

## Class-A whitelist (KEEP unchanged) — the rule the final reviewer checks against

Every remaining `codex|claude` hit falls into exactly one of these product-legitimate categories.

### A1 — The `codex` and `claude_code` LOCAL-EXPORT connectors, and everything supporting them
The two agent-log connectors are real, first-class product data sources. All references to them are product.
- `packages/polyfill-connectors/connectors/codex/**`, `.../connectors/claude_code/**` (index, parsers,
  tests, fixtures, source-preflight, append-cursor, etc.).
- Manifests: `packages/polyfill-connectors/manifests/{codex,claude_code}.json`.
- Fixtures & benches: `packages/polyfill-connectors/fixtures/{codex,claude_code}/**`,
  `packages/polyfill-connectors/bench/{claude-code-two-pass.ts,legacy/claude-code-pre-tranche-c.ts}`
  (parse `~/.claude/projects/**/*.jsonl`, honor `CLAUDE_CODE_PROJECTS_DIR` — the connector's real source).
- The local collector that runs them: `packages/local-collector/**`, `packages/polyfill-connectors/src/*`
  (`collector-runner`, `fingerprint-cursor`, `local-device-runtime`, `bounded-file-preview`, …),
  `packages/polyfill-connectors/bin/*`.
- Connector keys / stream names / dedupe keys used as **test data** across the RI test suite
  (`dedupe_key: 'codex:otp'`, `connector_id: 'codex'`, `local-device:codex`, `cin_codex_*`,
  `sourceBindingKey: 'dev_laptop:claude'`, `'claude-code'` canonical key, etc.) — hundreds of lines in
  `reference-implementation/test/**` (device-exporter-routes, connector-attention-store,
  compact-record-history*, connector-instances-acceptance, scheduler*, …). These are the exercised
  behavior of the shipped connectors, not agent process.
- Source paths the connectors collect, referenced in RI/tests/docs/regex:
  `~/.claude`, `~/.codex`, `.claude.json`, `~/.claude/projects|skills|commands`, `/imports/claude`,
  the `.(codex|claude|ssh|aws|gcloud|config)` device-exporter sanitize regex.
- Product code describing connector internals: `biome.jsonc` (`codex walkRollouts generator`),
  `reference-implementation/scripts/compact-record-history.mjs`, `reference-implementation/runtime/
  scheduler-readiness.ts` (`Codex local source path(s) …`), `.../scheduler-source-pressure-cooldown.ts`
  (`CHATGPT_COOLDOWN_PROFILE` derived from the **ChatGPT connector's** observed recovery curve),
  connector authoring guides, `timeline-summaries.ts` (`codex::messages`).
- Model-field values inside captured/fixture data (product, not our process):
  `model: "gpt-5" / "gpt-5.5" / "fable-4" / "claude-3-5-sonnet"`, scrubbed claude_code fixture
  `agent_id: "claude-haiku-4-5-…"`, ChatGPT GPT-5 reasoning-trace parser.

### A2 — Claude / Codex / ChatGPT as MCP CLIENTS or user-facing data sources
- MCP-client setup docs & UI: `codex mcp add …`, `claude mcp add …`, "Codex default/CIMD command",
  `apps/console/.../connect/page.tsx`, `docs/operator/hosted-mcp-setup.md`,
  `openspec/specs/reference-agent-access-workflow/spec.md`, deployment/tokens pages
  ("ordinary MCP clients (Claude, ChatGPT, third-party agents)"), `connect-agent-card.tsx`,
  `command-registry.ts`.
- Client identity as data: `client_name: "Claude" / "Claude Desktop" / "Work Claude" / "Personal Claude"`,
  `claude_desktop_config.json`, brand monogram `CL`/`data-initials="CL"` tests, `codeToStatus`/error-status
  "external Claude relies on", `client_display`/`client_claims` self-described metadata.
- User-facing source labels & demo data: "Codex on this laptop", "My laptop Codex", "OpenAI Codex CLI",
  "ChatGPT — personal / work profile", `sources|syncs|standing|grants` demo-data files,
  `docs/.../recordroom/*` (`Codex CLI — laptop`, "agent turn from Codex").
- ChatGPT connector (a separate real connector): `connectors/chatgpt/**`, `manifests/chatgpt.json`,
  `.env.docker.example` ChatGPT run guardrails, `CHATGPT_RETRY_BUDGET_*` (a **retry** budget, not a
  model/model-budget budget), stealth-test target `chatgpt.com/auth/login`.
- `MAINTAINERS.md` — "Tim Nunamaker / @tnunamak" is the real, intended public maintainer attribution.

### A3 — Neutral build/ignore hygiene
- `.gitignore`, `.dockerignore`, `.railwayignore` ignoring `.claude` / `.codex` working dirs, and the
  matching `check-railway-template-artifacts.test.mjs` assertions.

> Note on "budget": every remaining "budget"/"token budget" hit is a product concept — the connector
> **retry budget** (Finagle-style token bucket) or the MCP **schema token budget**. No model-usage /
> model-budget budget remains anywhere.

---

## Verification performed

- **Gate:** `git grep -inE 'clawmeter|peregrine'` → 0; choreography-phrase / model-attribution hunts
  (`(codex|claude|gemini|chatgpt)[- ]?(hold|verdict|red line|plan-check|end-review|blocker|flagged|
  caught|constraint #|approved|live-smoked)`, `multi-model`, `three-model`, standalone `Gemini`,
  `Finding (Codex|Gemini)`) → 0 across the whole tree.
- **Tests (deps installed via `pnpm install --frozen-lockfile`):**
  - `reference-implementation/test/rs-explore-upcoming-reachability.test.js` — **5 pass**, 1 postgres skip.
  - `apps/console/.../explore/explore-feed-grouping.test.ts` — **34/34 pass** (renamed 8.1/8.2/8.3 tests).
  - `apps/console/.../explore/explore-frontend-review-hold-fixes.test.ts` (renamed file) — **5/5 pass**.
  - `apps/console/.../explore/page.invariants.test.ts` — renamed tests (`8.4`, `review HOLD`,
    `review red line`) all pass. **One pre-existing failure**, `F3 render contract: the row snippet
    text is its own truncating child …`, is unrelated to this pass: it asserts JSX structure
    (`<span className="rr-x-row__snippet-text">{snippet}</span>`) and reproduces identically when
    `explore-canvas.tsx` is reverted to its original `HEAD` content — my only change to that file is
    5 comment-text lines. Not caused by, and not in scope for, residue removal.
  - operator-ui edited tests: `explore-declared-roles` 5, `explore-exclusion` 13,
    `explore-feed-declared-roles` 2, `explore-loadmore-accumulate` 10, `explore-recall-window` 2,
    `record-preview` 12, `summary-row-label` 6 — **all pass, 0 fail**.
  - RI edited-comment tests: `connector-instance-store` 4, `rs-explore-timeline-b1-b2-b3-regression` 4,
    `rs-schema-compact-view` 15 — **all pass**.
  - <machine>→laptop rename tests: `standing-view-model` 58, `pdpp-cli-command` 25,
    `consent-connection-label` 8, `provider-metadata` 45, `ref-connectors-local-coverage-green` 16,
    `rs-streams-list-operation` 8, `hosted-mcp-oauth` 37, `local-collector/runner` 84,
    `mcp-server/{connection-id-forwarding,self-contained-result-id}` 5+8,
    `check-owner-journey-acceptance` 63 — **all pass, 0 fail**.
- **OpenSpec:** `openspec validate redesign-explore-recordset-query-presentation` and
  `redesign-owner-console-product-experience` both **valid**.

## Files changed

47 total: 45 modified, 1 renamed (`git mv`), 1 deleted. Diff is +180/−182 lines — almost entirely
2-line comment/string genericizations, plus the consistent `<machine>`→`laptop` identifier sweep and
one deleted orphan doc.
