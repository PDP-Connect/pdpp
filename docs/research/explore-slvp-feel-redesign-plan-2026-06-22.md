# Explore SLVP-feel redesign plan (2026-06-22)

Addresses Tim's core critique — *"it doesn't feel nearly as good as SLVP products"* — plus the feedback notes that were dropped (see `explore-feedback-corpus-VERBATIM-2026-06-22.md`). Grounded in NEW visual-feel prior art (`explore-visual-feel-prior-art-2026-06-22.md`, 50 cited sources; the existing ~25 Explore docs cover logic, not feel).

Gate model: this plan → Codex plan sign-off → fan-out build → Codex end-review → deploy → live interactive acceptance (Playwright + darshana). Base: deployed `dcfeb028`, worktree `/home/tnunamak/.tmp/pdpp-deploy`. Commits authored Tim Nunamaker <tnunamak@gmail.com>. No origin push.

## The diagnosis (live critical pass, confirmed)
The feed reads as a **developer console, not a product**: all-monospace body, hairline rows, flat hierarchy, and rows that show `<type>·<source>·<time>` with **no content**. Prior-art verdict: *no SLVP-grade product ships a metadata-only row* — every one (Stripe, Linear, Sentry, Airtable, Notion, GitHub) puts real CONTENT on the primary line.

## Workstreams (each = a build lane, gated)

### W1 — Row anatomy: content-first, scannable (the biggest feel lever)
Prior art (Primer ActionList, Sentry, Stripe, Airtable, Notion, MS Teams feed):
- **Primary line = CONTENT, not a type token.** Use the record's declared primary-title / a body snippet / merchant+amount — what a human recognizes. For records with no declared content, fall back to a meaningful summary, NOT the bare stream name. (Stays on the SLVP honesty path: declared-role-driven; the generic card already exists — surface its best human field as the row primary.)
- **Leading type-glyph in a fixed slot** (Primer: 16px icon area) so rows are scannable by category, content left-aligned to one x.
- **Secondary segment** carries source + type + time *alongside* content (muted), never replacing it. Time right-aligned, abbreviated, recede-able.
- **Whole row is the click target** (peek) — keep the existing peek/Open split but the row itself is primary.
- Keep one-line density where content fits; allow a two-line variant (Primer block description) where a snippet earns it.
- ANTI-PATTERN to remove: the current "messages · peregrine Codex · 31 min · message" shape.

### W2 — Typography + hierarchy: product, not terminal
Prior art (Geist, Primer, Stripe, Raycast, shadcn):
- **One proportional SANS is the row/body default; monospace ONLY for protocol strings** (record IDs, hashes, trace/event IDs, raw JSON, operators). No record-list BODY in mono. (The design system already has `--font-sans` + `--font-mono` — this is about APPLYING sans to feed body text that currently uses mono.)
- **Three tiers, two weights:** primary 14px/500–600 full-foreground; secondary 13–14px/400 foreground; tertiary (meta/time) 12–13px/400 muted ~70%.
- **Numbers = tabular figures** (`font-variant-numeric: tabular-nums`), NOT mono — alignment without the terminal look.
- **Color rationed** to status + links/the interactive primary identifier; everything else neutral foreground/muted ladder.
- **Day/section headers**: smaller + heavier/uppercase label, quieter by color than row-primary but structural by weight.
- Reuse existing tokens (`--space-*`, color tokens, type classes); this is re-mapping weights/families/sizes within the system, not new tokens.

### W3 — Loading feedback at the point of attention (the dropped bug Tim re-flagged)
Prior art (Vercel Geist Spinner, BBC GEL Load-more gold standard):
- Bug: `rr-x-progress` is pinned to top of `rr-x-main` (y:0); the scroll container is `.rr-content`; scrolled-down → loader off-screen above the user. CONFIRMED live.
- FIX: put the pending indicator **at the Load-more trigger** — a spinner in/above the button (Geist: "spinner for buttons, pagination, row-level retries; mount only after the action starts"; GEL: spinner ABOVE the button + ARIA live "loading…" + focus moved to the new content + a "items N to M:" separator).
- Add **skeleton rows at the insertion point** for the appended page (Geist: Skeleton when async data fills a known layout).
- Keep the top progress bar only for full-page route loads (where top IS the attention point), OR make it sticky to the scroll container's viewport. The Load-more case must not rely on it.
- Mobile: same — feedback at the button under the thumb, not page-top.

### W4 — Facet rail + filter/operator unification (two dropped notes: "what do the numbers mean", "confused about filters vs operators")
Prior art (Datadog, GitHub, Sentry, Linear, Notion): ONE model, two surfaces.
- **Clicking a facet writes the equivalent `con:`/`stream:` chip into the shared URL query** (the rail is a query-BUILDER, not a separate system). Editing the query reselects the rail. The chip row is canonical state. This dissolves "filters vs operators confusion" — one thing, two views, always in sync.
- **Group the 70+ stream facets under their SOURCE/connector** (parent→child), collapsible, show-only-non-empty-for-current-result-set, search-within-filters, top-N-then-more. (Needs streamFacets to carry connection association — the deferred F4 data-shape change; do it here.)
- **Counts**: make them result-scoped + dynamic + clearly labeled (Sentry distinguishes result-count from total). Zero-count options hidden/disabled (never dead-end). Resolve "what should the numbers mean".
- **Inversion** = same chip, flipped operator (already have server-side exclude; surface it as `-con:`/`is not`).

### W5 — Sweep the remaining dropped notes (verify + fix)
- (#17) Mobile: row shows a timestamp; tapping reaches detail. RE-VERIFY live, fix if missing.
- (#5/#7) Motion: actually watch the reveal; add the missing feed motion (reduced-motion-gated) if it's not felt.
- (#13) Arbitrary-connector presentation: confirm a generic record renders a meaningful row primary (not the stream name), since most connectors aren't piloted.
- (#11/#19) Confirm "view full stream" link is truly gone from rows everywhere.

## Codex plan sign-off (tmp/workstreams/codex-explore-feel-plancheck.md): DIRECTIONALLY LAND, CHANGES before build — RED LINES folded in below. No second plan gate; Codex end-reviews against these.

### RL1 (W1) — row primary must preserve the declared-role honesty boundary. STRICT source order:
1. declared role-backed slots first (`primary-title`, body/description, amount, actor as applicable);
2. then honest generic key/value from DECLARED fields;
3. then a neutral generic fallback ONLY if no readable declared field exists.
DO NOT use connector-specific stream names, record-kind heuristics, timeline-summaries, or `entry.summary` to infer undeclared body/author/event-time slots. Keep the dcfeb028 partial-role leak CLOSED. "Content-first" must NEVER become field-name guessing. Regression coverage: no-roles, partial-roles, undeclared arbitrary-connector rows.

### RL2 (W4) — facet counts must name their count KIND, never imply unprovable reachability.
Label each count "in result set" / "in loaded results" / "total matching" per what's actually known. If result-scoped or loaded-window-scoped, do NOT present as a source/stream TOTAL. If a click can't reach all rows behind the number, the copy/action must say so. Same count==reachability bar as the redesign, applied to facets. (Resolves "what should the numbers mean".)

### RL3 (W4) — source-grouped stream facets need a STOP CONDITION if data shape is insufficient.
Group streams under sources ONLY if there's honest connector-instance/source identity per stream facet. If `streamFacets` can't prove source membership, STOP and add the minimal data-shape task — do NOT guess, duplicate global stream counts under every source, or build a connector-specific heuristic.

**STOP-CONDITION CHECKED → CLEAR (no new data-shape task needed):** `streamFacets` is a flat `[name, count]` tuple (canvas:1129, with an explicit "grouping deferred" comment), BUT the source identity IS available upstream: `computeStreamFacets` (canvas:310) already reads `data.connections[].streams` + `.connectionId` and internally builds `byName: Map<stream, Set<connectionId>>` (lines 327-337) — it just discards membership by returning `set.size`. FIX = restructure `computeStreamFacets` to emit grouped-by-source facets from that existing membership map. Per-source counts MUST come from `data.feed` filtered by connectionId (the existing `scoped` branch pattern, lines 318-324) = honest "in loaded results for this source" (RL2 label), NOT the global `set.size`. No server contract change.

### RL4 (W3) — loading feedback must be local, accessible, non-destructive.
Pending state at the insertion point AND on/near the clicked button. Skeleton rows must NOT replace already-loaded rows, dim the whole feed, steal focus, or break row interactivity. Assert: when scrolled down, the pending indicator is INSIDE the scroll viewport. Keep reduced-motion explicit; `role=status`/`aria-busy` coverage.

### RL5 (W5) — real live-feel rewalk, not a static assertion.
Acceptance MUST include desktop+mobile, dark+light, scrolled Load-more, row open/tap, facet click-to-chip, query edit-to-rail sync, motion w/ reduced-motion sanity. Record any deferred note + reason. ("verified CSS present" ≠ enough.)

### Test pins (before deploy, per Codex):
content-first row primary w/ declared roles · generic-fallback primary for undeclared connector records · partial-role declares nothing inferred (body/author/event-time/amount) · facet click writes canonical `con:`/`stream:` chip + query edit reselects rail · facet count labels match exact/current/loaded semantics · grouped facets don't duplicate/misattribute counts across sources · Load-more pending visible in scrolled viewport · skeleton rows don't remove/hide loaded rows · reduced-motion no unexpected keyframes · dcfeb028 burst/order/reachability tests pass unchanged.

## Scope guard / non-negotiables
- Reuse design-system tokens/classes; no new tokens or breakpoints; no drop shadows on dark.
- Do NOT touch: count==reachability semantics, the burst newest-first ordering (dcfeb028), the conditional-inspector layout (dcfeb028), server contracts, the RecordroomShell component name.
- Honesty path intact: row primary content from DECLARED roles / honest generic fallback — never field-name guessing.

## Gates (before deploy)
- tsc clean (console + brand-react); all explore + operator-ui + branding tests green + NEW tests for: content-first row primary (incl honest fallback), facet→chip unification, scrolled-load feedback placement (a bounding-box/DOM test that the pending indicator is within the scroll viewport when scrolled), facet grouping.
- ultracite clean; git diff --check clean.

## Acceptance (live, interactive — not just code)
- Desktop + mobile, dark + light: rows carry real content on the primary line; body is sans (mono only for IDs); clear 3-tier hierarchy; feed reads as a product.
- Scroll the feed down, click Load-more → the pending feedback is VISIBLE in the viewport (skeleton + button spinner), not off-screen.
- Click a source/stream facet → a chip appears in the query; the rail and query stay in sync; counts are legible; streams grouped under sources.
- Re-walk the full VERBATIM corpus: every dropped note resolved or explicitly deferred with reason.
