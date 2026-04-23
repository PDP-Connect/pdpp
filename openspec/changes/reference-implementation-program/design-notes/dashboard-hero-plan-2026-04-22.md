# Dashboard hero — implementation plan

**Status:** complete (shipped 2026-04-22; Composition A)
**Date:** 2026-04-22
**Owner:** the owner (supervisor) + agent

## Shipping summary

- New endpoint: `GET /_ref/dataset/summary` (reference-only) returning
  `connector_count`, `stream_count`, `record_count`, three separately-labeled
  byte totals (`record_json_bytes`, `record_changes_json_bytes`, `blob_bytes`)
  summed into `total_retained_bytes`, `earliest_record_time` /
  `latest_record_time` (real-world timestamps mined via each stream's
  manifest-declared `consent_time_field`), `earliest_ingested_at` /
  `latest_ingested_at` (substrate-level `emitted_at` bounds), and a top-3
  `top_connectors` list.
- Tests: 6 new assertions in `reference-implementation/test/control-plane.test.js`
  (empty state; populated aggregates with real-world bounds; soft-delete
  exclusion; record-history separation; unmanifested streams do not
  contribute to record-time bounds; Request-Id correlation). Full
  `control-plane.test.js` suite: 18/18 passing.
- Web: `DatasetSummary` type + `getDatasetSummary()` in `ref-client.ts`;
  `OverviewHero` server-component in `apps/web/src/app/dashboard/components/
  overview-hero.tsx`; rendered above `ActionBanner` on `/dashboard`.
- Contract: `refDatasetSummary` manifest added to
  `packages/reference-contract/src/reference/index.js`; regenerated OpenAPI +
  docs artifacts under `reference-implementation/`.
- Verified on the live DB (772,237 records, 10 connectors, 2.06 GB retained)
  at 1440×900 and 1280×800 — hero + ActionBanner + both Failures panels fit
  first fold on both.
- Empty-state branch verified against a fresh in-memory instance.

## Key decisions applied from supervisor

- `total_retained_bytes = record_json_bytes + record_changes_json_bytes + blob_bytes`.
  Change history is retained by design and counts as "what the substrate is
  holding." Database-file-bytes was considered and rejected as speculative.
- Connector URLs (`https://registry.pdpp.org/connectors/slack`) display as
  their last path segment (`slack`) in the breadth row; full ID preserved on
  hover via `title=`.
- No `streams[].category` manifest taxonomy in v1.
- Composition A shipped (integrated sentence), per the compositions note.
**Related notes:**
- `dashboard-hero-prior-art-stripe-2026-04-22.md`
- `dashboard-hero-prior-art-vercel-2026-04-22.md`
- `dashboard-hero-prior-art-linear-2026-04-22.md`
- `dashboard-hero-prior-art-plaid-2026-04-22.md`
- `dashboard-hero-code-audit-2026-04-22.md`
- `dashboard-hero-synthesis-2026-04-22.md`

## Goal

First fold of `/dashboard` reads, in 5–10s, as: **a real local personal-data substrate with meaningful scale, many sources, long timespan** — without redesigning the control plane or turning into a KPI dashboard.

## Locked decisions (supervisor)

1. **Summary helper**: add `GET /_ref/dataset/summary`. Honest dataset summary, not SQLite internals. Fields:
   - `connector_count`
   - `stream_count`
   - `record_count`
   - `record_json_bytes`
   - `blob_bytes`
   - `total_retained_bytes`
   - `earliest_timestamp`
   - `latest_timestamp`
2. **No `streams[].category` taxonomy in v1.** Breadth comes from connectors / streams / records / timespan / bytes, plus optional top connectors or top streams.
3. **Placement**: hero strip *above* existing Overview content. Compact enough that ActionBanner + Failures panels remain in the first fold on a normal laptop. **Not a grid of cards.**
4. **Anatomy callout**: generic, explanatory — clarifies the model, never clever.
5. **Live stats** with short TTL caching if needed.
6. **Owner constraint**: no category strip. Replace that space with a **quieter secondary breadth row** (not more tiles).

## Design direction (synthesized from SLVP + constraints)

Three horizontal bands, typographically restrained, no card chrome:

1. **Headline band (dominant)** — one composed sentence integrating retained records, connector breadth, timespan, total retained bytes. Single line on desktop, wrap on narrow viewports. Number-face larger than surrounding text; labels muted; monospace for numerals so the line stays stable across values.
2. **Quiet breadth row (secondary)** — top N connectors/streams inline, comma-separated or bullet-separated, small muted text, identity dots (Linear pattern) for visual variety without chart chrome.
3. **Anatomy callout (ambient)** — one generic explanatory sentence in the smallest register, muted, explaining the grant → run → stream → record → inspectable-JSON flow.

No sparklines, no deltas, no percentages, no cards, no tiles, no icons larger than identity dots.

## Success criteria

The hero is correct when:
- First fold on a 1440×900 laptop shows hero + ActionBanner + at least the top of the Failures panels.
- Every stat is live from `/_ref/dataset/summary`.
- Empty instance (zero records) degrades honestly — no fabricated numbers, no skeleton placeholders.
- Unreachable reference server degrades in the same register already established by `ServerUnreachable`.
- A skeptical engineer reading the hero can, within two clicks, verify a claimed number against real JSON (via `/v1/streams`, `/_ref/traces`, etc.).
- The anatomy callout is literal enough that a reader understands the protocol shape from the sentence alone.

## Scope

### In scope
- New reference-server endpoint: `GET /_ref/dataset/summary`.
- Tests for the new endpoint (black-box integration, shape stability, empty-state).
- New typed client call in `apps/web/src/app/dashboard/lib/ref-client.ts`.
- New hero component in `apps/web/src/app/dashboard/components/` (name TBD during composition pass).
- Updates to `apps/web/src/app/dashboard/page.tsx` to render the hero above existing content.
- Short TTL caching on the web side if the aggregate computation exceeds ~200ms in practice.
- Empty-state and unreachable-state coverage.

### Out of scope
- Manifest-level `streams[].category`.
- Sparklines, deltas, % trends, or any chart.
- Stat tiles or card grid.
- Connector logos.
- Personalized anatomy sentences.
- Broad Overview redesign beyond the hero band.

## Open questions that must be answered during the composition pass

These are not implementation blockers; they are composition decisions to settle before code:

1. **Headline wording** — candidate templates:
   - A. `12,847 records · 9 connectors · since 2022-07-03 · 184 MB retained`
   - B. `184 MB across 12,847 records from 9 connectors · since 2022-07-03`
   - C. composed prose sentence: `Holding 184 MB across 12,847 records from 9 connectors since 2022-07-03.`
2. **Secondary breadth row shape** — top-3 connectors (most-records) with record counts, or all connectors inline, or stream-level breakdown?
3. **Anatomy callout wording** — one sentence, literal. Candidate: *"Each approved grant issues runs that write records into streams; every record is inspectable as raw JSON through `/v1/streams`."*
4. **Numeric formatting** — thousands separator style, byte-unit rounding (binary vs. decimal), date format (ISO vs. locale). Recommend ISO dates + decimal byte units + thin-space thousands for consistency with developer-tool register.

Two concrete composition proposals (A/B) will be produced before any TSX is written.

## Work breakdown

### Phase 0 — resolve open composition questions

1. Produce two full composition proposals (text + annotated layout) labeled A and B.
2. the owner picks one (or requests a blend).
3. Update this plan's "decisions" section with the locked composition.

### Phase 1 — reference server helper

1. Read existing `_ref` handler patterns in `reference-implementation/server/index.js` (mirrors `/_ref/traces`, `/_ref/grants`, `/_ref/runs` style).
2. Add `GET /_ref/dataset/summary` returning the eight fields above. Implementation:
   - `connector_count` from connector registry
   - `stream_count` from manifests or derived count
   - `record_count` from `SELECT COUNT(*) FROM records`
   - `record_json_bytes` from `SUM(LENGTH(payload_json))` or equivalent (confirm during implementation)
   - `blob_bytes` from `SUM(size_bytes) FROM blobs`
   - `total_retained_bytes = record_json_bytes + blob_bytes`
   - `earliest_timestamp`, `latest_timestamp` from `MIN/MAX(emitted_at) FROM records` (or event-spine equivalent if more honest)
3. Return `Request-Id` + `PDPP-Reference-Trace-Id` correlation headers, consistent with other `_ref` responses.
4. Treat it as reference-only (not a PDPP protocol surface), documented in the README alongside existing `_ref` helpers.
5. Handle empty instance honestly: zeros and `null` timestamps, not omitted fields.

### Phase 2 — reference server tests

1. Black-box integration test: shape + field presence + numeric correctness on a seeded fixture.
2. Empty-state test: zero records returns zeros + nulls, not 500.
3. Correlation-header test: `Request-Id` + `PDPP-Reference-Trace-Id` present.
4. Re-run full reference test suite to confirm no regressions.
5. Regenerate contract artifacts (`pnpm reference-contract:generate`) and confirm the new endpoint surfaces under `/openapi/reference-full.openapi.json` as reference-only.

### Phase 3 — web client wiring

1. Add `getDatasetSummary()` to `apps/web/src/app/dashboard/lib/ref-client.ts` with typed response shape.
2. Confirm the dashboard-access gate (`PDPP_ENABLE_DASHBOARD` / `VERCEL`) still governs visibility — no new gating path.
3. Add short TTL caching only if real latency exceeds ~200ms (measure first, don't premature-optimize).

### Phase 4 — hero component

1. Compose a new component matching the locked Phase 0 composition. Use existing brand tokens from `packages/pdpp-brand/base.css`; do not introduce new CSS variables.
2. Typography: reuse `pdpp-title` / `pdpp-label` / `pdpp-heading` where they fit; otherwise inline Tailwind with existing tokens.
3. Identity dots (if used in the secondary row): reuse existing color channels (no new palette).
4. Empty-state branch: honest copy per composition.
5. Unreachable-server branch: pass through the same `ServerUnreachable` pattern that already covers nested Records routes (per `control-plane-v1-follow-up.md`).

### Phase 5 — `/dashboard/page.tsx` integration

1. Render hero above `ActionBanner`.
2. Load summary in parallel with existing fetches; don't serialize.
3. Tune vertical rhythm so a 1440×900 viewport still shows hero + ActionBanner + top of Failures panels.
4. Remove the current subtitle line if the hero absorbs its job; otherwise keep and tighten spacing.

### Phase 6 — verification

1. Start dev server; confirm first-fold composition on 1440×900 and 1280×800 viewports (manual browser check — cannot be asserted by type-checking alone, per skepticism guideline).
2. Confirm empty-state rendering by temporarily clearing the local DB or using a fresh checkout.
3. Confirm unreachable-server rendering by stopping the reference server.
4. Grep for every string / token changed; read each touched file end-to-end (per the "after any naming/cleanup task" discipline).
5. Run `pnpm --dir reference-implementation test` + web tests.
6. Run `pnpm reference-contract:check-generated` to confirm generated artifacts are current.

### Phase 7 — documentation

1. Update `reference-implementation/README.md` `_ref` section to document the new endpoint explicitly as reference-only.
2. Update `control-plane-implementation-plan.md` v1 done-state notes with the hero addition.
3. Mark this plan note `Status: complete` with a pointer to the implemented commit/PR.

## Verification strategy (skepticism-first)

Per steering constraints, build → test the full user journey myself → prove each honesty claim:

- Every number the hero displays must be reachable by one or two clicks from the hero itself (`records` → `/dashboard/records`; `connectors` → records index; timespan → earliest record; bytes → documented in `_ref` surface).
- Every claimed field in the endpoint must be provable against the underlying SQL I actually wrote — no guessed sums.
- Empty-state and unreachable-state branches must be exercised manually in the browser before the work is called done.
- After-naming discipline: grep for `dataset/summary`, `getDatasetSummary`, any new component name across the repo before declaring done.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| `record_json_bytes` is expensive on large DBs (full table scan of `LENGTH(payload_json)`) | Measure during Phase 1; if slow, add an indexed sum-maintenance path or accept a slightly stale cached value with documented TTL |
| Empty-state reads as "broken" rather than "fresh" | Explicit copy per composition — test this branch before calling done |
| Hero pushes operator content below fold on small laptops | Design compact; verify on 1280×800; if it fails, shrink hero typography before moving operator content |
| New `_ref` surface drifts from the existing shape of `/_ref/traces` etc. | Follow the header/response conventions already established; add schema to contract artifacts; test correlation headers |
| Adding a bytes claim creates a new surface that must remain honest as the reference evolves | Keep the endpoint reference-only and documented; never promote to public `/v1/*` without rethinking |

## Timeline estimate

- Phase 0 (compositions + pick): 1 session
- Phase 1–2 (server + tests): 1 session
- Phase 3–5 (web wiring + component + integration): 1 session
- Phase 6–7 (verify + docs): 1 session

Total: ~4 focused sessions assuming no scope creep into categories / sparklines / tiles.

## Agent vs. direct-work split

- **Direct (agent does the work)**: composition proposals, server endpoint, web component, integration, verification. These are judgment-heavy and/or require full context.
- **Sub-agents**: targeted use only — e.g., `kieran-typescript-reviewer` after the TSX lands, `design-implementation-reviewer` on the rendered hero against SLVP references, `best-practices-researcher` for any narrow tooling question that surfaces during implementation (e.g., numeric formatting convention for dev-tool UIs). Research pass is already done; no further research delegation in this tranche.
