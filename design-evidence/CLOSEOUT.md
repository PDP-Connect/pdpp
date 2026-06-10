# Console UI Elevation + Action Parity — Closeout

Branch: `design/ui-elevation-and-action-parity` (worktree `/home/user/code/pdpp-design-pass`)
Status: **ready for review-at-end — NOT merged to main.** All work committed on the branch.
Date: 2026-06-03

## TL;DR

Two things were asked: (1) "ensure the UI has all the relevant actions," (2) a full design pass elevating the "amateur" console + brand. Delivered, with a critique score on the core surfaces moving **24/40 (baseline) → 35/40** (objective bar was 34+). Everything is live-verified in a real browser against real Postgres data, not just unit-green. Four commits, nothing merged.

The design pass deeply transformed the **highest-visibility surfaces** (overview, runs/traces/grants lists) on a multi-model-reviewed token foundation that lifts **every** screen. It did **not** individually redesign all ~25 screens — that remaining scope is documented honestly below.

## Commits (on the branch, in order)

1. `f2564950` feat(console): run-cancel control + window-independent timeline terminal_status
2. `8fce792c` feat(brand): P0 design-token foundation (spacing/radius scales, surface ladder, numeric figures)
3. `0a2488fd` feat(console): overview metric strip + connector-led list rows
4. `57ada185` fix(console): unify run-row grammar, color StatusBadge, dominant KPI + semantic bars

## Part 1 — Action parity (verifiable functional work; high confidence)

- **Cancel-run control** added to the run detail page — active-run-only, confirm-gated, run-scoped non-destructive copy. Wired through the established client-wrapper → server-action → useTransition pattern. Closes the gap where the reference plane + agent catalog could cancel a run but the console could not. OpenSpec: `add-console-run-cancel-control`.
- **Root-cause bug found + fixed via live verification:** the run detail page inferred active/terminal from ONE page of the oldest-first timeline, so any run > the page window showed perpetually "active" (wrong badge, never-disabled poller, wrongly-shown cancel control). Fixed by adding a window-independent `terminal_status` to the run-timeline envelope (existing indexed LIMIT-1 terminal-event query; dual-backend SQLite + Postgres). OpenSpec: `add-run-timeline-terminal-status`. **This bug's unit tests passed while the page was still broken — only browser verification caught it.**
- **Parity findings** (design-notes/console-action-parity-findings-2026-06-03.md): `revoke_connection` (G3) and `delete_connection` (G4) exist on the agent surface but NOT the console. DEFERRED, not auto-closed, because delete is **destructive/irreversible** (erases collected data) — adding one-click destructive controls to the dashboard is a product+safety decision needing a confirmation ceremony and owner sign-off, recommended as a dedicated follow-up change. Schedule create/replace (G2) is a documented by-design human-only asymmetry.
- Proof: design-evidence/phase1-cancel-parity/ (terminal run → no control; active run → control present).

## Part 2 — Design pass

### Token foundation (lifts EVERY screen) — `packages/pdpp-brand/base.css`, `apps/console/src/app/globals.css`
- Named 4px **spacing scale** (`--space-*`); **radius scale** (`--radius-sm/md/lg/pill`, fixing the half-built `--radius-md` references); **surface-elevation ladder** (page→card→raised→overlay) replacing decorative gradients (removed body radial wash + `[data-surface]` gradient fills) and resting drop-shadows; systematic **tabular figures** (`--numeric`, `.pdpp-num`, table rule).
- **Color refinements (multi-model reviewed — Gemini caught two real defects in my first pass):** warm "human" accent re-engineered as a true sibling of the blue primary but held in the terracotta lane (H45) — restoring light/dark hue consistency and clearing a 10° collision with warning amber that would have made "human" read as a muted warning; `--edu-fg` pulled off "generic AI" purple to a muted cyan (H210) distinct from the protocol blue; `--surface-overlay` lifted a full step above raised so floating layers stay legible.

### Directly redesigned + live-verified surfaces
- **Overview:** metric strip (dominant Records KPI + secondary tier; single-hue connector distribution ramp; freshness preserved) replacing the run-on stat sentence.
- **Run / trace / grant list rows:** a shared `<RunRow>` grammar — connector + StatusBadge + `run_… · N events` + relative time — used identically on the standalone Runs list, the overview Recent-runs and Failed-runs panels. Raw IDs demoted to mono lookup keys.
- **StatusBadge:** fixed a **latent bug** where `.pdpp-eyebrow` (unlayered) outranked Tailwind text utilities, so badge labels had ALWAYS rendered grey instead of their semantic color (both themes). Badges now show green/red/amber by status, with dark-mode legibility (stronger wash + inset ring).
- **DataList / dark lists:** separators step to `--border-strong` on dark; tighter row padding.

### Critique trajectory (objective gate)
- Baseline 24/40 → metric-strip+rows 31/40 → gap-fix **35/40** (≥ 34 target). Consistency and Color/Restraint now 5/5. Verified by an independent critique reading the actual rendered pixels in dark + light.
- Evidence: design-evidence/{baseline,phase3-after,phase3-metric-strip,phase3-gapfix}/

## What is NOT done (honest remaining scope)

These inherit the token foundation (calmer surfaces, aligned numbers, colored badges) but were **not** individually redesigned or live-verified, and do not yet have the master-detail/density-toggle structure the prior-art POV recommends:

- Records/Connections index, stream records tables, record detail, stream health
- Deployment diagnostics, tokens
- Grants detail / packages, grant-request form, event-subscriptions, device-exporters
- Schedules, search, run-detail body (beyond the cancel control + terminal-status), traces detail
- **P1 structural items not built:** master-detail (split) shell, density toggle (40/48px) with persistence, sticky table headers.
- **Non-blocking polish the final critique named** (would push 35 → 37): tame/relocate the overview "Browser notifications" block; one plain-language line under the dominant KPI for the investor/standards-reviewer read; secondary-stat type nudge; one more luminance step on dark row separators.

## Architecture notes for whoever continues
- **Tailwind v4**; theme bridge is `apps/console/src/app/globals.css` `@theme inline`. Classes that exist ONLY in `packages/operator-ui` are NOT scanned by the console `content` glob, so `dark:`/arbitrary utilities introduced only there silently produce no CSS — put theme-aware styling in brand CSS (real CSS). This bit two sub-agents; it's why the dark-list work lives in `base.css`.
- Live verification harness (reusable): worktree console :3500 → worktree reference :7862 (set `PDPP_AS_URL`/`PDPP_RS_URL`, not `*_PUBLIC_URL`) → stack Postgres 127.0.0.1:55432/pdpp_proof (needs BOTH `PDPP_STORAGE_BACKEND=postgres` AND `PDPP_DATABASE_URL`). See memory `project_worktree_live_console_harness`.
- Two OpenSpec changes are authored + `--strict` valid but NOT archived (they ship with the branch): `add-console-run-cancel-control`, `add-run-timeline-terminal-status`.

## Recommended next steps (in priority order)
1. Review + merge this branch (the core surfaces are at-bar and verified).
2. Apply the shared `<RunRow>`/`DataList`/StatusBadge + token patterns to the remaining list/table screens (records, stream tables, deployment, event-subscriptions, device-exporters, schedules) — mostly mechanical now that the primitives exist.
3. Build the P1 structural spine (master-detail split shell, density toggle) — the larger remaining design effort.
4. Decide on G3/G4 (console revoke/delete) with a proper destructive-action ceremony.
5. The non-blocking polish list to reach 37.
