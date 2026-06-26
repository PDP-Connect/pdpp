# Design — honesty-copy + URL-state cleanup (cell, >95% execution-ready)

Pinned tip: deploy tree `<deploy-worktree>`, tip **36d51f49**, branch
`workstream/explore-feel-integration`. Every file:line below was verified by content on this tip.
Live Explore is rendered by `apps/console/src/app/dashboard/explore/explore-canvas.tsx` (page.tsx:43,
125 mount `<ExploreCanvas>`); the shared copy helpers live in
`packages/operator-ui/src/components/views/explorer-utils.ts`. Both `records-explorer-view.tsx` and
`explore-canvas.tsx` consume the same `feedDescription` helper, so a fix in `explorer-utils.ts` lands
on every path at once.

This cell has **three leak surfaces** (the Phase-0 audit named only the first) plus **one URL item**:

| # | Leak | File:line (verified) | Live? |
|---|------|----------------------|-------|
| L1 | `feedDescription` prose — "Hybrid retrieval (lexical + semantic), deduplicated by record key. Public search results do not yet carry connection identity…" | `explorer-utils.ts:656,658,662,664` (+ jargon "consent-time field" :652) | YES (canvas:3369) |
| L2 | Per-row badge renders raw `{entry.retrievalMode}` = "lexical"/"semantic"/"hybrid" | `explore-canvas.tsx:1626` (`rr-x-row__rel`) | YES |
| L3 | `RetrievalBadge` renders raw mode + "Found by hybrid retrieval (experimental)." tooltip | `records-explorer-view.tsx:851-866` | NO (legacy view path) |
| L4 | Search-fallback **warning** leaks engine prose: `message:"Hybrid retrieval was advertised but failed; fell back to lexical. <err>"` + visible `code` "hybrid unavailable" | warning pushed `explore-data-assembler.ts:1741-1744`; rendered live by `WarningList` `explore-canvas.tsx:981-986` (`w.message` + `w.code.replace(_," ")`); legacy `records-explorer-view.tsx:689` | YES (failure path only) |
| U1 | Default view is bare `/dashboard/explore` (no params) | `buildExplorerHref(routes, {})` → `explorer-utils.ts:625`; canvas `buildHref(explorePath,{})` :1957/2582 | YES |

(L4 added after adversarial review — Codex caught a fourth leak surface the Phase-0 audit and the
first design draft both missed. Verified by reading the code on tip 36d51f49.)

---

## 1. Prior art applied (see `prior-art.md`)
- Search framing: name **relevance / matches / newest-first-escape**; never the engine
  (Linear/Algolia/Stripe). The "developer-told-you" retrieval badge/sentence is the named
  anti-pattern; internal critic verdict already said cut it.
- Default URL: the **canonical route IS the shareable default-view identity** (Linear). Serializing
  implicit defaults (`?lens=recent`) is the anti-pattern — it creates a second representation and
  breaks `isAllView`.

## 2. Canonical-state check (the highest-value step — this drives U1)
The URL is already the single canonical view state. **`isAllView(href) = canonicalViewIdentity(href)
=== ""`** (`explore-saved-views.ts:76-77`). `canonicalViewIdentity` (`:52-68`) strips only
`VOLATILE_PARAMS = {peek, cursor, cursors, ucursors, anchor}` and treats **every other param as a
filter**. Therefore the **bare `/dashboard/explore` is the canonical identity of "All"** — there is
exactly one representation today, and it is the Linear-correct one.

Lens derivation confirms the empty URL is a real, fully-functional state, not an accident
(`explore-data-assembler.ts:2039-2098`): with `q="" since="" until=""` → `lens="recent"` → the merged
exhaustive timeline (`descriptor.kind="complete_chronological"`, `completeness:"exhaustive"`,
`explore-data-assembler.ts:1154-1160`). Counts/`has_more` come from the fetched feed, NOT from URL
inspection — so URL params do not change what the default feed shows or counts.

**Decision: DO NOT inject canonical default params.** Adding `?lens=recent` (or `?sort=newest`) would
(a) duplicate state (bare path AND param-form both mean "All" — Part-0 "same thing two ways"), and
(b) break `isAllView` unless `lens` is also added to `VOLATILE_PARAMS`, after which the param is
purely cosmetic noise on a copied link. Both are net-negative. **The 6/18 note "the default view
doesn't have any query parameters" is satisfied by making the bare default an honest, legible,
shareable canonical state — not by serializing defaults.** Concretely the cell asserts/locks the
invariant and surfaces the existing share affordance; see U1 below. (This is the same conclusion the
date-controls pilot reached for "one canonical object" — here the canonical object is the empty
identity `""`, and we must not create a rival representation of it.)

## 3. Honesty semantics (what the replacement copy may TRUTHFULLY claim)
- **Default `recent` feed** = merged exhaustive timeline across visible connections, newest first,
  pages to the end (`complete_chronological` / `exhaustive`). The replacement copy MAY say "newest
  first" and "across your sources" but must NOT claim it is *all* your data in an absolute sense
  (a connection can be unscoped/withheld). Keep "every visible connection" — true and already used.
- **`time_range` feed** = time-anchored, only streams that declare a data-time field; others excluded.
  True today but worded in dev jargon ("consent-time field", "the owner's data time"). Rephrase to the
  same fact in human terms; the exclusion is a real honesty caveat and must survive.
- **`search` / `search_with_ignored_time_window`** = relevance-ranked, bounded (`relevance_bounded`
  cannot page to the end; `descriptorHasMore` is structurally false, canvas:2448). Copy MAY say "best
  matches", MUST NOT say "newest first" or imply completeness, and MUST preserve the time-window-not-
  applied caveat for the `_with_ignored_time_window` lens (a real boundary fact). It must NOT name the
  engine. The labelled escape door **"Browse all matching records, newest first"** (canvas:1202) is the
  honest exit and is untouched by this cell.
- **Per-row badge (L2/L3):** the engine mode per row carries **zero user-actionable meaning** and is
  the named anti-pattern → **remove the visible badge entirely**. Do NOT humanize it into "best match"
  (that would re-introduce a redundant per-row label competing with the row's own match excerpt).
  Keep the *data field* `entry.retrievalMode` — it still gates `matchExcerpt` (canvas:1559) and search
  ordering; only its **rendering** is cut.

## 4. THE DESIGN — exact copy (before → after) + URL approach

### L1 — `feedDescription` (`explorer-utils.ts:650-667`). Collapse the hybrid/lexical fork; remove all engine words.
`hybridUsed` becomes unused by this function → **drop the parameter** and update **both runtime
callers**: the live canvas (canvas:3369 → `feedDescription(data.lens)`) AND the legacy view
(records-explorer-view.tsx:338 → `feedDescription(lens)`). These are the only two render callers;
the only other references are tests (`explorer-url.test.ts:291,300-308`), handled in §5. (Keep
`data.hybridUsed` flowing elsewhere — it still drives `mostRelevantSearchResult` exhaustiveness at
explore-data-assembler.ts:1652/1976; only this copy function stops reading it.) ABI alternative: keep
`hybridUsed` as an ignored param and assert equal copy for true/false — no honesty difference; default
is to drop it.

| Lens | BEFORE (leak) | AFTER (honest, human) |
|---|---|---|
| `time_range` | "Time-anchored across every stream that declares a consent-time field, sorted by the owner's data time. Streams without a declared time field are excluded." | **"Records from your sources in this date range, newest first. Sources without a time field aren't shown here."** |
| `search_with_ignored_time_window` (was 2 variants) | "Hybrid retrieval (lexical + semantic). The time window in the URL is not applied to search…" / "Lexical retrieval. The time window…" | **"Best matches for your search across your sources. The date range isn't applied to search — clear the search to browse by date."** |
| `search` (was 2 variants) | "Hybrid retrieval (lexical + semantic), deduplicated by record key. Public search results do not yet carry connection identity, so rows are scoped to the connector unless exactly one connection of that type is configured." | **"Best matches for your search across your sources, ranked by relevance."** |
| `recent` (default) | "Recent across every visible connection. Submit a query, or pick a date window, to narrow further." | **"Recent activity across your sources, newest first. Search, or pick a date range, to narrow."** (light edit: "connection"→"sources" for owner vocab; drop nothing true) |

Notes: the *"connection identity / scoped to the connector"* sentence is DELETED from user copy. It
describes a real public-search limitation, but it is (i) mechanism-leak and (ii) not actionable by the
owner; per THE-LENS "evidence on demand", it belongs in a code comment / docs, not the result surface.
The `search` time-window caveat is preserved (it IS owner-actionable: "clear the search"). No
monospace; sentence case; no "actually"/hedge words.

### L2 — per-row retrieval badge (`explore-canvas.tsx:1626`). DELETE the rendered badge.
- BEFORE: `{entry.retrievalMode && <span className="rr-x-row__rel">{entry.retrievalMode}</span>}`
- AFTER: *(removed)* — the row already shows the match excerpt ("Match" + bolded term, canvas:1596-1618)
  and source/stream/time. The engine token added nothing. Leave `entry.retrievalMode` in the data model
  and its use at canvas:1559 untouched. Optionally drop the now-unused `.rr-x-row__rel` CSS rule
  (residual, §6).

### L3 — `RetrievalBadge` (`records-explorer-view.tsx:851-866`, legacy path). DELETE the component and its callsite.
- It renders raw `{entry.retrievalMode}` with a "Found by hybrid retrieval (experimental)." title.
  Remove the component + its render site. Not live, but in-scope to keep the honesty fix consistent
  across surfaces (Part 0: "the same record looking different in two places").

### L4 — search-fallback warning (`explore-data-assembler.ts:1741-1744`). Rewrite the warning to non-engine copy.
The warning fires only when hybrid search was advertised but threw, falling back to lexical — a real,
owner-relevant event (results may be narrower), but it must say so WITHOUT engine words. Two coupled edits:
- BEFORE: `code:"hybrid_unavailable"`, `message:"Hybrid retrieval was advertised but failed; fell back
  to lexical. ${describeError(err)}"`.
- AFTER: `code:"search_coverage_reduced"`, `message:"Some search coverage was unavailable, so these
  results may be narrower than usual. Try again shortly."` (The raw `describeError(err)` detail is
  dropped from owner copy — it is debug evidence; log it server-side instead.)
- The visible `code` line `WarningList` renders (`canvas:983-984`, `w.code.replace(_," ")` → "search
  coverage reduced") is now human; the legacy `records-explorer-view.tsx:689` render inherits the same
  honest message+code. No engine word reaches the user on the failure path.
- Scope note: this is a 2-string edit in the assembler; it does not change WHEN the warning fires or
  the fallback behavior (still falls back to lexical). Reachability/descriptor untouched.

### U1 — default-view URL. KEEP the bare canonical path; lock it as an invariant + ensure it is a real shareable default.
- **No code change to make params appear.** The bare `/dashboard/explore` stays the canonical "All"
  identity (§2).
- **Add a regression test** (below) asserting `isAllView("/dashboard/explore") === true` and that the
  default `buildExplorerHref(routes, {})` / `buildHref(explorePath, {})` emit NO querystring — locking
  the canonical-state contract against future "let's add params" regressions.
- **Shareability (CONFIRMED in review):** the existing **"copy view link"** affordance already turns a
  bare `/dashboard/explore` href into an absolute shareable URL — verified against the code in the
  adversarial review (it is not suppressed on the default). So "the default view is a real shareable
  URL" is already TRUE; no code change is needed for shareability. The cell only needs to (i) NOT
  regress it by injecting params, and (ii) lock it with the regression test below.

## 5. Executable test matrix (all must pass)
Test files: `apps/console/src/app/dashboard/explore/explorer-url.test.ts` (feedDescription),
`explore-saved-views.test.ts` (isAllView), `page.invariants.test.ts` (source-regex no-leak guard).

1. **No-engine-words on RENDERED COPY (NEW, the core honesty lock).** The forbidden-token regex
   `/hybrid|lexical|semantic|embedding|BM25|deduplicat|consent-time/i` (note: "retrieval" REMOVED from
   the token list — see below) is asserted ONLY against **string OUTPUTS the user sees**, never against
   whole-source (whole-source would false-positive on the intentionally-retained type
   `retrievalMode?: "lexical" | "semantic" | "hybrid"` at explorer-utils.ts:56 and the data-field use at
   canvas:1559 — Codex caught this). Concretely assert over:
   (a) every `feedDescription(lens)` return value (runtime call, all 4 lenses);
   (b) `emptyFeedMessage(lens)` + `feedSectionTitle(lens)` return values;
   (c) the L4 warning `message` AND its derived visible code-label
   `"search_coverage_reduced".replace(/_/g," ")` (assert the literal warning object in the assembler has
   no forbidden token in `code` or `message`);
   (d) a tight source-regex in `page.invariants.test.ts` that the JSX *render expressions*
   `rr-x-row__rel` (canvas) and `RetrievalBadge` (legacy) are ABSENT — i.e. grep for the specific
   render lines, not the word "retrieval". "retrieval" is excluded from the token regex precisely
   because it appears in retained code comments/identifiers; the render-absence assertions (d) cover the
   badge leak directly instead.
2. **INVERT the broken existing test.** `explorer-url.test.ts:300` currently asserts
   `feedDescription("search", true) !== feedDescription("search", false)`. After dropping `hybridUsed`,
   that signature is gone; replace with: search copy is a single string containing "best matches" and
   NOT "newest first". Keep the recent/time_range equality intent (they were always hybrid-independent).
3. **Non-empty + human.** Every lens returns a non-empty sentence-case string (preserve :291-295 intent).
4. **Caveat preserved.** `feedDescription("search_with_ignored_time_window")` still contains "date
   range isn't applied" (or equivalent) so the boundary fact survives.
5. **Descriptor claim preserved.** Assert search copy never contains "newest first" / "all" /
   "complete" (relevance set must not claim ordering/completeness it lacks); `recent`/`time_range` copy
   MAY contain "newest first" (they are time-ordered). The escape door string
   "Browse all matching records, newest first" (canvas:1202) is unchanged.
6. **Per-row badge gone.** `page.invariants.test.ts` source-regex: `explore-canvas.tsx` contains NO
   `rr-x-row__rel` render of `{entry.retrievalMode}`; `records-explorer-view.tsx` contains no
   `RetrievalBadge`. `matchExcerpt = entry.retrievalMode && !snippet` (canvas:1559) STILL present
   (data-field use is intact — guards the existing :200 assertion).
7. **isAllView default.** `isAllView("/dashboard/explore") === true`; `canonicalViewIdentity("/dashboard/explore") === ""`.
8. **Default href emits no params.** `buildExplorerHref(routes, {}) === routes.section.explore` (no
   "?"); analogous for canvas `buildHref(explorePath, {})`. (Locks U1: forbids the param-injection anti-pattern.)
9. **No-regression: feed reachability unchanged.** Default-feed count/`has_more`/descriptor identical
   before/after (copy/URL changes touch presentation only) — covered by existing
   `explore-default-feed-performance.test.ts` / `set-descriptor.test.ts` staying green.
10. **L4 warning honest (NEW).** Assert the search-fallback warning object pushed in
   `explore-data-assembler.ts` has `code:"search_coverage_reduced"` and a `message` containing no
   forbidden engine token and no `describeError` raw detail. (Search the assembler test suite for an
   existing hybrid-fallback test to update; if none, add one driving the catch branch with a throwing
   `searchRecordsHybrid` stub and asserting the new warning copy. Warning STILL fires — only its copy
   changed.)

## 6. Bounded residual (<5%, no correctness impact)
- Removing the now-dead `.rr-x-row__rel` CSS rule is optional cleanup (no behavior change if left).
- Exact final wording of the four `feedDescription` strings may be tuned ±a few words at execution
  (the constraints — no engine words, preserve the two caveats, no false ordering claim, owner
  vocab "sources" — are fixed; the prose within them is bounded).
- (Shareability of the bare default is CONFIRMED working in review — no residual there; see U1.)
- L4 warning closes with "Try again shortly" — fine for the transient catch-path it guards; if the
  fallback is later found to stem from a persistent capability gap, soften to "Results may be narrower
  than usual." (wording-only; the no-engine-word + no-raw-error invariants are fixed). Flagged by review.
- The `feedDescription` `hybridUsed` param removal is mechanical (1 fn + 2 callers + 1 test signature);
  if a reviewer prefers keeping the param for ABI stability, it may stay as an ignored arg — no honesty
  difference. (Default: drop it; dead params are clutter.)

## 7. Self-critique vs THE-LENS Part 0 + Gate 1
- **Part 0 "reads as machine/AI output" (HIT, now fixed):** L1 prose + L2/L3 engine badges + L4
  warning ("Hybrid retrieval… fell back to lexical" / visible "hybrid unavailable") were the exact
  "developer labels (MATCH:, HYBRID)" pattern. All four removed/rewritten, not merely softened. L4 was
  surfaced by adversarial review — the lesson (a warning is owner-facing copy too) is folded in here.
- **Part 0 "same thing two ways":** explicitly avoided by REJECTING canonical-default params — the
  empty identity stays the single representation of "All".
- **Part 0 "URL doesn't reflect its state":** addressed honestly — the canonical empty URL *is* the
  default state (Linear pattern); the actionable half ("real shareable URL") is met via the existing
  copy-link affordance, not via cosmetic params.
- **Gate 1 "no debug walls / no AI-slop copy":** L1/L2/L3 close it; the NEW source-regex guard prevents
  re-leak.
- **Gate 1 "URL reflects state; default is a real shareable URL":** met without breaking
  count==reachability (feed data is URL-param-independent for the default lens — verified) and without
  breaking `isAllView` "All" detection (no new non-volatile param).
- **Gate 1 set-descriptor contract:** preserved — search copy says "best matches"/relevance, never
  "newest first"/"complete"; the time-window caveat and the chronological escape door are untouched.
- **Residual honesty hole acknowledged:** the *public-search-has-no-connection-identity / scoped-to-
  connector-type* limitation is now absent from user copy. This is correct (mechanism + not
  owner-actionable), but the underlying per-connection-scope approximation is a real protocol gap —
  flagged in THE-LENS Part B item #5 as out-of-Explore-design scope, NOT silently dropped.

## DEFINITION OF DONE — pixel gate (lighter — this is a copy/behavior cell)
Not a row-anatomy cell, so no product-shot diff needed. DONE = the live surface shows the replacement
copy (no engine vocabulary anywhere a user can see), the default bare-URL "All" behavior holds, AND a
human (the owner) reads the live copy and confirms it sounds human/product, not machine/AI — per THE-LENS
Part 0 ("AI-slop copy"). Grep-for-forbidden-strings is the floor; the human read is the gate.
