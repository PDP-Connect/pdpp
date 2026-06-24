# Tasks — Explore RecordSet / query / presentation redesign

Sequenced as vertical slices (reachability first). Each slice: reproduce-the-bug test →
(cursor/keyset/contract machinery) dual-owner Codex gate → deploy → verify live, on the
deployed Explore lineage (branch `explore-slvp-high-fixes`, base `e87222ce`). Build does
NOT start until Codex and Claude align this change is SLVP-ideal at >95% AND considers all
owner feedback (the design-approval gate). Mark tasks honestly as work lands.

## 0. Design gate (before any build)
- [x] 0.1 Codex adversarial review of this OpenSpec change (proposal/design/spec/tasks)
      whose explicit job is to prove it is under-researched, AI-slop, or locally-clever-
      not-SLVP. Verdict to `tmp/workstreams/codex-explore-recordset-design-review.md`
      (HOLD, ~93%, 4 P0 + 2 P1 required edits).
- [x] 0.2 Resolve every blocking finding; re-review until Codex + Claude both confirm
      ≥95% SLVP-ideal AND all owner feedback considered. Record the confirmation.
      APPLIED (round 1, `c5d8b1bb`): P0#1 search-result-set honesty (spec: relevance_bounded/
      keyword_pageable/chronological classes + 2 scenarios; design §1.2). P0#2 lower_bound
      discipline (spec requirement + scenario; design §1 normative note). P0#3 server/client
      RecordSet boundary (spec requirement + scenario; design §1.1). P0#4 type-vs-role two
      axes (spec body + 2 scenarios; design §5.2 axes/multi-role/paired/labels). P1#1
      prior-art matrix committed (`design-notes/prior-art-interaction-matrix.md`, linked from
      design intro + §1.2). P1#2 wireframe gate added (§1b below).
      APPLIED (round 2, `2a4c4fd6`): cond-1 committed the 4 referenced research docs so the
      evidence package is self-contained; cond-2 fixed proposal + design §5.3 role/type
      wording (TYPE gates formatting only; event-time/amount are declared slots, not
      type-promoted); editorial: matrix source claim softened.
      CONFIRMED: Codex round-2 verdict = FULL LAND / IMPLEMENTATION APPROVED at `2a4c4fd6`
      (owner-feedback 97%, SLVP 96%, Slice-1 readiness 97%); + Claude. Both ≥95% =
      design implicitly approved per the owner's gate. See
      `tmp/workstreams/codex-explore-recordset-design-review-round2.md` (Final Confirmation).
- [x] 0.3 `openspec validate redesign-explore-recordset-query-presentation --strict` passes.

## 1. Slice 1 — count == reachability (highest-risk invariant)
- [ ] 1.1 Define the RecordSet descriptor (scope, count-kind enum, reachability) in the
      reference operation/types; surface it on `GET /_ref/explore/records` for `data`,
      `upcoming`, and per-group sets. Reference-contract delta + regenerate artifacts.
- [x] 1.2 Burst counts: made HONEST (Codex-gated 2026-06-21, option 2 of 2). The burst
      showed `burst.entries.length` with "show all ↓" — read as a COMPLETE
      (connection, stream, day) total but was only the LOADED count → same contract hole
      in miniature. FIX: label the count "N in view" with an "expand ↓" action (not
      "show all"), so it never implies a day-total the client can't prove;
      count==reachability holds (the number == what expand reveals; more arrive on feed
      Load-more). Pinned by 2 acceptance invariants. FOLLOW-UP (Codex preferred SLVP,
      DEFERRED, record true totals later): server per-burst true totals + a
      reachability handle for incomplete bursts. Not a Slice-1 blocker: the burst is now
      honest and the headline 188→32 reachability (Upcoming) is fixed.
- [ ] 1.3 Upcoming reachability: EITHER give the Upcoming section its own load-more to
      exhaustion (`paginate`) OR a scope-preserving drill-in (`drill_in`) per design §2.
      DECISION (recorded 2026-06-21): the per-stream records page `queryRecords` accepts
      ONLY `{connectionId, connectorInstanceId, count, limit, cursor, filter, order}` — NO
      `temporal: future`/date scope (verified `apps/console/.../records/[connector]/[stream]/
      page.tsx:202` + `reference-implementation/server/records.js`). So drill_in would land
      in the whole stream (past+future) = a 188→firehose violation. CHOICE = **paginate**:
      give `fetchUpcoming` a forward cursor and the Upcoming section its own load-more that
      walks the future projection to exhaustion. Self-contained in the explore operation +
      assembler + canvas; no cross-route records-page schema change. (Revisit drill_in if/
      when the records page accepts a future scope.)
      CURSOR SHAPE (Codex-gated 2026-06-21): NOT a flat global ASC seek — `record_key` is
      unique only WITHIN a partition, so a global `(semanticTime, record_key)` cursor would
      skip a same-pair row in another partition. Use an **Upcoming composite ASC cursor**
      mirroring the main feed's composite: `{ snapshotSeq, nowCeiling, partitions:
      [{connectorInstanceId, stream, lastSemanticTime, lastRecordKey}] }`, surfaced as
      `upcoming_next_cursor` + `upcoming_has_more` (separate from the main `next_cursor`).
      Each partition page seeks from ITS OWN last position (`semExpr > t OR (semExpr = t AND
      record_key > k)`), merge ASC, cap, advance per-partition.
      ACCEPTANCE BEFORE LAND (Codex): (1) page to exhaustion — 188th reachable, no dup/skip,
      both backends; (2) tied semantic_time across partitions AND within one partition;
      (3) post-snapshot future backfill excluded from the pinned traversal; (4) EXPLAIN PG
      first + cursor pages use the expression index, no Seq Scan + Sort; (5) `upcoming_total`
      stable across pages under the same snapshot.
- [x] 1.4 Scope-preserving drill-in: ALREADY SATISFIED in the deployed canvas (verified
      2026-06-21). "open all N records →" renders ONLY when `exactCountIsCurrent =
      exactTotal !== null && !unsupportedFullStreamState` — i.e. a server-true exact_window
      total AND a single (connection, stream) scope with NO Explore-only narrowing (text /
      date / local operator). The drill-in (`fullStreamHref`) carries that connection +
      stream + serverExactFilters + order, so the landed set == N. When scope can't fully
      transfer, it degrades to "open complete stream →" with an explicit note ("text search,
      date range, and local operators stay in Explore") — no firehose claiming N. Pinned by
      `page.invariants.test.ts` (EXACT_TOTAL_GATED_ON_FULL_STREAM_SCOPE / OPEN_ALL_RECORDS_
      GATED / FULL_STREAM_WHOLE_STREAM_NOTE / OPEN_COMPLETE_STREAM, 9/9 green).
- [x] 1.5 Counts that can't be exact render hidden: ALREADY SATISFIED. `exactTotal` is null
      unless `data.activitySummary.source === "exact_window"` (a server-true whole-window
      aggregate); a bounded/search sample never carries a total. A null total renders no
      "Showing N of M" claim (falls back to "in view" / "shown in this Explore preview"),
      never a faked total. Same invariant tests pin it.
- [x] 1.6 Tests: reproduce-the-bug DONE — `rs-explore-upcoming-reachability.test.js` (the
      188→only-32 regression: every future record reachable to the LAST member, ties cross+
      within partition, post-snapshot exclusion, stable total, both backends);
      `explore-loadmore-accumulate.test.ts` +3 (client ucursors trail concatenation);
      `explore-navigation.test.ts` +5 (ucursors trail rules + peek-keeps-trail fix);
      `explore-acceptance.test.ts` +2 (burst honesty + Upcoming pagination); burst-honesty
      invariants. Existing conformance + b1-b2-b3 + boundary stay green both backends.
- [x] 1.7 Dual-owner gate + deploy DONE (2026-06-21). Codex gate = HOLD round 1 (2 fixes:
      bounded upcoming cursor via the server-side store; delimiter-safe JSON dedupe) → re-
      review = LAND (`tmp/workstreams/codex-slice1-gate-verdict.md`). Deployed clean main
      `475af118` via `COMPOSE_PROJECT_NAME=pdpp reference-stack up --build-app` from
      `/home/user/.tmp/pdpp-deploy` (stack brought UP from down; all healthy;
      PDPP-Reference-Revision `v0.14.0-148-g475af118`; /dashboard/explore 307; deployed
      pdpp-reference-1 confirmed running the new code). LIVE DATA confirms the target: YNAB
      `month_categories` has EXACT 185 future records (month >= 2026-07-01) — the live "188".
      RESIDUAL (owner-gated, recorded not pseudo-active): the owner-CONSOLE round-trip needs
      a cookie session (the bearer owner token is the MCP path, not /_ref/explore/records);
      the host Playwright MCP wasn't exposed as tools this session. NEEDS the owner one click:
      open /dashboard/explore as owner, expand Upcoming, confirm ~185 + "Load more upcoming"
      walks to the last record (not capped at 32) + URL ucursors holds short ecr1_ handles
      (no 431). All code-side gates green; only the live owner-session click remains.

## 1b. Wireframe / pixel-acceptance gate (before Slice 2 reaches build)
- [ ] 1b.1 Produce 2-3 annotated low-fidelity wireframes (DOM sketches or screenshots) under
      `design-notes/wireframes/`: (a) desktop query + results + peek; (b) mobile query +
      filter sheet + detail; (c) grouped Upcoming + burst reachability. Each annotates IA,
      affordance placement, row selection + focus state, and every count/reachability label.
- [ ] 1b.2 Each wireframe SHALL show how count==reachability reads on that surface (where the
      true count sits, where "Open all N" lives, what a hidden count looks like).
- [ ] 1b.3 Owner/dual-owner glance to confirm the IA + affordances before broad query/
      presentation implementation; record the confirmation. (Not pixel-perfect mockups —
      enough to prove IA, affordance placement, selection, focus, and labels.)

## 2. Slice 2 — unified query model
- [x] 2.1 Collapse the two search inputs into ONE; pasted-id → jump-to-record affordance.
      (QueryInput in explore-canvas.tsx; RecordIdJump removed; detectRecordIdJump →
      inline "↵ Jump to record <id>" affordance, no second box.)
- [x] 2.2 Filter chips with typeahead for common filters (source, stream, has:image, date);
      a chip == its operator (same query). Operators remain as the power path.
      (buildTypeaheadSuggestions + combobox listbox; chip→facet/append-token equivalence.)
- [x] 2.3 Facets == query: one query state (chip/facet/free-text), reflected in the view
      link. (currentViewHref carries connection/xconnection/stream/xstream; liftFacetTokens
      folds typed con:/stream: into the SAME facet state a chip sets.)
- [x] 2.4 Invert source/stream selection: chip "is not"/exclude toggle (FacetRow ⊘) +
      `-con:`/`-stream:` operator → xconnection/xstream URL params. Exclusion is applied
      SERVER-SIDE at partition enumeration (operation excludeConnectionIds/excludeStreams →
      substrate NOT IN / <> ALL), so the feed, Upcoming, counts, AND cursor all omit the
      excluded set — counts stay EXACT (orchestrator corrected the agent's first-pass
      client-side post-filter, which shrank the upcoming total under exclusion = Codex red
      line #2). Operator == chip proven; server-side exclusion proven on BOTH backends.
- [x] 2.5 Facet counts = current-filtered-set count, exact-or-hidden ("in view" qualifier;
      cross-connection stream tally hidden; day-header count qualified "in view").
- [x] 2.6 Enter submits; keyboard (arrow/Enter to pick a typeahead suggestion, Escape closes).
- [x] 2.7 Tests: chip==operator query equivalence; facet==query unification; invert (source
      AND stream, chip AND operator); facet-count semantics; Enter-submits / pasted-id jump
      WITHOUT a second box. (explore-grammar/navigation/query-input/exclusion test suites.)
      Live deploy/verify deferred to the comprehensive end-review (per the build plan).

## 3. Slice 3 — selection / row-action contract
- [x] 3.1 Desktop: row body = `<button onClick=peek>`; separate `Open →` `<Link href=detailHref>`
      = full route (distinct outcomes, never the same as a row click).
- [x] 3.2 Mobile: row = `<Link href=detailHref>` (tap=full route, R4). Pinned by row-routing
      invariant — REPOINTED at the LIVE explore-canvas.tsx (the old test scanned the DEAD
      records-explorer-view.tsx).
- [x] 3.3 Selection machine-readable (`aria-pressed` + `data-selected`; aria-selected is
      invalid on a button) + visible ring; pure `resolveRowKeyAction` keyboard contract
      (↑/↓ move, Enter peek, Cmd/Ctrl-Enter open-full, Escape clear), unit-tested.
- [x] 3.4 Removed per-row "view full stream" link (#11) + feed-level "inspect read request"
      (#3) — VERIFIED their replacements exist first (group-level open-all-N drill-in /
      StreamSeeAllLink / fullStreamHref present; CopyViewLinkButton present).
- [x] 3.5 Multi-select explicitly NOT added — absence pinned by invariant.
- [x] 3.6 Tests green (180/180 explore; +5 keyboard behavior tests). Live deploy/verify
      deferred to the comprehensive end-review (per the build plan).

## 4. Slice 4 — manifest-authored presentation
- [x] 4.1 DECISION (Codex-gated 2026-06-21, `codex-slice4-vocab-verdict.md`): existing
      surfaces CANNOT express per-field ROLE (x_pdpp_type is TYPE not ROLE;
      display/views are stream-prose/field-sets). Option B chosen + APPROVED: add
      `x_pdpp_role` on schema.properties[field] (primary-title|secondary|event-time|actor|
      amount), presentation-only. Spec delta recorded.
- [x] 4.2 Reader reads ROLE from field_capabilities[].role via parseFieldRole →
      DeclaredFieldRoles → buildRecordPreview places declared title/body/etc BEFORE the
      field-name heuristic; TYPE still gates formatting. Declared role wins, never a guess.
- [x] 4.3 Honest generic fallback card (stream label + declared time + identity + humanized
      key/value table) as a first-class path for undeclared records — inspector + card +
      compact FeedRow. Built in the non-vocab pass.
- [x] 4.4 Field-name/stream-name heuristic reframed as explicitly LAST-RESORT (kept as the
      fallback until manifests declare roles; never the SLVP-ideal path).
- [x] 4.5 First-party pilot: `reference-implementation/manifests/github.json` stream
      `repositories` — `name`→primary-title, `description`→secondary; renders manifest-
      authored with NO connector-specific UI code (proven end-to-end).
- [x] 4.6 Tests: server x_pdpp_role→field_capabilities[].role (presentation-only, byte-
      identical flags vs undeclared twin, no grant/filter leak); console declared-role card
      no client code; two same-type fields (declaration decides); undeclared → generic;
      unknown role degrades to generic. tsc x3 + openspec --strict + contract artifacts
      current; 6/6 reference + 139 operator-ui + 183 console explore. Live deploy/verify
      deferred to the comprehensive end-review.

## 5. Slice 5 — polish (on the FINAL model)
- [x] 5.1 Motion (design-system tokens only, reduced-motion gated, zero layout shift):
      selection paint-only crossfade (--motion-state); shared `rr-x-reveal` keyframe
      (opacity + translateY 4px, --motion-enter/--ease-standard) for Upcoming body +
      burst-expand + new day-groups, keyed by stable group id so only NEW groups animate
      on load-more (model-state, not churn). Every new keyframe inside
      @media(prefers-reduced-motion: no-preference) with a static fallback — pinned by a
      brace-walk invariant (negative-control-verified).
- [x] 5.2 Mobile loading at the TOP of the visible feed: `.rr-x-progress` is position:fixed
      top:0 inside @media(max-width:860px) (out-of-flow → no layout shift); desktop stays
      absolute. The feed's only pending signal is aria-busy — NO opacity dim, NO
      pointer-events block (Codex: readable records stay live).
- [x] 5.3 Operators/typeahead popover clamped within the viewport (pure CSS, SSR-safe):
      input-anchored left/right + max-width:100vw + max-height:min(280px,60vh) +
      overflow-y:auto. No JS measurement.
- [x] 5.4 +6 source-scan invariants. Live owner-journey walkthrough = part of the
      comprehensive end-review's visual evidence packet (deferred to that gate).

## Safe leaf fixes (shippable independently of the model)
- [ ] L1 Enter-to-submit (also covered by 2.6; ship early if low-risk).
- [ ] L2 Operators-popover bounds (also 5.3; ship early if low-risk).

## Validation (run before handoff of any slice)
- [ ] `openspec validate redesign-explore-recordset-query-presentation --strict`
- [ ] Reference + console tsc clean; ultracite clean (changed files); reference-contract
      `check:generated` current.
- [ ] Explore conformance + b1-b2-b3 green BOTH backends (each on its own fresh DB).
- [ ] Live owner verification per slice; residual risks recorded, not left pseudo-active.
