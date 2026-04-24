# Control-plane live UX audit

**Status:** audit note  
**Date:** 2026-04-21

## Purpose

Capture the live browser findings from the current local dashboard so the next execution plan reflects:

- the real operator experience with current data
- actual performance/interaction behavior
- mobile behavior beyond what is obvious from source code alone

This note complements the code-only UI audit. It does not replace it.

## Environment used

- local Next.js dev server at `http://127.0.0.1:3003`
- live local AS/RS backing the dashboard
- Playwright desktop pass and narrow mobile pass

Visited routes:

- `/dashboard`
- `/dashboard/traces?status=failed`
- `/dashboard/traces?status=failed&peek=<trace_id>`
- `/dashboard/records`

## What the live UI confirms

### 1. Overview is genuinely useful now

The current landing page is no longer a fake dashboard shell.

Live behavior confirms:

- obvious action-needed state at the top
- immediate surfacing of recent failures
- fast links into failed traces and failed runs
- enough density to feel like an operator surface rather than a marketing page

This matches the intended operator-home direction materially better than the earlier v1 implementation did.

### 2. The investigative spine is real

The `Traces` list is fast enough to be useful and the `?peek=` interaction works well on desktop:

- list on the left
- persistent detail on the right
- no context loss when inspecting a trace

This is the strongest current control-plane interaction pattern.

### 3. Records is still a separate mental model

`/dashboard/records` still feels like:

- connector inventory
- owner-data browser

rather than part of the same investigative lineage as traces/grants/runs.

In live use, that separation is more obvious than it is from the code alone:

- the page is useful
- but it does not feel like it belongs to the same “debug the system” workflow
- it reads as a neighboring tool, not a joined-up operator surface

## Live UX gaps

### 1. The console still feels read-only in the bad sense

The UI reads well, but there are no obvious “do the thing” affordances:

- no run now
- no retry failed run
- no scheduler status/control
- no pending approval inbox
- no obvious token/bootstrap controls

Live effect:

- the dashboard answers “what happened?”
- it still does not answer “what should I do next from here?”

### 2. Mobile is acceptable, not good

The narrow pass confirms the code audit:

- the UI remains readable
- navigation survives
- overview cards stack safely

But it still feels like compressed desktop operations UI:

- very long scroll depth
- dense lists become tiring quickly
- investigative list/detail workflows lose their advantage once the detail pane stacks below the list

This is not broken mobile. It is just not yet operator-grade mobile.

### 3. Records is especially weak on mobile

Because Records already lacks strong lineage/debug integration, the mobile experience amplifies that weakness:

- you browse a lot
- but you do not get much explanatory context back
- there are few strong pivots out of Records into runs/grants/traces

### 4. Overview is useful, but still operationally incomplete

In live use, the missing elements are clear:

- scheduler health/state
- pending interactions / approvals
- token/bootstrap visibility
- connector staleness / freshness health
- obvious quick actions

## Planning implications

The next control-plane tranche should treat these as the highest-value UX truths:

1. keep the current overview and investigative-spine strengths
2. add a real operator-action layer, not just more inspection chrome
3. integrate Records back into lineage/debug workflows
4. treat mobile as a second-pass operator workflow problem, not just responsive CSS

## Artifacts

The live pass produced screenshots during review, including:

- `dashboard-overview-desktop.png`
- `dashboard-overview-mobile.png`
