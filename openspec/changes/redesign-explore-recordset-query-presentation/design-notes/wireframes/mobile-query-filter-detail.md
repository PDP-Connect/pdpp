# Wireframe B — mobile: query + filter sheet + detail (Slice 1b gate)

Mobile parity for the unified query (Slice 2), the row-action contract (Slice 3, mobile tap
= full route), and the loading-position fix (Slice 5, item #2). Phones have no peek pane, so
a row TAP navigates to the full record-detail route (R4, pinned in Slice 3).

```
   QUERY + FEED (default)            FILTER SHEET (tap "Filter")        RECORD DETAIL (tap a row)
┌───────────────────────────┐   ┌───────────────────────────┐   ┌───────────────────────────┐
│ Explore            [⧉]    │   │ ▁▁▁▁▁ (grab handle)        │   │ ‹ Back        Codex/messages│ ← full route (NOT a peek);
│┌─────────────────────────┐│   │ Filter                  ✕ │   │                             │   mobile tap routes here
││🔍 [has:image ✕] filter… ││←─ one input + chips, on      │   │  2:14 pm · cin_…ece4        │   (item #12 / R4).
│└─────────────────────────┘│   │ mobile too (Gmail parity).   │   │                             │
│  ⟳ loading… (sticky TOP)  │←─ item #2: the loading        │ Sources                   │   │  body                       │ ← MANIFEST ROLE (Slice 4):
│  ─────────────────────────│   indicator is pinned to the  │  ☑ YNAB              188  │   │  "refactor the upcoming…"   │   declared roles fill the
│ [ Filter (2) ]   newest ▾ │   TOP of the visible feed,     │  ☐ Chase              12  │   │                             │   detail; undeclared → honest
│  ─────────────────────────│   never scrolled above the     │   ⊘ is not (invert)       │←─ │  author                     │   generic key/value (no guess).
│ Today                  32 │   fold while you scroll.        │                           │   │  peregrine Codex            │
│ ┌─────────────────────────┐│                              │ Streams                   │   │                             │
│ │● Codex / messages  2:14p││  ← whole row is the tap       │  ☐ messages           8  │   │  ▸ Raw JSON                 │
│ │ "refactor the upcom…"   ││    target → full detail route │   ⊘ is not                │   │                             │
│ ├─────────────────────────┤│    (no separate Open needed   │                           │   │  [ copy view link ⧉ ]       │ ← single share affordance
│ │○ Gmail/message_bodies   ││    on mobile; tap == open).    │ Date                      │   │                             │   (item #3); no "inspect
│ │ "Re: deploy window…"    ││                               │  [ Today ][ 7d ][ 30d ]   │   │                             │   read request".
│ └─────────────────────────┘│                              │  [ custom range ]         │   │                             │
│ ▸ 188 upcoming            │←─ Upcoming = flat day-list on │                           │   │                             │
│   scheduled / future       │   expand (Slice 1 fix): all   │ ┌───────────────────────┐ │   │                             │
│   [▾ Wed Jul 1]            │   188 reveal at once, no       │ │   Apply filters       │ │   │                             │
│    • month_categories …   │   nested "expand", no 32-drip. │ └───────────────────────┘ │   │                             │
└───────────────────────────┘   └───────────────────────────┘   └───────────────────────────┘
```

## Count / reachability labels (mobile)
- Facet numbers in the sheet: same exact-or-hidden rule (item #8).
- "188 upcoming" pill: exact server total; expand → flat day-list of ALL of them (Slice 1).
- Day/feed counts: honest "in view"; load-more reaches the rest.

## Affordance placement / selection / focus (the gate asks)
- ONE query input + chips at the top; advanced filters behind a **Filter (N)** button →
  bottom sheet (Gmail pattern). Chips survive on mobile (Slice 2).
- Row TAP = full record-detail route (no peek pane on phones); there is no separate Open
  button — tap IS open (item #12 resolved for mobile via R4).
- Loading indicator is sticky at the TOP of the visible feed (item #2, Slice 5).
- No per-row "view full stream" (item #11); "copy view link" is the only share (item #3).
- Focus: the tapped row shows a pressed/active state; the sheet traps focus while open.
```
