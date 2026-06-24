# Wireframe A — desktop: query + results + peek (Slice 1b gate)

Annotates the unified-query IA (Slice 2), the row-action contract (Slice 3), manifest
presentation (Slice 4), and how count==reachability reads on this surface. Low-fi; proves
IA + affordance placement + selection/focus + every count/reachability label, not pixels.

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│ Recordroom · Explore                                                    [copy view ⧉] │  ← one copy-link (item #3: the
├───────────────┬─────────────────────────────────────────────────────────────────────┤    redundant "inspect read
│ FACETS (rail) │  ┌───────────────────────────────────────────────────────────────┐  │    request" is GONE — Slice 3)
│               │  │ 🔍  [ from:ynab  ✕] [ has:image ✕] type to filter… ⌄          │  │  ← ONE input (item #4). Chips
│ Sources       │  └───────────────────────────────────────────────────────────────┘  │    ARE operators (item #5);
│  ☑ YNAB    188│   chip "⌄" = typeahead menu (source/stream/has:image/date). Enter      │    typing has:image == clicking
│  ☐ Chase    12│   submits (item #1). Paste an id → "↵ Jump to record abc123" pill.     │    the chip. Facets == this
│  ☐ Amazon    4│                                                                       │    query (item #10): toggling
│   ⊘ is not    │   ── one query state; the rail, the chips, and the URL agree ──        │    YNAB here adds from:ynab.
│               │                                                                       │
│ Streams       │  Today                                                          32    │  ← day count = records loaded
│  ☐ orders   12│   ┌─────────────────────────────────────────────────────────────┐  │    in view for today (honest)
│  ☐ messages  8│   │ ● Codex / messages                          2:14 pm   [Open]│←─┼── ROW (Slice 3): whole row
│   ⊘ is not    │   │   "refactor the upcoming cursor to use the store…"          │  │    click = PEEK (right). [Open]
│               │   ├─────────────────────────────────────────────────────────────┤  │    = full /records route. Two
│ FILTER COUNTS │   │ ○ Gmail / message_bodies                    1:07 pm   [Open]│  │    DISTINCT outcomes (item #12).
│  = count in   │   │   "Re: deploy window — reference-stack ok"                  │  │    No per-row "view full
│  the current  │   │   ● selected row: visible ring + aria-selected=true        │  │    stream" link (item #11).
│  filtered set │   └─────────────────────────────────────────────────────────────┘  │
│  (item #8);   │                                                                       │  ← focus/selected is machine-
│  hidden if    │  Tuesday, June 16                                              47    │    readable + visible (Slice 3):
│  not exact.   │   ┌─ 47  YNAB / month_categories  · in view ·   expand ↓ ──────────┐  │    arrow keys move it, Enter
│               │   └─────────────────────────────────────────────────────────────┘  │    peeks, Cmd-Enter Opens.
│ [Filter (2)]  │   burst = LOADED count "in view" (not a faked day-total). Group-       │
│  ← mobile     │   level door; no per-row link.                                        │  ← burst count==reachability:
│    only       │                                                                       │    the number == what expand
│               │  ┌─────────────────────────────────────────────────────────────┐    │    reveals (Slice 1, shipped).
│               │  │            Load more  ·  Showing 79 in view                 │    │
│               │  └─────────────────────────────────────────────────────────────┘    │
├───────────────┴────────────────────────────────────┬────────────────────────────────┤
│                                                     │  PEEK  (in-place inspect)       │  ← desktop peek pane = row
│                                                     │  ┌──────────────────────────┐   │    click target. Open button
│                                                     │  │ Codex / messages         │   │    routes AWAY to the full
│                                                     │  │ 2:14 pm · cin_…ece4       │   │    record-detail page.
│                                                     │  │                          │   │
│                                                     │  │ body: "refactor the…"    │←──┼── MANIFEST ROLE (Slice 4):
│                                                     │  │ author: peregrine Codex  │   │    title/body/author come from
│                                                     │  │                          │   │    DECLARED roles, not a
│                                                     │  │ ▸ Raw JSON               │   │    field-name guess. Undeclared
│                                                     │  │ [open full record →]     │   │    stream → honest generic
│                                                     │  └──────────────────────────┘   │    key/value card (no guess).
└─────────────────────────────────────────────────────┴────────────────────────────────┘
```

## Count / reachability labels on this surface
- **Facet number** (YNAB 188): exact count in the current filtered set, OR hidden (item #8,
  Slice 2). Never a loaded-window count dressed as a total.
- **Day count** (Today 32): records loaded in view for that day — honest "in view", not a
  claimed day total (the true day total needs a server per-burst count = follow-up).
- **Burst** ("47 … in view · expand ↓"): the LOADED count for that (connection, stream)
  group; expand reveals exactly those (count==reachability, Slice 1).
- **Feed footer** ("Load more · Showing 79 in view"): honest window size + a reach-more
  control; "open all N →" appears ONLY when an exact server total exists for the scoped
  stream (Slice 1, shipped).

## Affordance placement / selection / focus (the gate asks)
- ONE query input (top), facet rail (left), feed (center), peek (right). Mobile collapses
  the rail behind a "Filter (N)" button → bottom sheet.
- Row = peek; [Open] = full route — the two are visibly distinct (item #12).
- No per-row "view full stream" (item #11); the stream door is group/burst-level only.
- "inspect read request" removed; "copy view link" is the single share affordance (item #3).
- Selected row: visible ring + `aria-selected`; keyboard arrow/Enter(peek)/Cmd-Enter(Open)/
  Escape (Slice 3).
```
