# Parallel audits rollup (2026-06-11) — probed, with corrections

Four Sonnet audits dispatched in parallel, each PROBED by me (the owner's standing rule:
don't trust Sonnet blindly). Corrections below are mine after verification.

## 1. User-facing copy + canonical vocabulary
Doc: `docs/research/user-facing-copy-audit-2026-06-11.md` — **TRUSTED** (probed, accurate).
- 19 defects, full glossary. File:lines verified (D-01 records-list-view.tsx:352 ✅,
  Add source :412/:590 ✅).
- **Corrected MY diagnosis:** the list-view row does NOT show Reconnect for
  source-pressure — `synthesizeConnectionVerdict` suppresses `blocked`
  (`handlingItself:true`, `suppressedBlocked`, connection-evidence.ts:1106-1121,
  guard `isSourcePressureCooldown` L1094). The Reconnect/blocked the owner saw is from
  `deriveFailureSummary` (detail-page expander, L1589) which assigns
  `cta:"reconnect"` to ALL blocked (L1633/1646) WITHOUT the source-pressure guard.
  → Fix is surgical: apply the same `isSourcePressureCooldown` check in
  `deriveFailureSummary`. Narrower + more correct than my original claim.
- Top defects: Sources(n)→Connections(n); "Add source"→"Add connection";
  "Packaged path pending"→"Setup coming soon"; "Existing data only"→"Can't add
  another account yet"; "retryable gap"→"catching up"; "N pending gaps"→"N detail
  items still catching up".

## 2. Brand-package coverage
Doc: `docs/research/brand-package-coverage-audit-2026-06-11.md` — **TRUSTED with
NUMERIC CORRECTION**.
- `packages/pdpp-brand` (`@pdpp/brand`) EXISTS: base.css/app.css/docs.css/chrome.ts,
  ~191 unique CSS custom props (agent claimed 257 — inflated). Single styling
  approach (Tailwind v4 + CSS vars). Shared components in `@pdpp/operator-ui`.
- ✅ `bg-[#...]` arbitrary color brackets = 0 (verified).
- ❌ Agent claimed 49 raw emerald/amber escapes in 15 files; ACTUAL **121
  occurrences in 18 files** (verified `grep -roE '(emerald|amber)-[0-9]{2,3}'`).
  Migration is ~2.5× bigger than the agent's "1.5 dev-days" — DON'T quote that.
- Real bug confirmed: `connector-row.tsx:1239` `#dc2626` hardcoded fallback.
- The 18 files (real migration surface) are listed in the audit doc.
- Architecture IS sound: tokenize the 121 escapes → new design system lands in
  base.css oklch and propagates. The "swap tokens" bar is achievable.

## 3. Screenshot inventory
INDEX: `/home/user/.tmp/ri-ops/screenshots/2026-06-11/INDEX.md` — **TRUSTED**.
- 31 real PNGs (all >20KB, largest 1MB), desktop + mobile, logged-in, full surface.
- I eyeballed dashboard-records-desktop.png myself: confirms "Sources (19)" header,
  NO provider logos (wall of text), two stacked confusingly-related sections,
  status-text soup, weak hierarchy/density, inconsistent per-row CTAs. Real
  problems, not theoretical.

## 4. SDK + UI seams prior art
Doc: `docs/research/sdk-and-ui-seams-prior-art-2026-06-11.md` — **TRUSTED** (paths
verified).
- **5 distinct hand-rolled RS clients** today: mcp-server/src/rs-client.js,
  console ref-client.ts (1855L, /_ref), console rs-client.ts (1166L, /v1),
  cli/src/read/commands.js, polyfill-connectors orchestrator/local-device-client.
  42 non-test files contain raw `fetch(`.
- ~3000 lines of hand-maintained RS types spread across ref-client/rs-client.
- Recommendation: `@pdpp/sdk` promoting `RsClient` (injectable fetch, middleware
  auth, typed error hierarchy, auto-paginating async iterators) + bespoke codegen
  (~150L) emitting `.d.ts` from `GET /v1/schema?detail=full` at build time +
  ESLint `no-restricted-imports` + `scripts/check-sdk-boundary.mjs` CI gate.
  Matches the owner's vana-sdk prefs (isomorphic, dynamic upstream types). North star:
  alternative UI buildable on SDK alone; CLI on SDK only.

## Cross-cutting
The copy `blocked`-mislabel fix (D-07) and the cooldown-starves-recovery class
bug (separate diagnosis doc) are the two code fixes gating the owner's "is it what was
promised" question. The holistic SLVP-ideal whole-system spec (workflow running)
is the gating deliverable the owner asked for at 99% confidence.
