## Why

The `/dashboard/search` surface was originally a general-purpose record-content search surface and a spine artifact lookup surface rolled into one. This created two problems:

1. **Ownership ambiguity.** Explore (`/dashboard/explore`) is the canonical record-content search and browsing surface. A second record-search surface with the same backend endpoints was confusing to operators and created duplicate, misaligned UX.
2. **Designer-alignment gap.** The designer HTML for the PDPP Explorer made clear that "Search" should be a spine artifact lookup utility (jump to a trace/grant/run by id), not a competing owner-token record-content search surface.

The fix is to narrow the Search surface to its clearer purpose: id-based spine artifact lookup. Rename the nav label from "Search" to "Jump" and redirect any free-text submit (non-id query) to Explore, which owns record-content search.

## What Changes

- The `/dashboard/search` (and `/sandbox/search`) nav label changes from "Search" to "Jump".
- The page heading on the search surface changes from "Search" to "Jump".
- Free-text submits on the search/jump page redirect to `/dashboard/explore?q=<query>` (or the sandbox equivalent) instead of calling record-search endpoints.
- The search/jump page retains exact id-match redirects (trace, grant, run) and the spine artifact bucket display.
- The `SearchView` component comment and placeholder copy reflect the narrowed purpose (spine artifact lookup only).
- Record-content search callouts (`searchRecordsLexical`, `searchRecordsHybrid`) are removed from the search page.
- Static guard tests enforce that record-search symbols cannot re-enter the search page.

## Capabilities

### Modified Capabilities

- `reference-surface-topology` — documents that the operator dashboard MUST separate record-content search (Explore) from spine artifact lookup (Jump/Search), and that the Jump surface SHALL NOT duplicate record-content search.

### Added Capabilities

- None.

### Removed Capabilities

- None. The record-content search capability remains available through Explore.

## Impact

- `apps/web/src/app/dashboard/search/page.tsx` — narrowed to spine-only; free-text redirects to Explore.
- `apps/console/src/app/dashboard/search/page.tsx` — same changes mirrored.
- `apps/web/src/app/sandbox/search/page.tsx` — same changes mirrored for mock-owner mode.
- `apps/web/src/app/dashboard/components/views/search-view.tsx` — heading and placeholder copy updated to "Jump".
- `apps/console/src/app/dashboard/components/views/search-view.tsx` — same.
- `apps/web/src/app/dashboard/components/shell.tsx` — nav label "Search" → "Jump".
- `apps/console/src/app/dashboard/components/shell.tsx` — same.
- `apps/web/src/app/dashboard/components/command-palette.tsx` — shortcut label "Jump" (was "Search").
- `apps/console/src/app/dashboard/components/command-palette.tsx` — same.
- Static guard tests added for all three search page files.
