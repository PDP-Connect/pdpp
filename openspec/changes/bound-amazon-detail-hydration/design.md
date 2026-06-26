## Context

The Amazon connector currently enumerates list pages and then tries to hydrate each order by navigating to its detail page. A large backfill can process hundreds of orders but still hit the four-hour controller watchdog. The observed live run `run_1782483904024` reached 2024 page 33, emitted records and 38 pending `order_items` detail gaps, and was force-terminated while still progressing.

The expensive path is not the list page. It is the detail lane: each order may navigate, wait for detail selectors, retry transient failures, parse the page, and only then continue. Existing fixtures capture list pages and one successful detail page, but not the failed/budget-deferred detail surface that explains current gaps.

## Goals / Non-Goals

**Goals:**

- Bound Amazon detail hydration before the controller watchdog becomes the control mechanism.
- Preserve list-derived `orders` and `order_items` records even when detail enrichment is deferred.
- Emit durable pending `DETAIL_GAP` records for every order whose detail enrichment is owed but not hydrated.
- Support recovery-only runs that retry pending Amazon detail gaps without re-walking the full list.
- Capture one failed detail checkpoint when fixture capture is enabled; budget deferrals carry structured redacted gap evidence without touching the page.

**Non-Goals:**

- Do not change the global four-hour watchdog.
- Do not introduce concurrent browser detail fetching.
- Do not claim Amazon detail parser root cause without failed-detail evidence.
- Do not add raw order contents, recipient data, address data, item titles, payment text, cookies, or secret-bearing URLs to gap records or operator evidence.

## Decisions

1. **Use a connector-local detail budget, not a longer controller run.**

   A longer global watchdog hides the connector problem and blocks other runs longer. The connector should decide when optional detail enrichment is no longer worth spending the current run.

2. **List enumeration remains the coverage denominator.**

   The list page is the source of the set of orders considered. When the detail lane reaches its budget, the connector still emits list-derived records and records detail gaps for orders whose enrichment is deferred. It must not mark missing detail as complete.

3. **Budget-deferred detail is a durable retry contract.**

   The connector will emit `DETAIL_GAP` on `order_items` with a non-source-pressure reason and a safe class such as `deferred_budget` in `last_error`. This keeps scheduler source-pressure cooldowns separate from work-conserving recovery.

4. **Recovery-only is detail-only.**

   When the runtime starts Amazon with `recovery_only: true` and pending `order_items` gaps, the connector retries those detail locators and emits `DETAIL_GAP_RECOVERED` / hydrated records as applicable. It does not re-enumerate years or page through the order list.

5. **Capture one failed detail checkpoint.**

   Fixture capture should retain one diagnostic detail surface when attempted detail hydration fails. Budget deferral is different: after the local budget is exhausted, the connector deliberately avoids touching another detail page, so the durable evidence is the redacted `DETAIL_GAP` reason/class rather than a page checkpoint.

## Risks / Trade-offs

- **Some detail enrichment may arrive one or more runs later.** Mitigation: pending `DETAIL_GAP` rows are explicit, retryable, and visible in connection health.
- **A recovery-only run may still hit a bad detail page.** Mitigation: recovery keeps the gap pending with bounded error evidence and does not re-run the full list walk.
- **Skipping detail after the local budget could create a large gap backlog on first backfill.** Mitigation: this is more honest than a watchdog failure; scheduler recovery can drain it incrementally.
- **Failed-detail fixture capture may expose sensitive page content in local artifacts.** Mitigation: capture remains operator-controlled by fixture-capture settings; gap records remain redacted/reference-only.
