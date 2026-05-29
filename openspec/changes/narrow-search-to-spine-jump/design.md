# Design: narrow-search-to-spine-jump

## Rationale

The PDPP dashboard has two surfaces that involve finding things:

- **Explore** (`/dashboard/explore`) — record-content search and time-range browsing. Calls `searchRecordsLexical` / `searchRecordsHybrid`. Owns the owner-token record-search surface.
- **Search/Jump** (`/dashboard/search`) — spine artifact lookup by id. Calls `GET /_ref/search`. Returns trace/grant/run buckets.

Before this change the search page called both. Operators who typed a free-text query on the search page would get record-content results (same results as Explore), making the two surfaces look redundant and confusing. The designer HTML for the PDPP Explorer confirmed the intended split: "Search" should be the spine/id lookup utility, and "Explore" owns record browsing.

## Shapes considered

**Shape A — rename and redirect.**
Rename the nav label to "Jump". Redirect free-text queries from Jump to Explore. Keep exact id-match deep links intact. This is the minimal, reversible change that achieves the designer intent without removing functionality.

**Shape B — remove the Jump surface and merge into Explore.**
Absorb the spine artifact lookup into Explore (a "Jump to id" affordance within Explore). This is larger, harder to reverse, and removes the dedicated id-lookup entry point that the command palette and `⌘K` use for quick jumps. Not chosen.

**Shape A was chosen.** It is the lowest-complexity equivalent. No backend changes. No new endpoints. No reorganization of Explore. The URL `/dashboard/search` continues to work (existing bookmarks and command palette deep links survive); the page just no longer competes with Explore for record-content queries.

## What is and is not in scope

In scope:
- Nav label rename: "Search" → "Jump".
- Page heading rename: "Search" → "Jump".
- Redirect free-text submits from jump page to Explore.
- Remove `searchRecordsLexical` / `searchRecordsHybrid` / `getRecord` from the jump page.
- Update component JSDoc and placeholder copy to reflect narrowed purpose.
- Static guard tests to prevent record-search symbols from re-entering the jump page.
- Sandbox mirror (same changes to `/sandbox/search`).

Out of scope:
- Changing the URL path `/dashboard/search` (nav label ≠ URL; renaming the path would break existing links).
- Moving spine lookup into Explore.
- Changes to the Explore page logic or the `/_ref/search` backend endpoint.
- Renaming `SearchView`, `SearchData`, or `refSearch` in library code (internal identifiers; the component already renders "Jump" as its heading).

## Acceptance checks

1. `GET /dashboard/search` with no query: shows "Jump" heading and empty-state hint that links to Explore.
2. `GET /dashboard/search?q=<valid-trace-id>`: exact-match redirects to `/dashboard/traces/<id>`.
3. `GET /dashboard/search?q=<free-text>`: redirects to `/dashboard/explore?q=<free-text>`.
4. `GET /dashboard/search?q=<free-text>&jump=0`: renders spine-only buckets (no redirect).
5. Nav sidebar shows "Jump" as the label for the search section.
6. Command palette shortcut shows "Jump".
7. Static guard tests pass: no record-search symbols in search page files.
8. `openspec validate narrow-search-to-spine-jump --strict` passes.

## Residual risks

- The `lensLabel` function inside `records-explorer-view.tsx` still returns `"Search"` for the `"search"` lens. This is the active-mode label shown within the Explore feed header (e.g., "Search · 12 records"). It describes the query-driven mode of the Explore surface, not the Jump nav item. No change required; renaming it to "Query" or "Text search" is a follow-up polish task, not part of this change.
- The URL path `/dashboard/search` remains "search" (not "/jump"). This is intentional — URL stability outweighs cosmetic alignment, and a URL redirect from /jump to /search would be unnecessary complexity.
