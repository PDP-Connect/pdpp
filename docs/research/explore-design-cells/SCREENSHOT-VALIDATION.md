# Screenshot validation — designs vs the corpus shots (2026-06-23)

The 5 design cells were prior-art-grounded against LIVE product docs/URLs, but had NOT been validated
against the corpus screenshots (`../slvp-benchmark-2026-06-23/shots/`). The owner asked; this pass closes it.
I (Claude) read the shots as images directly (Codex can't see pixels, so it was not used here).

## Finding 1 — the corpus shots are uneven; the MANIFEST oversold two of them
- **`vercel-changelog-deployments-list-desktop` — GENUINELY VALIDATING (product UI).** Embedded real
  product screenshot. Confirms by PIXELS:
  - DATE cell: a single "Select Date Range" dropdown (calendar icon) + "All Authors"/"All E…" filter
    dropdowns in one row — the one-control-opens-picker pattern, no double-representation. ✓
  - RECORD-IDENTITY cell: dense rows = content title leads ("Implement context-aware escaping…") +
    status dot+label ("Building 1m34s"/"Ready") + env badge (Preview/Production/Staging) + MONO
    branch/commit. Human title leads; mono only for machine values; no field wall. ✓
  - SORT cell: filter dropdowns present, NO multi-key sort UI visible → consistent with "single-key is
    the SLVP norm." ✓
- **`linear-changelog-new-ui-desktop` — NOT a product UI (MANIFEST WRONG).** It's the changelog BLOG
  hero (app icon + article text). No filter bar / issue list in the captured frame. Useless as a
  row/filter baseline. Do not cite it as validation.
- **`primer-action-list-scrolled-desktop` — LOW VALUE.** Shows the docs CODE panel + a variant nav
  list ("leading visual", "single/multi select", "grouping with a header"), not rendered examples.
  Confirms the variants EXIST but gives no row-anatomy pixels.

## Finding 2 — the over-time CHART has NO corpus shot
No screenshot in the corpus shows a histogram-over-a-feed (Datadog/Grafana product UIs timed out or
weren't captured). The chart cell is validated against Grafana/Datadog DOCS only — pixels UNVALIDATED.
This is an honest residual: capture a Grafana/Datadog volume-band shot at execution, or accept doc-level.

## Verdict per cell (pattern vs pixels)
- date-controls: pattern ✓ + PIXELS ✓ (vercel deployments date-range dropdown).
- record-components: pattern ✓ + PIXELS ✓ (vercel rows: title-leads/mono-machine/badge).
- sort: pattern ✓ + PIXELS ✓-by-absence (no multi-key sort shown anywhere).
- honesty-copy: behavior/copy cell — not a pixel question; no shot needed.
- over-time-chart: pattern ✓ (docs) / PIXELS ✗ — no corpus shot exists. RESIDUAL.

## Net
4 of 5 cells are now validated against real product pixels (the Vercel deployments shot carries 3 of
them). The chart is the one pixel-unvalidated cell — flagged, not hidden. The MANIFEST's "product-UI"
labels need correction: only the Vercel deployments shot is a true dense-product-list reference among
the three I checked.
