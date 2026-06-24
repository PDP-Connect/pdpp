# R5: Saved-view tabs — honest design (2026-06-23)

The prototype showed tabs "All · Money · Messages · This week · + Save view". This is the one prototype
feature absent from live. The design challenge is HONESTY, not the UI: how do these tabs get defined without
the field/stream-name MEANING-guessing the whole sweep eliminated?

## The honesty trap (and how each tab resolves it)
- **"All"** = no filter. Trivially honest. The built-in default tab.
- **"This week"** = `since=7d` — an honest date operator. Fine as a built-in.
- **"Money" / "Messages"** = the trap. Defining these by GUESSING which streams are "money" (ynab/chase/usaa)
  or "messages" (slack/chatgpt) from their NAMES is exactly the meaning-guessing we forbid. A connector named
  "transactions" is NOT money because of its name.

## The SLVP-honest resolution
**Saved views are USER-AUTHORED named queries — NOT pre-baked semantic presets.**
1. The user builds a filter (chips / operators / date), clicks **"+ Save view"**, names it. That named query
   becomes a tab. The user defines the meaning; the system stores the literal query. 100% honest.
2. **"All"** is the only built-in tab (no filter). No guessed "Money"/"Messages" ship by default.
3. OPTIONAL honest presets (only if built from DECLARED signals, never names): a "Money" view could be
   `streams where a field declares the `amount` x_pdpp_role` — that's a DECLARED signal, not a name guess. But
   this is a stretch (cross-stream role query) and not worth the complexity for v1. SKIP guessed presets; ship
   user-authored only.

## Storage: localStorage (client-only), no server/assembler change
- A saved view = `{ id, name, query }` where `query` is the canonical Explore query string (the same one
  "copy view link" produces). Persist an array in localStorage (key e.g. `pdpp.explore.savedViews`).
- NO new server round-trips, NO assembler change, NO new param — a tab click just navigates to that query's URL
  (the existing buildNavigateHref). This keeps it a pure client feature, lowest risk.
- Honest counts on tabs: a tab can show a count ONLY for the CURRENTLY-active view (visibleFeed.length, like
  the VIEWS sidebar) — we do NOT pre-fetch counts for inactive saved views (that'd be N server calls or a
  fabricated number). Inactive tabs show NO count (honest) — never "—" styled as if loading, just the name.

## UI (matches the prototype tab row)
- A horizontal tab row above the feed (below the chip strip): `[All] [<saved view names>] [+ Save view]`.
- The active tab is whichever saved view's query matches the current URL query (or "All" when no filter).
- "+ Save view": appears when there's an active filter not already saved; prompts for a name (inline input or
  a small dialog), writes to localStorage, adds the tab.
- A saved tab: click → navigate to its query. Long-press / a small × on hover → delete (removes from localStorage).
- Mono discipline: tab names are sans (user content); any count is mono.
- Empty state: with no saved views, show just `[All] [+ Save view]` — the row is minimal, not empty-looking.

## Scope decision for THIS push
This is net-new (a new component + localStorage + the tab row + save/delete UX) — the highest-risk remaining
item. It is genuinely worth doing for the prototype parity (wayfinding), and the honest design above keeps it
safe (client-only, user-authored, no guessing). BUILD it AFTER the lower-risk fixes land and the mobile agent
finishes (to avoid file conflicts in components.css/canvas). Gate: new invariant test pinning (a) tabs are
user-authored not guessed presets, (b) inactive tabs show no fabricated count, (c) localStorage-only (no new
server param/call). Then it folds into the final coordinated deploy + 12-dim re-walk.

## Why NOT ship guessed "Money/Messages" presets (the explicit non-goal)
Shipping a "Money" tab that auto-selects ynab/chase/usaa would require the system to decide those streams are
"money" — by name. That is the single thing this entire redesign+sweep forbids. A user who wants a money view
authors it themselves (select their finance sources, save as "Money"). That is both honest AND more correct
(the user's "money" may include only some finance sources). The honest version is also the better product.
