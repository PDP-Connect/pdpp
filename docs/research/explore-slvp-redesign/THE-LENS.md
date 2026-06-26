# THE LENS — Explore + data-trust: one filter to assess and progress

**What this is.** The consolidated standard for the owner-console **Explore** surface (and the
data-honesty model it lives inside), distilled from everything we set: the owner's verbatim feedback (the
6/18 walkthrough + the 6/22 corpus), the SLVP-ideal whole-system spec, the full-visibility
set-descriptor contract, the record-presentation invariants, and the 12-dim visual benchmark. It
exists so neither of us has to re-explain the bar — run any change through Part A; track where we are
with Part B.

Sources (authoritative): the owner's private walkthrough feedback (verbatim walkthrough) ·
`explore-feedback-corpus-VERBATIM-2026-06-22.md` · `explore-full-visibility-spec-2026-06-19.md` ·
`explore-slvp-recommendation-synthesis-2026-06-19.md` · `record-presentation-ideal-2026-06-22.md` ·
`slvp-ideal-whole-system-spec-2026-06-11.md` · `explore-slvp-redesign/{01-rubric,02-target,03-critic-verdict}.md`.
Non-authoritative (corroboration only, flagged inline): `inbox/spencer_convo_PDPP Recordroom UX Direction.pdf`.

---

## The one sentence

> **Explore is a record workbench over the owner's data that NEVER lies about what it shows, lets the
> owner reach and make sense of ALL of it, and looks like a product — not a dev console.** Every number
> is reachable, every label is earned (declared or honestly generic), the full power is one intelligent
> search away, and the surface meets the Stripe/Linear/Vercel/Plaid bar in real interaction.

Three failure modes it exists to prevent: **(1) the trust breach** — a count, title, or claim the data
doesn't support; **(2) the bounded cage** — caps, dead-ends, or controls that can't reach the whole;
**(3) the dev-console feel** — monospace walls, metadata-only rows, raw-JSON dumps, debug copy, flat
hierarchy. (The owner, 6/18: *"this doesn't feel like a real product… an inspired hallucination of a product."*)

The bar is generalized, not connector-specific: it must hold for **arbitrary connectors, present and
future** — never per-connector hardcoding, never guessing meaning from names.

---

# PART 0 — THE REGRET CHECK (run BEFORE you show the owner anything)

The gates below tell you if a change is SLVP-grade. This part tells you something different and more
useful: **will the owner push back based on something he has ALREADY expressed?** A change can pass every gate
and still draw negative feedback because it tripped a *pattern in how the owner reacts*. Run this first. If you
can't answer "no" to every question with evidence, fix it or flag it before delivering — do not let the owner
be the one to find it.

These generalize from the owner's own words across the 6/18 walkthrough + 6/22 corpus. They apply to ANY
surface, including ones he never explicitly walked (he said the defects are systemic: *"if we went
through all of those, we would generate an equal amount of feedback"*). When in doubt, assume the
pattern applies.

**The meta-traps (these draw the HARDEST feedback — check them first):**
- [ ] **Did I claim something is done/verified that I only checked in code, not by living in it?** "Verified
      the CSS is present" ≠ "watched it and it feels right." If I haven't interacted with it live (desktop
      + mobile), I say so — I do not present it as done. *(This is the owner's #1 trust trigger.)*
- [ ] **Would the owner ask "what problem is this solving and why is this the best solution?" and not have an
      answer?** Unjustified design reads as *"feels wrong"* even when the info is useful. Every element
      earns its place or it's cut.
- [ ] **Does it feel "vibe-coded / like a hallucination of a product" rather than a real product?** If a
      reasonable person would sense it was assembled fast without a coherent story, it fails before any gate.
- [ ] **Did I confirm the declared-content path is actually LIVE — not just present in code?** A row that
      falls to the honest-generic / identity-key fallback looks IDENTICAL whether the record is genuinely
      undeclared OR the role/manifest pipeline silently broke (wrong path, empty map, missing bundle, a
      build that resolves a dir relative to the wrong cwd). "Honest generic everywhere" can be a disguised
      pipeline failure wearing honesty's clothes — and it passes the eye test, because a quiet muted row is
      exactly what an undeclared record SHOULD look like. So before calling content "honest," prove a
      POSITIVE: pick a connector/stream I KNOW declares a title (`x_pdpp_role: primary-title`) and verify on
      the LIVE surface that its real content renders. Absence-of-lies is not enough; I must see the declared
      path succeed for a record that should exercise it. *(2026-06-25: manifest roles were silently
      unavailable in production for WEEKS — a cwd path bug made every row fall back to its UUID — and every
      unit test passed because `buildRecordPreview` was correct; it just never received the roles. Only a
      live walk that asked "why is THIS row a UUID when its manifest declares a title?" caught it.)*

**The recurring irritation patterns (each is a thing the owner has flagged more than once):**
- [ ] **Wasted space / copy that doesn't justify itself.** Helper text, instructional prose, accordions,
      horizontal rules, "Names overlap across connections," "Pick a record to read it in full" — if it
      doesn't earn its vertical space against an SLVP product's restraint, cut it.
- [ ] **The same thing represented two ways.** One state, one representation (the date-shortcut showing
      both a highlight AND a "Since 2026-…" box; a count shown two ways). Redundant representation = defect.
- [ ] **Anything that reads as machine/AI output to a human.** Walls of debug text, raw JSON when better
      is provable, AI-slop copy, hedge words like "actually," developer labels ("MATCH:", "HYBRID",
      deprecated-alias warnings). Human understanding first; evidence on demand.
- [ ] **A number that doesn't reconcile or doesn't mean what it says.** Counts that disagree across
      surfaces, "capped," "collection count unavailable," collected-vs-checked conflation. If a number is
      on screen, I can defend exactly what it counts and that it's reachable.
- [ ] **A control that's broken, ignored, or useless.** A button that does nothing (Jump-to-ID), an Open
      that's indistinguishable from a row click, multi-clicks that drop, a manual refresh for something
      that should auto-update. If an affordance exists, it works and it's distinct.
- [ ] **Meaning guessed from names/shape instead of declared signal.** Any title/render that would be
      wrong for a different connector. It must hold for arbitrary connectors or it's a latent objection.
- [ ] **The same record looking different in two places.** Explore vs stream-table vs Sources divergence.
- [ ] **Naming/URL/vocabulary inconsistency.** Nav says one thing, URL/ID says another; implementation
      nouns leaking to the owner; a view whose URL doesn't reflect its state.
- [ ] **"It doesn't feel as good as SLVP products when you actually interact."** The catch-all. If I
      haven't done the side-by-side against the product-UI baseline shots and a real interaction pass, I
      have not earned the right to say it's good — and the owner will be the one who finds the gap.

**The rule:** the owner-feedback corpus is *not* a finite bug list to clear; it is "baseline discovery evidence" of
how he evaluates. Generalize the pattern, not the instance. The goal of this section is that when the owner
opens what I deliver, there is *nothing he has already told me about* left for him to find.

---

# PART A — THE FILTER (run every change through this, in order)

Four gates, in order. A change ships only if it clears Gate 1, then 2, 3, 4. **Gate 1 is absolute: a
capability or feel win that breaks an honesty invariant does not ship.** Each checkbox is testable on
the live surface — if you can't test it, it isn't done.

> **NEW Gate-1 invariants from the design round (2026-06-23, all Codex-LAND'd; see `../explore-design-cells/`):**
> - **Date filter (date-controls):** ONE honest statement of the active window — end-behavior legible
>   (sliding `Last 7 days` / growing `Since Jun 12` / fixed `May 1–May 14`); ALL boundaries in the
>   owner's LOCAL tz; `until` inclusive through 23:59:59.999 local, `since` from 00:00:00 local; never a
>   boundary that lies about which records are in/out.
> - **Over-time chart:** bars state TRUE per-bucket totals over the filtered grant-scoped corpus
>   (`window=exact`), local-tz bucketed to MATCH the feed's day-grouping; brush writes the ONE canonical
>   `(since,until)` object; unit + set-kind captioned; empty buckets shown; no bar implies unreachable
>   data. "Most recent N records" loaded-only labeling is a reachability lie. **The caption's unit MUST
>   match the bars' actual bucket span — a label/data mismatch is a (small) honesty violation, not just a
>   polish miss.** If the server can return a granularity the client's label ladder doesn't carry, the
>   client coerces it to the nearest label and the caption LIES. *(2026-06-25: the full-corpus view showed
>   yearly-spaced bars captioned "by month" with tooltips "January 2019" — the client `BucketGranularity`
>   type lacked `year`/`quarter`, so the server's yearly buckets were mislabeled as monthly. The label
>   ladder must cover every granularity the server emits.)*
> - **Sort:** key ONLY on a server-DECLARED-sortable field (today: the stream's `cursor_field`/time
>   direction) — no amount/name/sender sort (the cardinal sin); sort NEVER changes membership; never
>   exceeds the descriptor (relevance_bounded has no in-set sort); wire `sort=`/`order=` stays internal.
> - **Record identity:** rendered through ONE shared cell on every surface (feed/table/card/detail) —
>   declared-or-honest-generic title, no field-name guessing, identity keys never the visual title lead,
>   primary never mono / key+timestamp mono, amounts only when currency-declared, image marks from the
>   reliable blob signal — enforced ONCE, not re-derived per surface.
> - **Copy + default URL:** owner-facing copy carries zero engine vocabulary (no "hybrid/lexical/
>   semantic/consent-time"); the default "All" view is the BARE canonical path with NO query params
>   (defaults never serialized), and that bare path is a real shareable URL — locked by regression test.

## GATE 1 — HONESTY (hard invariants; violating any one = do not ship)

**Counts, reachability, and caps**
- [ ] **Count == reachability (SACRED).** Every number shown is fully reachable through the UI. Never
      shrink a count to be "honest" (the 188→32 cop-out is a *straight violation* — make 188 reachable).
- [ ] **No artificial caps — paginate instead.** Never tell the owner the data is "capped from the most
      recent N." Performance is *not* a license to cap or hide records (6/18: *"It shouldn't be capped…
      comes at too high a cost"*). If a set is large, page it; never truncate-and-claim-complete.
- [ ] **No dead-ends.** No surface presents a bounded result as complete. Removing a truncation/honesty
      label is only allowed in the SAME change that adds the working path to the full set.
- [ ] **Counts reconcile across surfaces.** The same stream's count must agree wherever it appears
      (Sources card, Explore sidebar, stream table). "1,183 records" on Sources vs "6 orders" in Explore
      is a trust break (6/18). One count, one source of truth.
- [ ] A count must name its KIND when it isn't a true total ("N in view", "loaded", "matching") and
      distinguish *collected/net-new* from *checked* (6/18). A tab/facet count is a live number or a
      transient loading placeholder — never a static dash presented as a value.

**Claims (the set-descriptor contract)**
- [ ] Every result set self-declares `{kind, ordering, completeness}` and the UI is CONSTRAINED by it.
      A set may only claim what its descriptor supports:
      `complete_chronological`→"Everything, newest first" · `relevance_bounded`→"Top matches" (never
      "newest first", never a fake Load-more) · `keyword_pageable`→"Keyword matches" (real cursor) ·
      `filtered_exact`→"Your filtered set: N records" (true total, fully reachable).
- [ ] No control renders an ordering/completeness its descriptor lacks. Search stays GLOBAL top-N
      (never per-source quotas). Hybrid/relevance is first-page-only by design — never fake deep paging.

**Labels, titles, and rendering (presentation authorship)**
- [ ] Display titles are **manifest-authored** (declared `x_pdpp_role`) OR a **neutral, visibly-generated
      fallback**. Never client-authored, never a template the client evaluates.
- [ ] **No field-NAME meaning-guessing.** "There's a field called `subject`, so that's the title" is
      FORBIDDEN. The only allowed selection among undeclared fields is data-SHAPE ranking (entropy,
      word-boundaries, cardinality, type) — which reads zero field names.
- [ ] **Render richly from RELIABLE signals only — never from guessing.** When the system reliably knows
      a record's type/shape (e.g. it contains an image), render it richly (show the image), not raw JSON
      (6/18: *"with guarantees, not through guessing where we could often get it wrong"*). Rich rendering
      must never sacrifice the system's generality/power, and never dump raw JSON when better is provable.
- [ ] Identity keys (id/uuid/`*_id`) NEVER become a title or H1. Detail H1 order: declared title →
      first content sentence → record key (mono, secondary). Raw snake_case/UUID is never an H1.
- [ ] **No over-disclosure.** A scoped/granted view shows only what was granted — only those fields,
      streams, time-window. No leakage of unrequested data, no "bonus connector." (Validated by the
      third-party client-agent memo as the property the protocol actually keeps.)
- [ ] Amounts are declared-only — no fabricated/prototype values ship.
- [ ] Saved views are USER-AUTHORED named queries. Guessing which streams are "money"/"messages" by
      name is the **cardinal sin** — never ship guessed presets.

**Copy & typography as honesty signals**
- [ ] Monospace (JetBrains Mono) ONLY for machine values: timestamps, ids/keys, amounts-as-columns,
      operator-syntax tokens, keyboard hints (⌘K). NEVER in titles, search input, chip labels, prose
      excerpts, section headers (VIEWS/CONNECTIONS/COLLECTION/SHARING/SERVER), status tags (IN VIEW,
      SCHEDULED), nav/button labels, human connection/source names, or app-version chrome ("this server ·
      pdpp 0.1.0"). **The dev-console "technical label" look comes from UPPERCASE + letter-spacing on
      SANS — not from mono.** When chrome needs to read as a quiet structural label, reach for
      uppercase-tracked sans (the day-header treatment: 11/600 uppercase muted), never mono. *(2026-06-25:
      ~35 chrome/label selectors had been set to mono purely to get that "label" feel — the single biggest
      "reads like a dev console" signal. The fix is font-family only; the uppercase/tracking stays.)*
- [ ] **No walls of debugging text, no AI-slop copy.** The owner is never confronted with a wall of
      debug detail or unreadable system copy (6/18). Trust copy reads human, not machine-generated —
      no hedge words like "actually" (4/15). Human understanding first; technical evidence on demand.
- [ ] **URL reflects state.** Every search/filter/sort change updates the URL; the default view is a
      real, shareable URL (6/18: the default currently has no query params = bug). The URL is the share
      primitive — a "copy this view" affordance rides on it.

**Zero-results & state**
- [ ] Zero-results explains pre-filter match vs post-filter removal with non-contradictory counts
      ("matched 25, but role:assistant removed all"), and offers escape actions WITH real counts.
- [ ] (Console-wide, where Explore touches health) one authoritative verdict; never render `blocked`
      over a recovering source-pressure cooldown; "100%/done" only when nothing pending/floored/terminal.

## GATE 2 — THE WORKBENCH (can the owner actually work the data?)

Explore is a *workbench*, not a viewer. These are capability requirements — each was an explicit
6/18 ask. Search/sort/filter must reach SLVP-ideal; "the controls for searching here are not great"
is a fail.
- [ ] **One intelligent search input** is the universal entry: free text, IDs, AND operators all go
      through it. "Why can't you just search for an ID?" — ID lookup is search, not a separate broken
      "Jump to ID" field.
- [ ] **Operators have UI affordances** — never hand-typed syntax as the only path. Intelligent,
      value-aware **autocomplete** (operators + real values + counts) teaches the query language in-flow.
- [ ] **Rich sorting** — beyond newest/oldest; consider multiple stacked sort keys. Sort must stay
      correct under a filter across load-more (no row stuck at the bottom).
- [ ] **Date controls are honest & single-representation** — a specific-date picker exists; a shortcut
      ("30 days") highlights only itself and shows its effect ONE way, not two redundant representations.
- [ ] **Multi-select that honors every click** — mixing connections/streams must register all rapid
      clicks during load latency (optimistic/queued state), never "only the first one is honored."
- [ ] **Load-more accumulates** — previously shown rows never disappear when more load; the auto
      group/collapse/expand must feel good and follow SLVP prior art, not collapse disorientingly.
- [ ] **An interactive over-time visualization that doubles as a filter** — restore it (it existed, was
      dropped for performance; 6/18: *"I don't think the solution was to get rid of it"*). SLVP/observability
      products (Datadog) are the references.
- [ ] **Peek/detail never scrolls the owner away** — opening a record's detail must not jump the page so
      they "have to scroll back up."

## GATE 3 — THE THREE HONEST MODES (is the workbench whole, and consistent?)

Explore composes three modes; the owner always knows which they're in because the set says so. A
change must not break the seams — or the cross-surface consistency.
- [ ] **Browse everything** — recent/timeline feed, day-grouped, exhaustively reachable to the end
      (point-in-time-stable cursor; "N new" pill, not auto-insert; burst-collapse for high-volume days).
      The unified cross-source timeline IS the sovereignty view. *(Independently corroborated by the
      non-authoritative Spencer review: "make Explore feel like searching/reconstructing a personal
      timeline across many sources, not browsing raw records.")*
- [ ] **Search** — one global ranked result-set, presented as a SORTABLE/FILTERABLE object (count never
      shrinks across orderings), with a clearly-labeled escape: **"Browse all matching records, newest
      first"** that exits to the exhaustive chronological surface with the query applied.
- [ ] **Per-entity full lists** — every count/source has a one-click "See all N" to the exact-total
      paginated stream page. No dead-ends; escape ramps always live.
- [ ] **One unified record presentation everywhere** — a record looks and renders the SAME via Explore,
      the stream table, and Sources; stream/connection info shown in Explore vs Sources must not diverge
      (6/18: divergence "is actually confusing me"). The Explore-vs-stream-table relationship is a
      settled, prior-art-grounded decision, not two parallel half-views.
- [ ] Forbidden shapes: a discovery feed that dead-ends · a raw cross-source firehose as the PRIMARY
      browse surface · "computed answers over your data" (assumes schema PDPP doesn't own).

## GATE 4 — SLVP FEEL (does it read as a product? ≥4/5 on all 12, target 5)

Measured against Linear · Raycast/Stripe · Vercel-Geist/Primer · Superhuman · Things3.
**Acceptance discipline (the owner's red line): feel is verified by LIVING IN the UI (desktop + mobile,
real interaction, Playwright/darshana) and by a side-by-side against the prior-art product-UI shots —
NEVER by "the CSS is present."** Every surface must justify its problem→solution; "feels wrong" or
unjustified design is a fail even if the info is useful.

1. **Hierarchy** — title is the one dark line; ≤1 muted meta token competes. Two text colors total.
2. **Typography** — tight 3-tier sans scale; zero mono leak into the reading surface.
3. **Toolbar/composition** — ONE command-bar; scoped controls disclosed; no redundant Search button;
      no verbose instructional copy that doesn't justify its vertical space.
4. **Autocomplete** — value-aware (operators AND real values AND live counts) in-flow of the one input.
5. **Chips** — [property][operator][value], one-click negate, suggested vs active separated; no mobile clip.
6. **Row scannability** — leading glyph + content title + ≤2 meta (≤3–4 data points); no field walls,
      no `Color:`/`Index:` decorative-field-as-title; render images/known types inline where reliable.
7. **Zero-results** — routing, not a contradiction (see Gate 1).
8. **Chronology/upcoming** — calm crafted day-grouping (with year); Upcoming labeled + structured.
9. **Search-hit** — prose excerpt with the matched term bolded; no uuid-as-primary, no "MATCH:"/HYBRID label.
10. **Detail/peek** — starts at content; H1 = display title (never a raw key); clean field table;
      updates on keyboard nav; opening it never scrolls the owner away.
11. **Beauty/feel** — passes the dev-console test outright; calm, one accent, spacing-as-separator;
      varied spatial rhythm (ledgers/timelines/strips), not "cards on cards of equal weight."
12. **Mobile** — full-screen push, one list, ≤3 fixed chrome rows, row timestamp present, tap reaches
      detail, filter state visible+editable at 390px.

**Craft constants (the fixed answers, so we don't re-litigate):** sans = Schibsted Grotesk, mono =
JetBrains Mono; two text colors `#171717`/`#8f8f8f`; one accent `#0055cc`; row title 14/500, meta
12/400, day-header 11/600 uppercase muted; spacing-as-separator (gap between day groups, no per-row
rules); 2-pane desktop (224px sidebar + main, 360px peek) / full-screen push mobile; placeholder
"Search or filter…" not a syntax tutorial.

**The VISUAL BASELINE — diff the live render against the actual prior-art shots, not just prose.**
27 screenshots in `docs/research/slvp-benchmark-2026-06-23/shots/` (catalogued in that dir's
`MANIFEST.md`) + 5 written reports. The shots are not equal:
- **PRODUCT-UI shots (the real baseline — diff rows/feed/list/filters against these):**
  `linear-changelog-new-ui-desktop` (sidebar + issue list + filter bar) · `vercel-changelog-
  deployments-list-{desktop,mobile}` (dense feed: status dots, commit msgs, env badges) ·
  `superhuman-blog-inbox-ui-desktop` (list rows: sender / subject / AI-summary bar) ·
  `primer-action-list-{top,scrolled}-desktop` (selection states, dividers, leading/trailing visuals,
  group headers) · `things3-homepage-{desktop,mobile}` (calm chronology + near-empty rows).
- **TOKEN sources (where the type/color/space constants came from — diff exact values):**
  `vercel-geist-typography-desktop`, `vercel-geist-colors-desktop`, `primer-typography-desktop`,
  `primer-color-desktop`, `primer-relative-time-desktop`.
- **Marketing/landing heroes (WEAK for a UI diff — don't over-index):** stripe/raycast/superhuman/
  linear homepage + article shots. Useful for brand feel, not row anatomy. (MANIFEST flags capture
  caveats: Raycast/Stripe product pages timed out, so several are heroes not app UIs.)
Acceptance for Gate 4 means a literal side-by-side of the LIVE Explore (desktop + mobile) against the
PRODUCT-UI shots above — not "looks SLVP-tier to me."

---

# PART B — THE SCORECARD (live state, honest)

Live = `v0.16.1-8-g8a7b128ad` (deployed; CONTENT-IDENTICAL to `origin/main` tip `dc74d18dc` after PRs
#59 + #60 merged 2026-06-25). The 5 design cells are EXECUTED + shipped; the over-time chart is BUILT,
deferred off first paint, and live. **The 2026-06-25 perf+visual sweep closed the headline gaps:** load
7.1s→2.4s (FCP 44ms), 0 bare-UUID rows (manifest roles were silently broken in prod — see the Part-0
declared-path-is-live trap), chrome de-mono'd to sans, chart honestly captioned "by year". Verification
levels: **DOM** = measured live · **code** = verified in source · **eye** = screenshot only ·
**UNVERIFIED** = claimed not checked · **OWED** = known gap.

**Open frontier (post-2026-06-25, low-priority — enrichment, not the dev-console failure):**
Vercel-style status-dot/badge/pill row vocabulary (NOTE: PDPP records have no honest universal "status"
to show — copying it would invent a vocabulary the data lacks, which Gate-1 forbids; the honest
equivalent is the kind-glyph + source/stream labels we have). The over-time chart is honest + brushable
but a plain volume band, not a richly-styled activity chart. Side-by-side vs the product-UI shots done
2026-06-25 (`tmp/workstreams/slvp-final-comparison-2026-06-25.md`): the dev-console failure is RESOLVED.

## Gate 1 — Honesty
| Invariant | Status | Note |
|---|---|---|
| count==reachability (feed/sidebar/tabs) | DOM | "All 32" = visibleFeed; exclusion shrinks count |
| no artificial caps / paginate instead | UNVERIFIED | "capped from the most recent N" copy must be gone live — **recheck** |
| counts reconcile across surfaces | OWED | the 1,183-vs-6 Sources/Explore class not re-verified |
| no dead-end / bounded-as-complete | code | escape ramps + set-descriptor shipped |
| set-descriptor constrains claims | code | descriptor union drives header/sort/Load-more; not re-DOM-verified |
| manifest titles, no name-guessing | DOM | declared-roles path LIVE-verified 2026-06-25: codex/messages → real content, GitHub PR titles, Slack authors; 0 bare-UUID rows; empty-declared → "(no content)"/"(no subject)". (Was silently BROKEN in prod via a cwd manifests-dir bug — fixed in PR #60.) |
| render richly from reliable signals (images) | OWED | inline image/type-aware rendering not built |
| keys never title/H1; H1 fallback order | DOM | detail H1 fix e62ac7bc; broader live sweep OWED |
| no over-disclosure (scoped views) | code/PARTIAL | field-withhold server-declared+honest; per-CONNECTION scope is connector-TYPE approximation, not server-enforced (page.tsx:25-29) |
| amounts declared-only | code | enforced |
| saved views user-authored, no guessed presets | DOM | All + user tabs only; inactive tabs no count |
| mono only for machine values | DOM | title/input/chip sans; time/id/count/⌘K mono. 2026-06-25: de-mono'd ~35 chrome selectors (section headers, nav labels, status tags, human names, app-version, footer) → sans; computed-font-family verified live (PR #60) |
| no debug walls / no AI-slop copy | PARTIAL | no MATCH:/HYBRID badge or JSON-dump; BUT feedDescription leaks "Hybrid retrieval (lexical+semantic)…" prose (explorer-utils.ts:660) |
| URL reflects state | PARTIAL | every action updates URL; but the DEFAULT view is bare /dashboard/explore (no params) — buildHref(path,{}) |
| zero-results honest routing | code/eye | shipped; not re-walked live |

## Gate 2 — Workbench (PHASE-0 AUDIT @ deploy 36d51f49 — mostly BUILT)
| Capability | Status | Evidence / gap |
|---|---|---|
| one input = free text + ID + operators | **BUILT** | detectRecordIdJump folds ID into the single QueryInput → inline "↵ Jump to record"; not a separate box |
| operator affordances + value-aware autocomplete | **BUILT** | buildTypeaheadSuggestions: operators + real source/stream values + counts. Gap: counts are "in view" not totals; no date-value completion |
| rich/multi-key sorting | **PARTIAL** | only newest/oldest (+ relevance/recent in search). No field sort, no stacked keys → **design via prior art** |
| honest date controls + specific-date picker | **PARTIAL** | shortcuts highlight only-self ✓ BUT no date picker, AND redundant highlight + "Since 2026-…" chip → **design** |
| multi-select honors every rapid click | **BUILT** | optimisticSelectionRef composes each toggle synchronously before transition; N clicks compose |
| load-more accumulates; grouping | **BUILT** | nextAccumulatingTrail keeps prior rows; day-group + burst preview/collapse |
| interactive over-time chart that filters | **BUILT** | volume band over `extent.count` (true full-corpus total), brushable → canonical `(since,until)`, suppressed during search, empty buckets shown. Deferred off first paint (loads post-mount, 3.6s aggregate no longer blocks the feed). Honest unit caption (by year/quarter/month/week/day/hour). DOM-verified live 2026-06-25 (PRs #59) |
| peek never scrolls owner away | **BUILT** | in-place 3rd-column inspector via peek param; feed stays mounted |

## Gate 3 — Three modes + consistency (PHASE-0 audit)
| Item | Status | Evidence / gap |
|---|---|---|
| Set-descriptor contract (the honesty engine) | **BUILT** | all 4 kinds produced + UI switches on descriptor.kind (header/sort/Load-more); `never` guard |
| no artificial caps (paginate) | **BUILT** | FEED_TOTAL_CAP=32 is per-page only; default feed is complete_chronological w/ has_more; acceptance test forbids "capped" copy |
| Browse everything (exhaustive to the end) | PARTIAL | built; exhaustive-to-end not re-proven live |
| Search as sortable/filterable object + labeled escape | code | escape present; reaches-last-record OWED to verify live |
| richly render reliable signals (images) | **BUILT** | RecordInspector renders <img> from server-declared blobAffordance |
| ONE unified record presentation | **PARTIAL** | feed-row / peek / detail-page SHARE buildRecordPreview+RecordInspector ✓; the per-stream LIST TABLE is a separate raw-column path → **unify via shared brand components** |

## Gate 4 — SLVP feel (this pass: DOM + 3 screenshots)
All 12 dims measured ≥4 on the live DOM (most 5) for the visual layer. **Caveats keeping this from a
real "pass":** the rubric AND scores are self-authored — **no independent reviewer has scored the LIVE
result** (only the prototype was multi-model reviewed); dims 4/7/10/11 are eye/code, not lived-in; no
real-interaction session; no side-by-side vs the product-UI baseline shots.

## DESIGN COMPLETE (2026-06-23) — 5 cells, all Codex-LAND'd at >95%, they COMPOSE
The remaining design work is DONE. Each cell = `../explore-design-cells/<cell>/{prior-art.md,design.md}`,
prior-art-grounded + adversarially reviewed to LAND. Integration pass confirmed they compose (one
canonical `(since,until)` object; one shared `RecordIdentity`; one URL contract; no layout contention).
"Nothing unbuilt in terms of design." Status flips to EXECUTION.

**Execution sequence (conflict-avoiding — all 5 share explore-canvas.tsx, different regions):**
1. **date-controls** FIRST — owns the canonical `(since,until)` contract + widens `setRange({since,until})`
   + removes the redundant `rangeLabel` chip. Everything depends on it.
2. **over-time-chart** — consumes the widened `setRange`; retires the legacy ActivityStrip; inserts the
   volume band. (Uses the already-shipped `window=exact` aggregate — cheap.)
3. **sort** — single-key (prior-art + server both say so; stacked would error); makes `oldest` a server
   re-page (fixes a real reachability bug: client-reverse can't reach the bottom).
4. **record-components** — centralizes identity into one `RecordIdentity` cell across feed/table/card/
   detail (parallelizable — touches record-body, not controls).
5. **honesty-copy** LAST (the lock) — strips engine vocabulary from 4 leak surfaces; adds the regression
   test locking bare-default-URL = "All", no param injection (the integration guardrail).

Out of Explore scope (flag to protocol team): per-connection scope is connector-TYPE-approximated, not
server-enforced.

## Then VERIFY (not design — execution-time gates)
- **Independent live review** — adversarial pass (Codex gpt-5.5 + a 2nd model) scoring the DEPLOYED
  surface against this lens; closes the "self-authored verdict" hole.
- **Lived-in feel pass + side-by-side vs the product-UI baseline shots** (`slvp-benchmark-2026-06-23/shots/`).
  the owner's red line: "verified the CSS ≠ watched it and it feels right."
- Confirm still-open verbatim items: motion *watched* (F7), facet-count meaning (F8), Open-vs-row (F12),
  branding restored + instance-configurable (F21).

---

## How to use this
- **Before delivering ANYTHING to the owner?** Run **Part 0 — the Regret Check** first. Its job is that the owner
  finds nothing he's already told me about. If any box can't be a confident "no," fix it or flag it —
  never let the owner discover it.
- **Building?** Walk Part A top-to-bottom; Gate 1 is non-negotiable; Gate 2 (Workbench) is where the
  unbuilt product value is.
- **Assessing "are we there?"** Part B is the live truth; the OWED list is the path. "Done" means the
  OWED list is empty AND the owner has lived in it — not "all gates green on my own say-so."
- This doc is the contract and the single source of truth for the bar. A new standard/aspiration/
  feedback from the owner lands HERE (verbatim) first, then flows to implementation. Non-authoritative input
  (e.g. outside designers) may be folded in ONLY as clearly-tagged corroboration, never as steering.
- **Part 0 is a living list:** every time the owner gives negative feedback that a check would have caught,
  the gap goes here so it's caught next time — the regret check only earns its name if it keeps learning.
