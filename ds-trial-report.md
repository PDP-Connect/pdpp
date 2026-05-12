# DevSpecs (`ds`) Trial Report

**Date:** 2026-05-12
**Trial repos:** `pdpp` (OpenSpec-heavy, 79 indexed artifacts), `unity-surfaces` (ADRs + dated plan files, 19 indexed artifacts)
**Method:** Three grounded persona simulations in `unity-surfaces` (returning dev, new contributor, mid-review architect), plus a direct evaluation in `pdpp`.

---

## What worked

- **`ds init` / `ds scan`** ran cleanly in both repos. Default source paths picked up `docs/adr/`, `docs/design/`, OpenSpec changes, and standard plan directories without manual config.
- **`.aiignore` / `.gitignore` honored** during discovery; `node_modules` was not indexed.
- **`ds find <conceptual term>`** worked when the query matched ADR title content. In `unity-surfaces`, `ds find surface` returned ADR 0001 ("App Surface Boundary") as the top hit in ~5s — competitive with `grep -rl` for this case.
- **`ds context <id>`** produced a compact, agent-paste-ready output (proposal + extracted tasks + a generic "instructions for agent" preamble).
- **`ds resume`** correctly identified the 4 most recently authored ADRs in `unity-surfaces`.

## What didn't work

1. **`ds find` missed underscored / snake_case identifiers.**
   `ds find client_display` in `pdpp` returned zero results, while `grep -rl "client_display" openspec/` found matches in two files. Identifier-shaped queries (`pnpm`, `client_display`, `authorization_details`) are common in protocol/infra repos.

2. **`ds find` missed dated/slug-style plan filenames.**
   `ds find pnpm` in `unity-surfaces` did not surface `apps/desktop/docs/plans/260219-pnpm-migration.md`. Plans named by date prefix appear invisible to title-weighted search.

3. **`ds resume` lifecycle is literal, not semantic.**
   - In `pdpp`, all 79 OpenSpec changes show as `proposed` (their pre-archive state in OpenSpec). `ds resume` rendered every one as "In Progress" — including changes with 40/40 tasks complete but not yet `openspec archive`d. The "In Progress" bucket is effectively "everything unarchived."
   - In `unity-surfaces`, all four ADRs showed `Status: unknown`. The ADR files do not contain a `Status:` field, but `ds` displayed `unknown` rather than omitting the column. "In Progress" again grouped all recent items regardless of state.

4. **`ds context` excludes OpenSpec `design.md` and spec deltas.**
   For `harden-consent-token-handoff` in `pdpp`: `proposal.md` (35 lines) and `tasks.md` (44 lines) were included; `design.md` (90 lines — the longest file, containing rationale) was not surfaced in the first 30 lines of output. Agents fed this context lose the design reasoning.

5. **Default config does not match all common locations.**
   In `unity-surfaces`, `history/plans/` and `apps/desktop/docs/plans/` (containing the majority of plan files) were not in the default `markdown` paths. Users get a numeric count from `ds scan` with no signal that locations were missed.

6. **Short IDs replace usable slugs.**
   OpenSpec slugs (e.g., `harden-consent-token-handoff`) and ADR filenames (`0001-app-surface-boundary.md`) are already stable, human-typeable identifiers. `ds context` requires the short hash (`a04de799`), adding a lookup step.

7. **`ds find` returns title-level results only.**
   No file paths, no line numbers, no body snippets in the default output. Disambiguating between multiple hits requires a follow-up `ds context` or `ds show` call.

## Where `ds` offered a clear marginal win

The "mid-review architect" persona scenario: a senior dev verifying a PR is consistent with an existing architectural decision. `ds find surface` → top-ranked ADR 0001 → `ds context 23b2fea6` produced the decision text in ~12s, slightly faster than `ls docs/adr/ && cat docs/adr/0001-*.md`. This worked because (a) the ADR had a strong title match, (b) the query was a noun, (c) the result set was small.

## Where `ds` did not earn its place

- **Repos with a canonical spec system already (OpenSpec, adr-tools).** Indexing is duplicative; `ds context` is less complete than the underlying directory.
- **Searches for protocol identifiers / dated plan slugs.** Title-only matching with a tokenizer that drops underscored terms fails the common case.
- **"What did I leave off?" workflows.** `ds resume` does not distinguish ready-to-archive, blocked, in-progress, and stale. Without that distinction, the view is recency-sorted, which `ls -t` already provides.

## Highest-impact requested improvements

1. **Index identifier-shaped tokens** (snake_case, dotted paths, kebab-case filenames). The tokenizer is the single biggest blocker for protocol/infra repos.
2. **Body-aware `ds find` output** with file path, line number, and matched snippet. Default to one line per match, like `grep -n`.
3. **First-class OpenSpec lifecycle.** Distinguish `proposed` + 0 open todos (ready-to-archive) from `proposed` + open todos (in-progress) from `proposed` + 0 commits in 30 days (stale).
4. **Include `design.md` and spec deltas in `ds context`** for OpenSpec sources.
5. **Accept slugs and filenames as IDs** (`ds context harden-consent-token-handoff` and `ds context 0001-app-surface-boundary`), not just short hashes.
6. **Report missed paths during scan**, e.g., "found 4 additional candidate plan directories not in config: …".
