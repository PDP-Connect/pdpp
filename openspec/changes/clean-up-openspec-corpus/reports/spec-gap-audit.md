# Canonical Spec Gap Audit — 2026-04-24

Scope: compare `openspec/specs/*` to shipped docs, routes, and tests for five areas called out in `clean-up-openspec-corpus/tasks.md §4.1`: **reference architecture**, **retrieval**, **control plane**, **logging**, and **polyfill runtime behavior**.

Finding format: gap name → what's shipped → what's specified → gap → fix here (governance) or follow-up change.

## 1. Reference architecture

### 1.1 Native/polyfill boundary — specified, matches shipped

- Shipped: `reference-implementation/server/*` supports both realizations; native mode bootstraps from `nativeManifest` (tests: `provider-metadata.test.js`, `pdpp.test.js`).
- Specified: `reference-implementation-architecture §Native and polyfill realizations stay honest` + `reference-native-provider-boundary` (2 requirements).
- **Gap**: none structural. Coverage adequate.

### 1.2 Forkable substrate identity — minimal coverage

- Shipped: `reference-implementation/package.json` publishes the substrate; `reference-implementation-identity` has exactly 1 requirement.
- Specified: `reference-implementation-identity §The forkable implementation substrate has a reference-implementation identity` — 1 requirement, short.
- **Gap**: small. The spec asserts identity but does not state what "forkable" guarantees (e.g., runnability without `apps/web`, public manifests, documented startup). `reference-implementation-architecture §The reference implementation remains a forkable substrate` partially covers this with "runnable without `apps/web`," but the two specs overlap without a clear allocation.
- **Fix**: Follow-up consolidation — either merge `reference-implementation-identity` into `reference-implementation-architecture` or expand it with explicit forkability criteria. Not governance; not in this change.

### 1.3 Website bridge contract — specified, narrow

- Shipped: `apps/web/src/app/dashboard/**`, `apps/web/src/app/openspec/**` consume `_ref` + `/v1/*` via bridge routes.
- Specified: `reference-web-bridge-contract` (2 requirements).
- **Gap**: the spec only covers grant bridges and query bridges. Dashboard consumes `_ref/traces`, `_ref/grants`, `_ref/runs`, `_ref/search` lists + detail + timeline — not mentioned in this spec (they appear instead in `reference-implementation-architecture §Reference-only surfaces are explicit`). Bridge spec is technically complete but narrow; dashboard→`_ref` consumption is spec'd from the server side, not the bridge side.
- **Fix**: Follow-up. Not urgent. Dashboard routes are already proven by tests (`control-plane.test.js`).

## 2. Retrieval (lexical + semantic)

### 2.1 Lexical retrieval — well covered

- Shipped: `reference-implementation/server/search.js`, FTS5 index, `/v1/search` route, dashboard search page (`apps/web/src/app/dashboard/search/page.tsx`). Tests: `lexical-retrieval.test.js`.
- Specified: `lexical-retrieval` (10 requirements) + `reference-implementation-architecture` realization requirements (§The reference SHALL realize the lexical-retrieval extension …, §The reference's manifest validator SHALL enforce the v1 `lexical_fields` shape, etc. — 6 requirements).
- **Gap**: none significant. Coverage is both protocol-shape and realization-shape.

### 2.2 Semantic retrieval — specified at contract level, **operational gaps unspecified**

- Shipped: `reference-implementation/server/search-semantic.js` exists but is stubbed; the active change `make-semantic-retrieval-operational` proposes to make it real. Tests: `semantic-retrieval.test.js`.
- Specified: `semantic-retrieval` (12 requirements) + `reference-implementation-architecture` realization (§The reference SHALL realize the semantic-retrieval experimental extension over a single internal enforcement path, etc. — 12 requirements).
- **Gap**: the specs describe *what* the extension must expose but do not cover the operational rails the active change adds:
  - diagnostics readiness vs. corpus participation as distinct reportable states
  - local vs. deterministic-stub backend separation (tests/CI)
  - operator-owned embedding profile configuration
  - multilingual profile support
  - zero-participation warnings on the dashboard
- **Fix**: **follow-up** — these gaps are exactly what `make-semantic-retrieval-operational` exists to fill. No action in this cleanup change beyond flagging.

### 2.3 Retrieval separation (lexical vs. semantic vs. `_ref/search`) — covered

- Specified: `reference-implementation-architecture §The reference SHALL keep /_ref/search distinct from /v1/search` and `§The reference SHALL keep GET /v1/search/semantic distinct from GET /v1/search and from reference-only surfaces`.
- **Gap**: none.

## 3. Control plane

### 3.1 `_ref` read surfaces — covered

- Shipped: `/_ref/traces(:id)?/timeline`, `/_ref/grants(:id)?/timeline`, `/_ref/runs(:id)?/timeline`, `/_ref/search`. Handlers in `reference-implementation/server/ref-control.ts`, tests `control-plane.test.js`, `event-spine.test.js`.
- Specified: `reference-implementation-architecture §The current `_ref` read surface is treated as stable substrate` enumerates exactly the seven routes.
- **Gap**: none. The spec is explicit: the list is exhaustive and new read routes require an explicit OpenSpec change.

### 3.2 `_ref` owner-only mutation — covered

- Shipped: `POST /_ref/runs/:runId/interaction` (recent, test `run-interaction-control.test.js`).
- Specified: `reference-implementation-architecture §Reference control-plane mutations require owner session when enabled` + `§Run interaction control is owner-only and ephemeral` (with scenarios for stale/non-current responses and for no-persist-to-durable-storage).
- **Gap**: none. This is the best-specified area.

### 3.3 Dashboard IA (Overview / Traces / Grants / Runs / Records / Search) — **unspecified in canonical specs**

- Shipped: `apps/web/src/app/dashboard/{traces,grants,runs,records,search}/**`. The Phase 0–5 IA rollout from the `reference-implementation-program` `Deferred` tasks landed and shipped.
- Specified: mentioned implicitly by `reference-implementation-architecture §A future control plane is introduced` ("it SHALL consume the same public or reference-designated surfaces rather than becoming a hidden control path"), but nothing names the IA or the sections.
- **Gap**: the dashboard is now a real operator surface with six sections, and the canonical spec does not bound it. If someone forks the reference, nothing in `openspec/specs/*` tells them what the dashboard must contain or how it relates to `apps/web`.
  - This is **partly** what the active change `define-reference-surface-topology` is trying to address (specifically §2.3 on `/dashboard/**` live-instance posture, noindex, owner-auth).
- **Fix**: **follow-up** — `define-reference-surface-topology` is already queued. The cleanup change should not extend canonical specs ahead of that one.

### 3.4 Peek/detail (`?peek=<id>`) + full-page detail coexistence — **unspecified**

- Shipped: Traces/Grants/Runs list pages support `?peek=<id>` for right-side detail plus full-page `/dashboard/<section>/[id]`. Landed via the "Control-plane IA interaction and Overview hardening" tranche.
- Specified: not captured.
- **Fix**: **follow-up** — the peek pattern is dashboard-shape; belongs inside `define-reference-surface-topology` rather than a new change.

### 3.5 Credibility hero + `GET /_ref/dataset/summary` — **unspecified**

- Shipped: `/_ref/dataset/summary` endpoint backs the dashboard Overview hero (`reference-implementation-program/tasks.md` line 294). No canonical spec requirement.
- Specified: spec enumerates `_ref` read routes (§1.2 above) as exactly seven — and `_ref/dataset/summary` is not in the list. This is a **real drift**: a shipped `_ref` surface is not listed in the spec that claims to bound the `_ref` read surface.
- **Fix**: **governance — fix here** if feasible, or in a narrow follow-up. Two options:
  - **Option A (recommended, in this cleanup change §4.3)**: add `GET /_ref/dataset/summary` as an eighth enumerated `_ref` read route in `reference-implementation-architecture §The current \`_ref\` read surface is treated as stable substrate`. That is governance-only bookkeeping of a shipped surface.
  - **Option B**: narrow follow-up change `align-ref-read-surface-with-shipped-dataset-summary`. Same outcome; more process.

## 4. Logging

### 4.1 Structured request-completion logs — covered

- Shipped: Fastify + `pino` pipeline with `req_id`, method, path, `statusCode`, `responseTime`.
- Specified: `reference-implementation-architecture §The reference implementation SHALL emit a structured completion log for every request` with two scenarios.
- **Gap**: none.

### 4.2 Trace correlation on handler logs — covered

- Specified: `§Request-scoped logs SHALL carry protocol trace correlation`.
- **Gap**: none.

### 4.3 Secret redaction — covered

- Specified: `§The reference implementation SHALL redact known secret paths in log output`. Explicitly enumerates `access_token`, `refresh_token`, device/user codes, `Authorization` header, `interaction_response` payloads.
- **Gap**: none. This is one of the stronger requirements in the corpus.

### 4.4 CLI entrypoint fatal-log handlers — covered

- Specified: `§The CLI entrypoint SHALL produce a final structured log record on crash or signal` with four scenarios.
- **Gap**: none.

### 4.5 JSON shape + OpenTelemetry field-name alignment — covered

- Specified: two requirements (§Log shape SHALL be JSON …, §Log field names SHALL be compatible with the OpenTelemetry log data model).
- **Gap**: none.

### 4.6 Polyfill-connector runtime logging — **unspecified**

- Shipped: `packages/polyfill-connectors/src/safe-emit.ts` plus connector stdout/stderr handling in `scheduler-runner.ts` and `orchestrator.ts`. Emit JSONL with BigInt coercion + U+2028/U+2029 escapes.
- Specified: nothing. The polyfill-runtime emit layer has its own correctness requirements (JSONL validity, BigInt coercion, no secret leakage from INTERACTION_RESPONSE) — none of which are spec'd.
- **Fix**: **follow-up** — part of the polyfill runtime spec gap below.

## 5. Polyfill runtime behavior

### 5.1 Runtime `START / INTERACTION / RECORD / STATE / DONE` contract — **partially covered**

- Shipped: `reference-implementation/runtime/controller.ts`, all 90+ tasks in RIP §"Finish Collection Profile convergence to the current intended contract" done. Tests: `collection-profile.test.js`.
- Specified: `reference-implementation-architecture §The Collection boundary stays explicit` defers normative semantics to the Collection Profile (a root PDPP spec), not to this canonical spec. That is correct.
- **Gap**: the **reference-runtime** side (e.g., what the reference implementation guarantees when DONE arrives before STATE commit, how `run.state_staged` vs `run.state_advanced` are exposed) is partly covered in `§Run timelines expose checkpoint staging separately from checkpoint commit` and `§Runtime validation failures remain inspectable in the reference substrate` — but only as `_ref` timeline visibility, not as normative runtime behavior.
  - If a reader asks "does the reference runtime reject out-of-scope RECORDs?" — the answer is yes (proven by tests), but no requirement in `openspec/specs/*` says so. The corresponding open spec question is enumerated in `reference-implementation-program/design.md` lines 131–141 as things still awaiting normative treatment.
- **Fix**: **follow-up** — some of these questions belong in the root PDPP Collection Profile spec (not OpenSpec). Others belong in a new spec capability `reference-implementation-runtime` that covers reference-specific runtime commitments (scheduler, browser-profile binding, INTERACTION ephemerality, state-commit boundary). Candidate follow-up: `add-reference-runtime-spec`.

### 5.2 Scheduler behavior — **partially covered**

- Shipped: `reference-implementation/runtime/scheduler.ts` + tests (`scheduler.test.js`). `add-polyfill-connector-system` §"Keep using the CLI and black-box tests as truth-serum for the real public/reference contract" captures 10+ scheduler behaviors (single_use consumption, one-active-run-per-connector, disabled skips after deterministic grant-lifecycle failures, etc.).
- Specified: nothing in `openspec/specs/*`. The scheduler is treated as "experimental" and not covered by canonical specs.
- **Gap**: large. Scheduler behavior is proven by tests but has no corresponding requirement text. This is acceptable as long as the scheduler stays experimental; it becomes a real gap once APCS's "scheduler persistence (SQLite-backed `run_history`)" task lands and graduates the scheduler to first-class (APCS proposal §"Modified Capabilities", `reference-implementation-runtime`).
- **Fix**: **follow-up** — belongs in `add-reference-runtime-spec` alongside §5.1.

### 5.3 Browser-profile binding — **unspecified**

- Shipped: `packages/polyfill-connectors/src/browser-daemon.ts`, `browser-profile.ts`, `platform-probes.ts`, `auto-login/*`. Daemon keeps Chromium alive across connector runs.
- Specified: proposed as a new capability (`browser-profile-binding`) in APCS `proposal.md`, but no canonical spec created yet.
- **Fix**: **follow-up** — will land when APCS archives.

### 5.4 Inbox + ntfy notifications — **unspecified**

- Shipped: APCS pending tasks include inbox module and ntfy bridge. `src/ntfy.ts` exists.
- Specified: nothing.
- **Fix**: **follow-up** — part of APCS closeout; not governance.

### 5.5 Runtime filesystem binding — **unspecified**

- Shipped: `buildAvailableBindings` exposes `filesystem: {}` to connectors; enables local-file connectors (whatsapp, google_takeout, imessage, apple_health, ical, twitter_archive).
- Specified: nothing.
- **Fix**: **follow-up** — binding shape is runtime-specific; belongs in `add-reference-runtime-spec`.

## 6. Governance coverage of design-note / OpenSpec hygiene — covered

- Specified: `reference-implementation-governance` has 8 requirements covering authority order, OpenSpec scope, temporary-note discipline, supplemental-note non-canonicity, change lifecycle, design-note discipline, and artifact conciseness.
- **Gap**: none that this cleanup change can close via adding requirements. The cleanup change enforces these rules by deed (archiving completed programs, triaging notes, normalizing headers).

## 7. Governance-only requirements to add in this change (§4.3 candidates)

Per `clean-up-openspec-corpus/tasks.md §4.3`, only **governance-only** missing requirements are added here. Candidates:

### 7.1 Missing: canonical header for design notes SHALL be the root `design-notes/README.md`

- **Shipped**: `design-notes/README.md` defines a canonical header (Status / Owner / Created / Updated / Related) and statuses.
- **Specified**: `reference-implementation-governance §Design notes are disciplined requirements-discovery artifacts` mentions "status, owner, question, context, stakes, current leaning, promotion trigger, and decision log" but does not cite the `README.md` as the canonical source or state that header format.
- **Recommend adding** in this change: a scenario on `§Design notes are disciplined requirements-discovery artifacts` requiring notes to carry the canonical header defined in `design-notes/README.md`, and requiring conflicting ad-hoc headers (like `**Status:** open` / `**Raised:** YYYY-MM-DD` alone) to be normalized at next-touch.
- **Effort**: ~8-line scenario addition. Fits the cleanup change's governance posture.

### 7.2 Missing: `_ref` read-surface enumeration should include shipped `GET /_ref/dataset/summary`

- See §3.5. Either fix here or in a narrow follow-up.
- **Recommend adding** in this change: one line under `§The current \`_ref\` read surface is treated as stable substrate` enumerating `GET /_ref/dataset/summary` as the eighth stable route. Governance-only (bookkeeping of already-shipped behavior against the spec that bounds `_ref`).
- **Effort**: 1-line enumeration plus a scenario that references how the dashboard Overview hero consumes it.

### 7.3 Missing: change-archive hygiene after completion

- **Shipped**: archive dir exists (`openspec/changes/archive/`) and contains prior cleaned-up changes; `openspec archive` command is used.
- **Specified**: `reference-implementation-governance §OpenSpec changes follow a complete lifecycle` covers this at the right altitude already. The "should archive it promptly" language is strong enough.
- **Recommend adding**: nothing. Existing coverage is adequate.

### 7.4 Missing: worker-prompts/design-notes directories inside a change SHALL follow one shape

- **Observed**: only `swap-sqlite-driver` has `worker-prompts.md`; only `reference-implementation-program` and `add-polyfill-connector-system` have `design-notes/` subdirectories. No canonical spec says what a change directory is allowed to contain.
- **Specified**: `reference-implementation-governance §Official OpenSpec artifacts remain concise and parseable` covers `proposal.md`, `design.md`, `tasks.md`, `specs/**` but doesn't address `design-notes/` or `worker-prompts.md` inside a change directory.
- **Recommend adding**: **defer** — this is real governance work but risks bikeshedding. Raise it as a deliberate follow-up (`tighten-openspec-change-directory-layout`) rather than retrofitting here.

## Summary

| Gap | Area | Fix here | Follow-up |
| --- | --- | --- | --- |
| §1.2 forkable-substrate identity overlap | architecture | — | consolidate `reference-implementation-identity` or expand it |
| §1.3 bridge-to-`_ref` consumption | architecture | — | low-priority |
| §2.2 semantic retrieval operational rails | retrieval | — | `make-semantic-retrieval-operational` (active) |
| §3.3 dashboard IA unspecified | control plane | — | `define-reference-surface-topology` (active) |
| §3.4 peek/detail pattern unspecified | control plane | — | folds into `define-reference-surface-topology` |
| §3.5 `_ref/dataset/summary` not enumerated | control plane | **yes** (§7.2) | — |
| §4.6 polyfill-runtime logging unspecified | logging | — | `add-reference-runtime-spec` (new) |
| §5.1 runtime contract visibility | polyfill runtime | — | `add-reference-runtime-spec` (new) |
| §5.2 scheduler behavior unspecified | polyfill runtime | — | `add-reference-runtime-spec` (new) |
| §5.3 browser-profile binding unspecified | polyfill runtime | — | when APCS archives |
| §5.4 inbox + ntfy unspecified | polyfill runtime | — | when APCS archives |
| §5.5 runtime filesystem binding unspecified | polyfill runtime | — | `add-reference-runtime-spec` (new) |
| §7.1 canonical design-note header not spec'd | governance | **yes** (§7.1) | — |

Two governance-only adds for this change, both small:

1. Add a scenario in `reference-implementation-governance §Design notes are disciplined requirements-discovery artifacts` that cites the root `design-notes/README.md` canonical header and requires normalization at next touch.
2. Add `GET /_ref/dataset/summary` to the enumerated `_ref` read surface in `reference-implementation-architecture §The current \`_ref\` read surface is treated as stable substrate`, with a one-scenario justification.

Follow-up changes to queue (in priority):

- **Near-term**: none new; `make-semantic-retrieval-operational` and `define-reference-surface-topology` already cover the active gaps. Close the decomposition from `add-polyfill-connector-system` first.
- **After APCS archive**: **`add-reference-runtime-spec`** — new canonical spec for reference-specific runtime behavior (runtime contract, scheduler, browser-profile binding, inbox/ntfy, filesystem binding, polyfill-runtime logging). This is the largest spec gap in the corpus.
- **Someday-maybe**: `tighten-openspec-change-directory-layout` for uniformity of change-local directories.
