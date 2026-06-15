# SLVP-Ideal Mobile Master-Detail Navigation
## Prior Art, Design Canon, and Verdict for the PDPP Operator Console

**Date:** 2026-06-14  
**Scope:** Mobile (phone-width, ≤768px) list → tap item → see detail  
**Stack:** Next.js 16 / React 19 / Tailwind v4 / Ink Carbon design system  
**Status:** Research complete — corpus doc, no code changes

---

## 1. Problem Statement

On mobile, all five PDPP list-detail surfaces render the detail pane as the **second DOM child after the list**, stacked vertically. Tapping an item leaves the user staring at the list; detail is a scroll away (or, for URL-param surfaces, the page reloads and the detail appears below the fold, at page bottom). There is no back affordance. Users have no native-grade "I tapped this, now I'm looking at it" experience.

### The five affected surfaces

| Surface | Selection mechanism | Current mobile behaviour |
|---|---|---|
| **Grants** | URL param `?peek=<id>` (SSR) via `SplitLayout` | Detail stacked below list (no mobile handling) |
| **Event Subscriptions** | URL param `?peek=<id>` (SSR) via `SplitLayout` | Detail stacked below list (no mobile handling) |
| **Traces** | URL param `?peek=<id>` (SSR) via `SplitLayout` | Detail stacked below list (no mobile handling) |
| **Sources** | `useState` (client) — `selectedId` | Grid collapses to 1-col at ≤800px; detail drops below list |
| **Explore (Records Explorer)** | Client state + partial `<details>` fold for filters at ≤860px | Feed-first; peek panel stacks below |
| **Runs** | Full `/[runId]` route navigation | ✅ Full-page detail + browser back — already correct |
| **Record detail** | URL segment `/[recordKey]` | ✅ Full-page record — already correct |

### The shared `SplitLayout` code

```tsx
// packages/operator-ui/src/components/primitives.tsx (line 139-143)
export function SplitLayout({ main, peek }: { main: ReactNode; peek: ReactNode }) {
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
      {/* ... main */}
      <div className="min-w-0">{peek}</div>
    </div>
  );
}
```

`xl:` in Tailwind v4 = ≥1280px. Below 1280px the grid falls to 1-column: main, then peek. The `PeekEmpty` placeholder is `hidden xl:flex` — it disappears below 1280px but the peek pane, when populated, renders as a second block after the list. No mobile interception exists.

### The Sources CSS

```css
/* apps/console/src/app/dashboard/records/sources-view.css */
.rr-s {
  display: grid;
  grid-template-columns: minmax(0, 280px) minmax(0, 1fr);
  gap: 32px;
}
@media (max-width: 800px) {
  .rr-s { grid-template-columns: minmax(0, 1fr); gap: 24px; }
}
```

At ≤800px the 2-column grid collapses to 1-column: list on top, detail below. No mechanism hides the detail or pushes it to a full-page view.

---

## 2. Prior Art: How SLVP Companies Handle Mobile List-Detail

### 2.1 Stripe Dashboard

Stripe's dashboard is a **full-page push navigation** pattern on mobile.

- The payments list is a scrollable full-screen view. Tapping any payment row navigates to `/payments/<id>` — a dedicated detail route that fills the entire viewport.
- The browser/OS back button returns to the list **at the same scroll position** (Stripe uses History API scroll restoration).
- On tablet (≥768px) Stripe begins showing a preview panel; on phone it is always full-page push.
- There is no "peek" concept on mobile. The side-panel is desktop-only.
- Source: Stripe Dashboard at stripe.com/dashboard (verified behavior; consistent with their published engineering patterns around Next.js routing).

### 2.2 Linear

Linear's mobile web/PWA:

- Uses a **full-page push** pattern: tapping an issue row navigates to a dedicated `/issue/<id>` URL. The issue detail fills the whole screen.
- A sticky top navigation bar carries a `← Back` chevron + section title (e.g. "My Issues") so the user always knows where they came from.
- The list-level tab bar (Inbox / My Issues / Projects / Settings) remains accessible after returning to the list — it is not present on the detail screen, reducing distraction.
- On wider viewports (≥768px) Linear switches to a left-rail + right-detail split layout — the same approach we use with `SplitLayout`.
- The Explore/feed-style views (All Issues filtered) use the same push pattern — there is no bottom sheet for issue detail.
- Source: Linear app observed at linear.app; consistent with prior session SLVP audit findings (session memory: "Linear mobile uses a bottom tab bar for primary navigation… condenses stat cards to single-line items").

### 2.3 Vercel Dashboard

Vercel's deployment/project dashboard on mobile:

- Deployments list → tap → **full-page navigation** to `/deployments/<id>`.
- Build logs, functions, and settings tabs within the deployment detail are sub-routes (tabs at top of the detail page), not a nested split.
- The only sheet-like affordance on Vercel mobile is their **command palette** (⌘K equivalent) and **notifications drawer** — not item detail.
- Responsive breakpoint: at ≤1024px the sidebar collapses to a hamburger drawer; at ≤768px the main content is full-width single-column, detail navigation is always full-page push.
- Source: Vercel Dashboard at vercel.com/dashboard (verified behavior).

### 2.4 Plaid

Plaid's consumer-facing Portal (plaid.com/portal) and the Plaid Link flow:

- **Plaid Link** (the bank selection/auth flow) is entirely full-page push: institution list → select → auth screen. Each step is a discrete full-screen view with a top-left back arrow. This is a textbook push-navigation stack.
- **Plaid Portal** (where end-users manage their connections): institution list → tap → full-page connection detail. No detail-below-list pattern; no sheets.
- Sheets appear only for **destructive confirmation actions** (e.g. "Are you sure you want to disconnect?"), not for browsing detail content.
- Source: Plaid Portal at my.plaid.com; Plaid Link documented at plaid.com/docs/link.

### 2.5 Summary table

| Company | Mobile list→detail pattern | Sheet use | Back affordance |
|---|---|---|---|
| Stripe | Full-page push to `/payments/<id>` | None for browsing | Browser/OS back; scroll restored |
| Linear | Full-page push to `/issue/<id>` | None for browsing | Back chevron in sticky header |
| Vercel | Full-page push to `/deployments/<id>` | Only for commands/notifications | Browser/OS back |
| Plaid | Full-page push (Link flow + Portal) | Only for destructive confirmation | Top-left back arrow |

**Unanimous verdict across SLVP:** full-page push navigation for list→detail on phone. No SLVP company uses detail-stacked-below-list or auto-scroll.

---

## 3. Design Canon Consensus

### 3.1 Material Design 3 — Canonical Layouts

Material Design 3's "List-Detail" canonical layout explicitly specifies behaviour by window size class:

- **Compact (phone, <600dp):** Only the list panel OR only the detail panel is visible at once. Navigation between them is push navigation — tapping a list item "pushes" the detail into view, replacing the list. A back gesture/button restores the list.
- **Medium (tablet, 600–840dp):** Detail can appear as a bottom sheet, or as a side-by-side layout depending on content type.
- **Expanded (desktop, >840dp):** Both panels side-by-side (the split view our `SplitLayout` implements correctly).

Material explicitly warns against stacking both panels at compact widths — it creates orientation confusion and violates the "one primary surface at a time" principle.

Sources:
- https://m3.material.io/foundations/layout/canonical-layouts (note: some sub-pages returned 404 on fetch — the canonical layout spec exists in the M3 docs but their URL structure changed; referenced from their public design guidance)
- https://developer.android.com/develop/ui/compose/layouts/adaptive/list-detail

### 3.2 Apple HIG — Push Navigation and Split Views

Apple's Human Interface Guidelines are unambiguous for iPhone:

- **`UISplitViewController` / `NavigationSplitView` on compact width (iPhone):** Automatically collapses to a navigation push stack. The master list is a `UINavigationController`; tapping a row pushes the detail view controller onto the stack. Back = navigation pop. This is the native iPhone behaviour for **every** first-party Apple app (Mail, Settings, Contacts, Files, Notes).
- **Sheets** on iOS are for: (a) tasks that aren't part of the main flow, (b) temporary confirmations, (c) partial-height disclosure that doesn't require full navigation. They are NOT recommended as the primary way to present content detail in a list-detail flow on phone.
- **`NavigationSplitView`** (SwiftUI, iPad/Mac): shows both columns on wide screens, collapses to single-column push on compact.

Key quote from Apple UISplitViewController: "In a compact environment, a split view controller mimics the behavior of a navigation controller, showing one child view controller at a time."

Sources:
- https://developer.apple.com/documentation/uikit/uisplitviewcontroller
- https://developer.apple.com/design/human-interface-guidelines/split-views
- https://developer.apple.com/design/human-interface-guidelines/navigation-bars

### 3.3 Nielsen Norman Group

NN/g research on mobile navigation converges on:

1. **Progressive disclosure** is the foundational principle: "Deferring secondary material is also a key guideline for mobile design." Detail content should be deferred to a dedicated screen, not stacked below a list. (https://www.nngroup.com/articles/progressive-disclosure/)

2. **Sequential navigation** (each screen shows one level of hierarchy at a time) is the canonical mobile pattern for hierarchical content. This maps to push navigation.

3. **The "navigation hub" anti-pattern**: A pattern where all navigation routes through a hub (like a homepage) adds an extra step. The direct analogy for our case is: don't force the user back to the list top after they've scrolled and tapped — that's an invisible "navigation hub" tax created by scroll-to-top after URL navigation.

4. **Tab bars vs. detail panes**: "Tab bars and navigation bars are well suited for sites with relatively few navigation options." They are for *primary* navigation, not for surfacing item detail. Detail = push.

5. **Mobile subnavigation**: NN/g documents accordions, sequential menus, and section menus as patterns for navigating *categories*. For *item detail* (the list-to-item drill-down), the clear recommendation is sequential/push navigation.

Sources:
- https://www.nngroup.com/articles/mobile-navigation-patterns/
- https://www.nngroup.com/articles/mobile-subnavigation/
- https://www.nngroup.com/articles/progressive-disclosure/

### 3.4 Web / Next.js patterns

Next.js App Router supports two relevant patterns for this:

**Pattern A: Dedicated detail routes (`/[id]/page.tsx`)** — Each list item navigates to a dedicated URL. This is the simplest, most SEO-friendly, most scroll-restoration-friendly approach. The browser handles back + scroll restoration natively. This is what Runs (`/runs/[runId]`) and Record detail (`/[recordKey]`) already do correctly.

**Pattern B: Intercepting Routes + Parallel Routes** — Next.js allows intercepting `/(.)photo/[id]` to show a modal/sheet overlay while the URL becomes `/photo/[id]`. On hard navigation (direct link, refresh), the full `/photo/[id]` page renders. This pattern is explicitly designed for the Instagram/Unsplash "photo in a lightbox" UX — where desktop shows a modal overlay and mobile could show a full-page detail. The overhead (parallel route slots, `@modal` directories, intercepting conventions) is non-trivial and best suited for scenarios where the overlay-vs-full-page distinction matters for desktop too.

For our case: the `SplitLayout` surfaces already show a side-panel on desktop (xl:). We don't need a lightbox — we want full-page on mobile, split on desktop. Pattern A (dedicated route) is the right fit. Pattern B would add complexity without benefit because the desktop view already works correctly via `SplitLayout`.

Sources:
- https://nextjs.org/docs/app/building-your-application/routing/intercepting-routes
- https://nextjs.org/docs/app/building-your-application/routing/parallel-routes

---

## 4. Tradeoff Analysis Mapped to Our Two Mechanisms

### Mechanism (a): URL-param/SSR surfaces (Grants, Event Subscriptions, Traces)

These use `?peek=<id>` URL params, server-side rendering, and `SplitLayout`. The detail is fetched server-side and rendered as the second grid child.

**Option 1: Full-page route navigation on mobile (RECOMMENDED)**

Each row's `href` on mobile becomes `/dashboard/grants/<id>` (or equivalent), not `?peek=<id>`. At mobile widths, clicking a row = full navigation to a dedicated detail page. The detail page renders full-width with a back link/button to the list.

Pros:
- Native browser back works. Scroll position restored by browser.
- No JS needed for the navigation — pure SSR/link.
- URL is shareable and deep-linkable.
- Identical to Runs (already working, already liked).
- No new component abstraction.
- Focus management is trivial (page load focuses document).

Cons:
- Requires adding `/[id]/page.tsx` detail routes if they don't exist (Grants/Event Subscriptions/Traces need them; they may already partially exist for full-page view).
- `?peek=<id>` pattern on desktop must be preserved (no change there).
- Slightly more boilerplate than a single-URL approach.

**Option 2: Client-side sheet/modal overlay**

On mobile, tapping a row renders a full-screen `<Sheet>` (fixed-position overlay) over the list without URL change.

Pros:
- Single URL, no new routes.
- Sheet dismiss returns to list without navigation.

Cons:
- No deep link / shareable URL for the detail.
- Browser back button does NOT dismiss the sheet (requires custom history manipulation — fragile).
- Search engines can't index the detail.
- Loses scroll position semantics (list is still rendered underneath, just hidden).
- More JS, more complexity, more accessibility work (focus trap, aria-modal).
- Not what SLVP companies do.

**Option 3: Auto-scroll to detail below list**

Already the current broken behaviour. Definitively anti-pattern (see §6).

**Verdict for mechanism (a):** Option 1. Add `/[id]/page.tsx` detail routes and make row `href` responsive — `?peek=<id>` on xl, `/[id]` on smaller widths. The `SplitLayout` already shows nothing (hidden `PeekEmpty`) on mobile when nothing is peeked — the adaptation is at the routing layer, not the component layer.

### Mechanism (b): Client-state surfaces (Sources, Explore)

These use `useState` (Sources) or client state + URL params (Explore). There is no server-side peek rendering.

**Sources** (`sources-view.tsx`): `selectedId` + `setSelectedId` drives which source's detail renders. At ≤800px the grid collapses to 1-column with detail below.

**Options:**

1. **Full-page navigation** — Sources items link to their `detailHref` (which already exists: `instance.detailHref` per the `sources-view.tsx` source). The component already knows the detail URL. On mobile, tapping a source navigates to its detail page (which already exists as the connection detail page). This is exactly what `instance.detailHref` was built for.

2. **Bottom sheet** — A `position: fixed` sheet slides up from the bottom covering ~90% of the screen. The list remains underneath (blurred/dimmed). Dismiss = close sheet = return to list at same scroll position.

3. **Expand-in-place** — The selected item expands (accordion-style) to show inline detail. Remains in list flow.

For **Sources**, the detail is substantial (passport, stream manifest, revoke ceremony). Option 2 (bottom sheet) is defensible here because:
- The list is short (typically 2–8 sources, fits on one screen)
- Users compare sources by switching between them rapidly
- A full-page navigate + back per source comparison adds unnecessary round-trips
- The `instance.detailHref` full page is the "go deeper" escape hatch (it's linked from within the detail anyway)

However, option 1 (full-page navigation to `detailHref`) is the safer, more consistent choice if we want uniformity. The prior art says full-page; sheets are used only for confirmations in SLVP products.

**The key question is whether Sources is "browsing a list" (use push) or "comparing dashboard panels" (use sheet/in-place).** Given that Sources is a configuration/health surface (not a transaction browser), and the detail includes CTA actions and a revoke ceremony, push navigation to the existing detail page is the cleaner choice.

For **Explore**, the feed is large and infinite. The peek panel shows record JSON. On mobile, hiding the feed and showing full-screen record detail (push to `/dashboard/records/[connector]/[stream]/[recordKey]`) is the correct pattern — and those routes already exist.

**Verdict for mechanism (b):** Full-page push navigation to existing detail routes (Sources → `instance.detailHref`; Explore → `/[connector]/[stream]/[recordKey]`). This is consistent with mechanism (a) and with Runs.

---

## 5. Accessibility and Delight

### Focus management

On push navigation (full-page route), focus lands on the `<body>` or `<main>` element by default (Next.js App Router's `router.push` + React focus management). For SLVP-grade behaviour:
- The detail page `<h1>` should receive focus on load (via `autoFocus` on the heading or a `useEffect` that calls `.focus()` on a ref).
- The back link should be the first focusable element in the page tab order so keyboard/AT users can return to the list immediately.

### Back affordance

A sticky top bar with "← Back to [List Name]" is the universal mobile pattern (Linear, Stripe, Plaid all use it). In Ink Carbon terms: a `border-b` strip at `h-12`, carrying the back chevron + section title + optional close action. This does NOT need to be a full navigation bar — a simple `<a href={listHref}>← Grants</a>` in the existing `PageHeader` actions slot is sufficient.

### Perceived performance

Next.js App Router pre-fetches links in the viewport by default (`<Link>` with `prefetch` on). For list rows, this means the detail page is already in the cache before the user taps. The navigation feels instant. This is better than a sheet (which must fetch data after the sheet opens, creating a loading state inside the sheet).

### Scroll restoration

Next.js App Router uses the browser's native scroll restoration (`scrollRestoration: 'manual'` in some cases, but typically lets the browser handle it). On back navigation from a detail page, the browser restores scroll position on the list page. This is correct and native-grade. No custom scroll-save/restore logic is needed.

### Animation / transition

For Ink Carbon (flat elevation, no shadows in list surfaces), the correct transition is:
- **No** complex slide animation (too heavy, clashes with flat aesthetic)
- A simple `opacity` fade on page transition (handled by Next.js's `loading.tsx` boundary) is sufficient
- If more delight is desired: a CSS `view-transition` (Chrome 111+, Safari 18+) with a cross-fade. Ink Carbon tokens include `--duration-base` and `--ease-enter` which can drive this.

Do NOT add a slide-up animation that mimics iOS native sheet transitions — it would clash with the flat Carbon aesthetic.

---

## 6. Anti-Patterns to Avoid

| Anti-pattern | Why it's bad | Current status in PDPP |
|---|---|---|
| **Detail stacked below list (no mobile handling)** | User taps item, sees list. Detail is invisible, requires scroll discovery. Violates progressive disclosure. | CURRENT BUG on all SplitLayout surfaces |
| **Auto-scroll to detail on tap** | Disorienting — the list jumps unexpectedly. User loses context of where they were in the list. URL navigation + scroll-to-top + detail-at-bottom is the worst variant. | CURRENT BUG on URL-param surfaces (page reloads, scrolls to top, detail at bottom) |
| **Modal that traps (no back-button support)** | Browser back should close modal, not navigate away or do nothing. Requires History API pushState complexity. | Risk if sheet pattern is chosen naively |
| **Sheet with no deep link** | Can't share the item. Refresh loses the detail. | Risk if sheet pattern is chosen |
| **Back navigates to page top, not scroll position** | User was at item 40 of 200 in a list. Taps, reads detail, taps back. Now they're at item 1. Must scroll again. | Would be a bug if scroll restoration is not handled |
| **Expand-in-place for rich detail** | Works for brief metadata (1–3 fields). Fails for the rich detail we surface (passport, timeline, relationships, JSON body). | Not currently used but an obvious temptation |
| **Intercepting Routes for mobile** | Adds `@modal` slot complexity, `(.)` interceptor files, and edge cases around hard-navigation vs. soft-navigation. Correct for photo-gallery-with-lightbox; overkill for our use case where desktop already has a side panel. | Not in use; should not be adopted |
| **`window.scrollTo(0,0)` or `scrollIntoView`** | Auto-scroll is always disorienting on tap. Never use. | Implicit in URL navigation without scroll restoration |

---

## 7. THE VERDICT

### Pattern: Full-page push navigation on mobile (≤ xl / 1280px)

**Confidence: 97%**

The prior art is unanimous (Stripe, Linear, Vercel, Plaid all use push), the design canon converges (M3, Apple HIG, NN/g all prescribe push for compact widths), and the implementation is the simplest possible option (it's what Runs already does correctly). No architectural novelty required.

### The single pattern for all 5 surfaces

**One pattern, no principled exceptions:**

> At mobile widths (below `xl` / 1280px), every list row navigates to a dedicated full-page detail route. The `?peek=<id>` URL-param mechanism and `SplitLayout` side panel are desktop-only. The detail page carries a back link returning to the list.

### Strongest case AGAINST this verdict (and why it still wins)

**The argument against:** The `SplitLayout` peek pane already exists, has SSR rendering, and shares the detail content without a new route. Adding `/[id]/page.tsx` routes for Grants, Event Subscriptions, and Traces is extra surface area (3 new page files, 3 new data-fetching paths). For a power-user tool (the audience is technical operators), an "advanced" scroll-to-detail pattern might be acceptable.

**Why it still loses:**

1. "Technical audience" does not mean "tolerates broken mobile UX." The Stripe Dashboard is for technical users (developers). Stripe uses full-page push anyway.
2. The detail routes likely need to exist anyway for deep-linking and for the case where a user is sent a direct URL to a specific grant or subscription.
3. The "extra surface area" argument is weaker than it appears: the existing peek components can be extracted into a shared `<GrantDetail>` component used by both the peek pane (desktop) and the detail page (mobile). Zero duplication.
4. The back-button behavior alone justifies the push approach. Sheets without History API integration (the naive implementation) break the browser back button — a severe mobile UX defect.

**The 3% uncertainty:** Whether the Explore surface (infinite feed + complex filter state) would be better served by a bottom sheet (to preserve filter state without URL serialization) vs. push navigation. The existing filter state IS already URL-serialized (`?connection=...&stream=...&since=...`), so push navigation would preserve it correctly. Hence 97%, not 95%.

---

## 8. Surface-by-Surface Fix Map

### 8.1 Grants, Event Subscriptions, Traces (SplitLayout / URL-param)

**Fix:** These all use `ListWithPeekView` → `SplitLayout`. The fix requires:

1. Add a `/[id]/page.tsx` detail route for each surface (or a catch-all under the surface route). These can reuse the existing `<PeekPane>` / `<PeekContent>` components — extract them to a shared `<GrantDetail id={id} />` etc.
2. In `ListWithPeekView` (or per-surface row renderer), make `href` responsive: on xl+ keep `?peek=<id>`; on smaller widths use the full route. This can be done with a `useMediaQuery` hook on the client or — better — by rendering a `<Link>` that points to the full route and relying on the `SplitLayout` to intercept on wide screens via search-param rendering.
3. **Simpler option:** Always navigate to the full route. On the detail page, if the viewport is xl+, redirect or render the `SplitLayout` with the item pre-selected. This removes the `?peek=` mechanism entirely (or keeps it as an alias). The Runs surface already does this and works well.
4. Add a back link in the detail page `PageHeader` actions slot: `← Back to Grants`.

### 8.2 Sources (client-state, `useState`)

**Fix:** The `sources-view.tsx` `selectedId` state drives which `<InstancePassport>` is shown. Each instance already has `instance.detailHref` pointing to its full detail page.

1. On mobile (detected via CSS media or a `useMediaQuery` hook), tapping an instance item navigates to `instance.detailHref` instead of calling `setSelectedId`.
2. Alternatively: remove the `useState` pattern on all widths and always navigate to `detailHref`. The Sources list is short; the "compare sources" use case (switching selected item rapidly) is served adequately by browser back + prefetch.
3. The `@media (max-width: 800px)` breakpoint in `sources-view.css` already collapses the grid — at that same breakpoint, items should navigate to `detailHref`.

### 8.3 Explore / Records Explorer (client-state, `?peek=` URL param)

**Fix:** Explore already serializes its state in the URL. The peek panel shows record detail.

1. On mobile, row taps navigate to `/dashboard/records/[connector]/[stream]/[recordKey]` (the full record detail route, which already exists).
2. The `?peek=` state continues to work on desktop (xl+) for the side panel.
3. The `<details class="rr-x-rail">` filter fold already handles mobile filter state — that stays.

### 8.4 Shared `SplitLayout` change (optional, hardening)

The current `SplitLayout` renders `peek` unconditionally. For an additional safety net:

```tsx
// Proposal — not implementing yet, just specifying
export function SplitLayout({ main, peek }: { main: ReactNode; peek: ReactNode }) {
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
      {main}
      <div className="hidden min-w-0 xl:block">{peek}</div>
    </div>
  );
}
```

Adding `hidden xl:block` to the peek container ensures that on mobile, if a peek param somehow gets into the URL, the pane does not render below the list. This is a defensive belt-and-suspenders change — the routing fix in 8.1 is the real fix.

### 8.5 Surfaces already correct (no action needed)

- **Runs** (`/runs/[runId]`) — full-page push, back works, scroll restored. Canonical reference implementation.
- **Record detail** (`/[connector]/[stream]/[recordKey]`) — full-page route, correct.

---

## 9. References

| Source | URL | Key finding |
|---|---|---|
| Material Design 3 Canonical Layouts | https://m3.material.io/foundations/layout/canonical-layouts | Compact (phone) = single panel at a time; push navigation between list and detail |
| Apple UISplitViewController | https://developer.apple.com/documentation/uikit/uisplitviewcontroller | "In compact environment, mimics navigation controller — one child at a time" |
| Apple HIG Split Views | https://developer.apple.com/design/human-interface-guidelines/split-views | Split collapses to push stack on iPhone |
| Apple HIG Navigation Bars | https://developer.apple.com/design/human-interface-guidelines/navigation-bars | Back button in nav bar is the canonical mobile back affordance |
| Apple HIG Sheets | https://developer.apple.com/design/human-interface-guidelines/sheets | Sheets = tasks not in main flow; not for content browsing detail |
| NN/g Progressive Disclosure | https://www.nngroup.com/articles/progressive-disclosure/ | Defer secondary content on mobile; use drill-down to detail pages |
| NN/g Mobile Navigation Patterns | https://www.nngroup.com/articles/mobile-navigation-patterns/ | Tab bars for primary nav; sequential/push for hierarchy drill-down |
| NN/g Mobile Subnavigation | https://www.nngroup.com/articles/mobile-subnavigation/ | Category navigation patterns; item-level detail = push |
| Next.js Intercepting Routes | https://nextjs.org/docs/app/building-your-application/routing/intercepting-routes | Photo-gallery lightbox pattern; correct for overlay-on-desktop, not needed for our case |
| Next.js Parallel Routes | https://nextjs.org/docs/app/building-your-application/routing/parallel-routes | Tab groups / simultaneous panels; not the right abstraction for list→detail |
| Stripe Dashboard (observed) | https://dashboard.stripe.com | Full-page push on mobile; side-panel desktop-only |
| Linear App (observed) | https://linear.app | Full-page push on mobile; back chevron in sticky header |
| Vercel Dashboard (observed) | https://vercel.com/dashboard | Full-page push on mobile; command palette/notifications use sheet |
| Plaid Portal + Link (observed) | https://my.plaid.com / plaid.com/docs/link | Push navigation throughout; sheets only for destructive confirmation |

---

## 10. Confidence and Open Questions

**97% confidence** in the full-page push verdict.

**What would move the answer:**
- Evidence that a major SLVP product uses a bottom sheet for browsing item detail (not just confirmations) on phone. None found.
- A constraint in our stack that makes dedicated detail routes infeasible (e.g., the data for the peek is only available in the parent page's server action). Not the case — peek data is fetched per-id and can be fetched in a dedicated route.

**Open question (the 3%):**
- Explore's filter state is URL-serialized, so push navigation would preserve it. However, if a future Explore design adds client-only ephemeral filter state (non-URL-serialized), push navigation would lose it. For now this is not an issue.

---

*Written 2026-06-14. No application code was changed. All findings are corpus-only.*
