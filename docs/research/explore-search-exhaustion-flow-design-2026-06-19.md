# Explore Search Exhaustion: End-to-End Flow Design and Adversarial Pressure-Test

**Date:** 2026-06-19
**Status:** Design proposal -- read-only research, no code changes
**Depends on:** explore-full-visibility-spec-2026-06-19.md (Phase 2), explore-relevance-browse-door-validation-2026-06-19.md, explore-slvp-product-mapping-verdict-2026-06-19.md

---

## Part 1: The Concrete Flow

### 1.1 The Moment the Owner Types

The owner is on the Explore page. The search bar is prominent at the top. They type "Portland".

**What they see immediately (before submitting):** no change to the result list yet. PDPP does not do live autocomplete on record content (out of scope here; treat as standard submit-on-Enter).

**What they see after submitting (the search results state):**

```
[ Search: Portland                                          x ]

                    Most relevant   Most recent

Top results for "Portland"                   Chase, Amazon, and 3 more

+---------------------------------------------------------+
| Chase Checking                                          |
| Transaction: Powell's Books -- Portland OR   Jun 3      |
| $42.18                                                  |
+---------------------------------------------------------+
| Amazon Orders                                           |
| Order: "Portland: A Food Cart City" book     May 28     |
+---------------------------------------------------------+
| iPhone Photos (metadata)                                |
| 47 photos tagged Portland, OR                May 3      |
+---------------------------------------------------------+
| Gmail                                                   |
| Email: "Re: Portland trip logistics"         Apr 29     |
+---------------------------------------------------------+
| Amazon Orders                                           |
| Order: "Portland Timbers scarf"              Apr 15     |
+---------------------------------------------------------+
|  ... 20 more results                                    |
|         [ Load more results ]                           |
+---------------------------------------------------------+
```

Header copy: "Top results for 'Portland'" -- not a count, not "(window capped)". The subtitle "Chase, Amazon, and 3 more" tells the owner at a glance which sources contributed without enumerating all 5 by name.

The toggle "Most relevant / Most recent" sits directly below the search bar, left-aligned. "Most relevant" is selected (underline or pill highlight). This is a two-state control, not a dropdown -- explained and justified in Part 2.

Result rows show: source name as a label, record title/summary, date, and (where applicable) the amount or a brief value. They are not grouped by source by default -- global rank order intermixes sources. This is correct: the spec confirms no per-source quota.

---

### 1.2 Load More in Most-Relevant Mode (Lexical)

The owner scrolls down and hits "Load more results". This is the lexical (keyword) path. The server returns the next cursor. The result list extends in place -- no page navigation, no spinner that replaces the list. New results appear below the last visible row.

The owner can keep loading. For a lexical search, this is technically exhaustive: the existing `next_cursor` in `rs-search-lexical/index.ts:1136` (currently discarded by the assembler) pages through the full BM25 result set. There is no theoretical end until the matching records run out. When they do, the end-of-list reads:

```
  All results loaded. 47 records matched "Portland".
```

If the result set is large (thousands), the owner will load many pages. That is correct behavior. There is no artificial cap.

---

### 1.3 Load More in Most-Relevant Mode (Hybrid / Semantic)

If PDPP is running a hybrid or vector search, the behavior is different and must be honest:

The initial results show the top matches from the ANN/RRF candidate pool. After those are displayed, there is no "Load more results" button. Instead, below the last result, the owner reads:

```
  Showing the most relevant matches for "Portland".
  To see every record mentioning Portland in a specific source,
  choose a source below.

  [ Chase Checking (412 records) ]  [ Amazon Orders (3,841 records) ]  [ Gmail (209 records) ]
```

Each chip is a browse door: clicking "Chase Checking (412 records)" navigates to the Chase Checking stream's record list, pre-filtered to "Portland" if the per-stream list supports filtering, or lands on the unfiltered stream list with a visible note "Showing all Chase records -- search within this source to narrow." This is the Stripe Activity Breakdown pattern (https://stripe.com/docs/dashboard/search): summary view with escape ramps to per-entity full lists.

There is NO fake "Load more" button that pretends to page a hybrid ranking. The spec is explicit: ANN rankings have no stable position past the candidate pool.

---

### 1.4 Switching to Most-Recent Mode

The owner clicks "Most recent". The result list replaces entirely. A brief visual signal marks the transition -- the header copy changes and the list resets to the top:

```
[ Search: Portland                                          x ]

                    Most relevant   Most recent

All results for "Portland", newest first          5 sources, 4,505 records

+---------------------------------------------------------+
| Chase Checking                                          |
| Transaction: Portland Farmers Market          Jun 18    |
| $23.40                                                  |
+---------------------------------------------------------+
| Gmail                                                   |
| Email: "Portland hotel confirmation"          Jun 17    |
+---------------------------------------------------------+
| Amazon Orders                                           |
| Order: Portland-branded tote bag              Jun 15    |
+---------------------------------------------------------+
| ...                                                     |
|         [ Load more results ]                           |
+---------------------------------------------------------+
```

Key changes the owner can read:

1. The header changes from "Top results for 'Portland'" to "All results for 'Portland', newest first". The word "All" and "newest first" are the mode signal. The owner is not re-reading the same 25 records ranked differently; they are in a new result set.
2. The total count appears: "5 sources, 4,505 records". In Most-relevant mode this count was absent (because relevance ranking cannot promise a stable total for hybrid). In Most-recent mode the count is meaningful and honest: it is the total matching rows by keyset query.
3. The list is strictly time-ordered. If two records share the same second, the tiebreaker is record ID (stable, deterministic). No interleaving of relevance signals.

"Load more results" in this mode pages through ALL 4,505 records via keyset cursor. The owner can reach the oldest match. When they do:

```
  Jun 2, 2018 -- Oldest match for "Portland"

  All 4,505 results loaded.
```

The end-of-list copy names the oldest date and confirms exhaustion.

---

### 1.5 Single-Source Case ("All my Amazon orders matching Portland")

The owner types "Portland" while on the Explore page, then clicks the "Amazon Orders (3,841 records)" browse door, OR they navigate directly to the Amazon Orders stream list and use the in-stream search there.

In the stream list view, the experience is simpler: there is only one source, so the "Most relevant / Most recent" toggle is still present but the browse door chips do not appear (there is nothing to browse to; you are already in a stream). The toggle behavior is identical. "Most recent" in a single-stream context is a keyset-pageable chronological view of that stream's matching records.

Does this feel different from cross-source? Yes, and it should:
- Cross-source Most-relevant: records from 5 sources interleaved by relevance score.
- Single-source Most-relevant: records from one source, still ranked by relevance within that corpus.
- The mental model shifts from "what is most relevant across my whole life" to "what is most relevant in my Amazon history". Both are valid questions. The owner probably lands in single-source after the cross-source results prompted them to go deeper on one source.

The difference is surfaced by the source label above each result in cross-source mode (visible in 1.1 above), which disappears in single-source mode because it is redundant.

---

### 1.6 Edge Cases: Empty, One Result, Burst

**Empty results:**

```
  No results for "Portland" in Most relevant mode.

  [ Search all records newest first ]
```

The CTA "Search all records newest first" switches to Most-recent mode with the same query, giving the owner a second attempt. If Most-recent also returns zero:

```
  No records matched "Portland".

  Your data was searched across Chase, Amazon, Gmail, and 2 more sources.
  If you recently added data, it may still be processing.
```

The second paragraph prevents the dead-end "did it even search?" confusion. It names the sources that were checked. "May still be processing" is honest about ingestion lag.

There is no "try a different query" suggestion. That adds clutter and is condescending for a personal-data product where the owner knows what they have.

**One result:**

```
  Top results for "Portland"                          1 result

  +-------------------------------------------+
  | Chase Checking                             |
  | Transaction: Portland OR Visa             |
  +-------------------------------------------+

  All results loaded.
```

The count "1 result" is shown when it is exact. "All results loaded" appears immediately below the single row. No "Load more" button. Clean.

**84,000 results (burst -- e.g. a WhatsApp group that was in Portland for a month):**

In Most-relevant mode: the top 25 results appear. If many of the top-25 come from the same source (WhatsApp, 84k records), the source label makes that visible. The browse door below reads "WhatsApp (84,211 records)". The owner knows where the mass is.

In Most-recent mode: the count reads "1 source, 84,211 records". "Load more" is available. The owner can page, but they will not page through 84,211 records manually -- they will use in-stream search or the date-filter if available. The flow does not have to solve the 84k case by itself; it has to NOT dead-end the owner. With the Most-recent path open and a browsable stream destination, it does not.

Burst-collapse (day grouping) applies in Most-recent mode: if 500 WhatsApp messages match "Portland" on the same day, they appear under a "Wednesday, May 15 -- WhatsApp (500 results)" day header with the first 3 visible and a "Show 497 more" expander. This follows the Google Photos / WhatsApp day-divider pattern. The owner does not see a wall of 500 identical-looking rows.

---

### 1.7 Interaction with the Day-Grouped Timeline (Phase 3 Recent Lens)

The Phase 3 timeline (the signature surface -- all sources, all records, newest first, no query) uses day grouping and burst-collapse. The Most-recent SEARCH lens (Most-recent mode with a query active) is a FILTERED version of that same timeline: same sort axis, same day-grouping logic, same burst-collapse, but restricted to records matching the query.

From the owner's perspective this is coherent: "Most recent without a query" = the timeline. "Most recent with a query" = the timeline filtered to records that mention X. The day headers and collapse behavior should be visually identical. The only difference is the header copy (date vs "All results for X, newest first") and the presence or absence of the search bar with a query.

Mobile: the day headers collapse to a single-line date row. The result cards are full-width. The "Most relevant / Most recent" toggle is below the search bar, full-width, as a segmented control (not a dropdown -- tap target matters on mobile). The browse door chips scroll horizontally if there are more than 3 sources.

---

## Part 2: Adversarial Pressure-Test

### 2.1 Toggle vs. Dropdown vs. Implicit Sort

**The question:** is "Most relevant / Most recent" the right control shape, or should it be a dropdown (with more options like "Oldest first", "Source A-Z") or implicit (system picks based on query type)?

**Prior art:**

- **Slack** uses a two-state toggle (sort=score vs sort=timestamp) exposed as "Most Relevant" / "Most Recent" in the search results header. Two states, named, always visible. (https://slack.engineering/search-at-slack/)
- **Notion** uses a dropdown with more values: "Best match", "Last edited", "Created" (notion.so search UI). Three states because Notion pages have distinct created-vs-edited timestamps that users care about differently.
- **GitHub** uses a dropdown labeled "Sort:" with options Relevance, Newest, Oldest, Most commented (github.com search). More options because GitHub search spans heterogeneous object types (issues, PRs, code) where additional sort axes add real value.
- **Gmail mobile** uses a two-state toggle "Most relevant / Most recent" (https://www.phonearena.com/news/gmail-working-on-search-filters-to-help-you-find-what-youre-looking-for-more-easier_id164308). Gmail web uses query operators instead. Two states for email.

**Verdict for PDPP:** a two-state toggle is correct. PDPP records have one meaningful time axis (authored/event time). There is no "oldest first" use case for search (the owner wants to exhaust from newest, not oldest -- oldest-first would be used by researchers, not personal-data owners). There is no "source A-Z" sort that makes semantic sense across heterogeneous record types. The toggle matches the simplest SLVP precedent (Slack, Gmail mobile) and avoids the dropdown overhead that GitHub and Notion add because they have genuinely more sort axes. The toggle is also a clearer mode signal than a dropdown: you can see both options simultaneously, which helps the owner understand that a mode switch is possible.

**Dropdown would be correct** only if PDPP adds a third sort axis with a real use case. Today it does not.

---

### 2.2 Is It Obvious That Most-Recent Is a Different Result Set?

**The question:** when the owner switches to Most-recent, do they know they are seeing a DIFFERENT (exhaustive, chronological) result set, not the same 25 records re-ranked?

**The risk:** the owner toggles, sees what looks like a different order of similar records, and concludes the toggle does nothing meaningful. Confidence in the feature evaporates.

**How leading products signal it:**

- **Slack**: the result list reloads from scratch on toggle. The visible count changes (Most Relevant may show "25 results" because cursormark is lazy; Most Recent shows a higher count when cursor-paginated). The list order changes visually and noticeably because the top-ranked message from years ago may displace the recently-posted message that ranked high by relevance.
- **Notion**: the mode name in the dropdown changes, and the list reorder is visible.
- **Gmail**: the header changes from "Top results" grouping to a flat chronological list. Gmail also adds a visible "Top results / All results" distinction within the same page when in relevance mode.

**For PDPP specifically, two signals that make the shift unambiguous:**

1. The header copy changes from "Top results for 'X'" to "All results for 'X', newest first". "All" vs "Top" is the clearest English signal that the scope changed, not just the order.
2. The total count appears in Most-recent mode ("5 sources, 4,505 records") but is absent in Most-relevant mode. A 4,505 count appearing when the owner had just seen 25 results is a visceral signal: the result set is much larger.

The risk is NOT fully eliminated by copy alone. If the Most-recent results happen to start with a record that was also #1 in Most-relevant (e.g., a single highly-relevant AND very recent record), the owner might still wonder. The engineering mitigation: ensure the API re-queries on toggle rather than client-side re-sorting the existing result cache. A brief "Loading..." state on toggle also signals that a fresh fetch is happening.

---

### 2.3 Is "Search Then Switch to Most-Recent to Exhaust" Intuitive?

**The question:** is this a power-user mental model, or is it findable by a non-expert owner?

**Evidence that it is NOT intuitive by default:**

- Gmail chose NOT to ship a sort toggle on the web for years, keeping it mobile-only. The reason is almost certainly that the default relevance-mode serves the majority of searches adequately, and the toggle adds cognitive overhead for the minority case.
- Slack's "Most Recent" toggle is present but frequently overlooked. Slack's own help documentation (https://slack.com/help/articles/202528808-search-in-slack) explains the toggle, suggesting users do not discover it organically.
- Google's own UX research on search (referenced in its Material Design guidance) shows that most users reformulate the query rather than change the sort mode when initial results are unsatisfactory.

**Evidence that it CAN be found given the right trigger:**

- The browse-door CTA ("To see every record matching X in a specific source, choose a source below") gives users a concrete action that does not require understanding sort modes.
- For the "I want EVERYTHING" intent specifically, "Most recent -- Load more" is more discoverable than most alternatives because it matches the mental model of a scroll-to-the-bottom timeline that users know from social media feeds.

**Verdict:** the toggle alone is NOT sufficient for a non-expert owner who wants exhaustion. The browse-door CTA is the primary affordance for exhaustion-from-hybrid (because it requires no mental model of sort modes -- "choose a source" is concrete). The toggle is the correct mechanism for power users and for lexical exhaustion. Both should ship. Relying on the toggle as the ONLY exhaustion path would be a power-user-only design.

---

### 2.4 Does the Browse Door Conflict With or Duplicate the Most-Recent Toggle?

**The question:** if the owner has both the toggle and the browse door available, is it confusing? Do they compete?

**The real tension:** in hybrid mode, there is no "Load more" under Most-relevant, so the browse door is the natural CTA. But the toggle is also present. Does the owner see two exhaustion paths and freeze?

**What Notion does:** Notion search offers both a sort dropdown AND context-specific "Open in full page" links from search results. These do not compete: the dropdown is about the RANKING of the current result set; the "Open in full page" is about NAVIGATING AWAY from search to a specific object. The user distinguishes them because they are visually different controls with different labels.

**For PDPP:**

The toggle and the browse door answer different questions:
- Toggle (Most relevant -> Most recent): "show me all matches for X in time order, across ALL my sources"
- Browse door ("Chase Checking (412 records)"): "show me all records in THIS specific source"

These are not duplicates. A user searching "overdraft" who wants cross-source exhaustion uses the toggle. A user who only wants their Chase history uses the browse door. Both needs are real.

The conflict risk is low IF the browse door is positioned as a secondary CTA below the result list (after the "these are the top matches" section ends), not next to the toggle. The visual hierarchy should be:

```
[Toggle: Most relevant | Most recent]  <- primary mode control
... results ...
[End-of-relevance-results text]        <- semantic boundary
[Browse door chips]                    <- secondary, source-specific CTA
```

This is the same hierarchy Stripe uses: summary first, full-list links below. The browse door does not subsume the toggle because they operate on different dimensions (cross-source vs single-source).

There is one real conflict to name: if the owner switches to Most-recent and ALSO sees browse door chips below, it creates ambiguity ("am I already in 'see all', so why is there also a 'see all in Chase' button?"). Resolution: the browse door chips appear ONLY in Most-relevant mode for hybrid results, not in Most-recent mode. In Most-recent mode, the result list IS already exhaustive and cross-source, so no browse door is needed or helpful.

---

### 2.5 Honest Failure Modes

**Failure mode 1: The mode switch is invisible on mobile.**

On a small screen, the toggle is a narrow segmented control. If the active state is indicated only by color (common mistake), color-blind users and low-contrast displays will not perceive it. Prevention: active state must use both color AND a visible indicator (bold text, underline, or pill shape). Slack uses a pill highlight. Gmail mobile uses a text weight change. PDPP should follow both.

**Failure mode 2: The total count in Most-recent mode is wrong or stale.**

If the count "4,505 records" is computed at query time but new records arrive during the session, the count becomes stale. Prevention: display the count with a "+" suffix if the data is still ingesting ("4,505+ records") and do not try to update it in real-time. This is the Gmail "inbox count" pattern -- stable enough at display time, not a live ticker.

**Failure mode 3: The browse door sends the owner to an unfiltered stream list.**

If the browse door opens Chase Checking at the top of the list with no visible connection to "overdraft", the owner is confused. Prevention: the browse door link must carry the query as a filter: `/explore/streams/chase-checking?q=overdraft`. If the stream list does not support inline search, the browse door should at minimum show a persistent banner: "Showing all Chase Checking records -- type in the search bar above to narrow by 'overdraft'."

**Failure mode 4: Empty state for Most-recent after non-empty Most-relevant.**

The owner has 12 Most-relevant results but switches to Most-recent and sees 0. This can happen if the Most-relevant results came from a semantic/vector match that found conceptually-related records, while Most-recent uses strict keyword match. Prevention: empty state in Most-recent must acknowledge this: "No records matched 'Portland' exactly. Try 'Most relevant' mode for related results, or browse all records in a source." Do not just show a generic empty state.

**Failure mode 5: Day-grouping hides results the owner expects to find.**

In Most-recent mode with day-grouping and burst-collapse, a day that produced 500 WhatsApp messages and 1 Chase transaction might show "WhatsApp (500)" as a collapsed burst and the Chase transaction individually. If the owner is looking for the Chase transaction but expands the WhatsApp burst first, they spend time in the wrong place. Prevention: burst-collapse should be source-aware. A day header shows "Wednesday, May 15" with sub-groups by source, not a single mixed burst. The Chase transaction and WhatsApp messages are collapsed separately. This is the Google Timeline pattern: a day can have multiple cards (one per significant event type) rather than one undifferentiated collapsed blob.

---

## Confidence Verdict

**Is this end-to-end flow SLVP-ideal and coherent?**

**For lexical search: yes, at 90% confidence.** The lexical path (query -> top results -> Load more -> exhaust) is straightforward, technically sound, and matches Slack/Notion/Elasticsearch precedent. The only implementation gap is wiring the existing `next_cursor` in `rs-search-lexical/index.ts:1136` through `explore-data-assembler.ts:809`. The UX is standard.

**For hybrid/semantic search: yes at 80% confidence, with one named seam.**

The seam: in hybrid mode, the flow relies on the browse-door CTA to give users an exhaustion path. This is correct design (the toggle's Most-recent mode IS technically exhaustive cross-source, but it requires the Phase 3 k-way merge to be built). If Phase 3 is not shipped, the toggle in hybrid mode switches to Most-recent but the backend must still be able to return chronological keyset-pageable results filtered by the query -- which means lexical fallback in Most-recent mode, not a re-run of the hybrid. This is a latent ambiguity in the spec: does Most-recent mode run a DIFFERENT backend query (keyset lexical scan filtered by query terms) than Most-relevant mode (hybrid ranked), or does it re-sort the same candidate pool?

**Tim's decision needed on the seam:** in Most-recent mode with a hybrid-capable backend, should the server run:

(A) A keyset lexical scan (strict keyword match, exhaustive, no vector component) -- simpler, honest about what "Most recent" means, but may miss records that the vector component would have found; OR

(B) The hybrid query re-run with the sort axis forced to timestamp -- technically inconsistent (hybrid ANN is not re-rankable by time beyond the candidate pool), so this is effectively the same as (A) past the top-K.

The answer is almost certainly (A), which means Most-recent mode is strictly a lexical chronological scan. This is exactly what Slack does: "Most Recent" uses a different search path than "Most Relevant". The implication for copy: "All results for 'X', newest first" is accurate for (A) only if the owner understands that "all" means "all lexical matches", not "all semantic matches". If the vector search found 25 conceptually-related records in Most-relevant mode that the lexical scan in Most-recent mode would miss, the owner may see fewer-or-different records in Most-recent -- a confusing inversion. No major product has solved this elegantly. Slack avoids it by having a purely lexical backend; Gmail avoids it by defaulting to lexical with relevance re-scoring on top. For PDPP with a true hybrid backend, this inversion is a real UX risk that the current spec does not fully resolve.

**Bottom line:** ship the toggle. Wire lexical load-more now. Ship browse doors for hybrid. Defer the "what backend query powers Most-recent on a hybrid corpus" question to when Phase 3 is scoped -- it is the one real design tension that could produce a confusing experience if not decided explicitly before shipping.
