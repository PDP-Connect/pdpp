# Wireframe C — grouped Upcoming + burst reachability (Slice 1b gate)

Pins how count==reachability READS across the three grouping levels (section › day ›
burst), incl. the Slice-1 Upcoming fixes (flat day-list, reveal-all to MAX_LIMIT, then
honest "Showing X of N" + load-more). This is the surface the owner's "188 but I can only see 32"
feedback (#14) and "collapse/expand doesn't feel good" (#15) target.

```
COLLAPSED (default)                          EXPANDED (one disclosure, then a FLAT list)
┌─────────────────────────────────────┐     ┌─────────────────────────────────────────────┐
│ ▸ 188 upcoming                       │     │ ▾ 188 upcoming    scheduled / future-dated    │
│   scheduled / future-dated           │     │  ┌─ Wednesday, July 1, 2026 ──────────────┐  │ ← FLAT day-bucketed list
└─────────────────────────────────────┘     │  │ • YNAB / month_categories  groceries   │  │   (groupFeedDaysNoBursts):
  exact server COUNT(*); never capped.       │  │ • YNAB / month_categories  rent        │  │   NO nested "expand" burst
  one click to open.                         │  │ • YNAB / month_categories  …(186 more)│  │   inside the already-open
                                             │  └────────────────────────────────────────┘  │   section (Slice 1 fix).
                                             │  Showing 188 of 188 upcoming records          │
                                             │                                               │ ← if total ≤ MAX_LIMIT(500):
                                             │  (all revealed; no Load-more needed)          │   all reveal on first expand.
                                             └─────────────────────────────────────────────┘

BEYOND THE PAGE CEILING (e.g. 1,000 future)            PAST-FEED BURST (count==reachable)
┌─────────────────────────────────────────────┐   ┌─────────────────────────────────────────┐
│ ▾ 1,000 upcoming   scheduled / future-dated   │   │ Tuesday, June 16                    47   │
│  ┌─ Wednesday, July 1, 2026 ──────────────┐  │   │ ┌─ 47  YNAB/month_categories ·in view·  │
│  │ • … (500 future records, flat) …       │  │   │ │    expand ↓ ─────────────────────────┐│ ← LOADED count "in view";
│  └────────────────────────────────────────┘  │   │ └──────────────────────────────────────┘│   expand reveals exactly those
│  Showing 500 of 1,000 upcoming records        │←─ │  (true day-total needs a server          │   47 (count==reachable). NOT a
│  ┌──────────────────────────────────────┐    │   │  per-burst count = recorded follow-up)   │   faked complete day-total.
│  │       Load more upcoming ↓           │    │   └─────────────────────────────────────────┘
│  └──────────────────────────────────────┘    │
└─────────────────────────────────────────────┘   "Open all N →" appears ONLY when an exact
  pill stays EXACT (1,000); page ceiling 500;       server total exists for the scoped stream +
  honest "Showing 500 of 1,000"; one more click      no Explore-only narrowing (Slice 1, shipped).
  reaches the rest. Reachable at any scale.
```

## The count==reachability invariant, level by level
| Level | Count shown | Reachability | Honest label |
|---|---|---|---|
| Upcoming pill | exact server `COUNT(*)` (any size) | walk to exhaustion via the upcoming cursor (store-backed `ecr1_` handle; bounded URL) | "N upcoming" |
| Upcoming body | — | flat day-list; ≤500 reveals all on expand; >500 → "Showing X of N" + load-more | "Showing X of N upcoming records" |
| Day group | records loaded for that day | reach more via feed Load-more | day number = in-view |
| Burst (past) | LOADED count for the (conn, stream) group | expand reveals exactly those | "N … in view · expand ↓" |
| "Open all N" | exact server total (scoped stream) | drill-in lands in exactly N | only when exact + scope transfers |

## Why this resolves #14 + #15
- #14 ("188 but only 32"): the pill is exact AND every one of the N is reachable — never a
  count promising more than the UI reaches, never shrunk to match a broken window.
- #15 ("collapse/expand doesn't feel good"): the Upcoming section is ONE disclosure with a
  flat body — no double-collapse; reveal-all up to the page ceiling; honest "Showing X of N"
  beyond it. The past feed keeps its burst collapse (genuinely many same-group rows), but
  the count is honest ("in view"), not a faked total.
```
