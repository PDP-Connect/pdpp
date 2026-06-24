# Explore loading states — SLVP-ideal, Next.js-canonical, design-system motion

Status: DESIGN (Claude RI, 2026-06-20). Tim: "not clear when there is a loading state"
+ "make sure we are making proper use of motion ... we considered it heavily in design
system iterations."

## What's already there
- `loading.tsx` EXISTS (route Suspense fallback: ListLoadingSkeleton + `animate-pulse`,
  `aria-busy`, `role=status`). Covers INITIAL load + hard segment navigations. Sibling
  routes all have one — established pattern.
- Row record-detail / stream nav uses `<Link>` (gets loading.tsx coverage, no inline pending).

## The gap (the actual complaint)
Every IN-PAGE interaction goes through `navigate()` -> `router.push` to the SAME route with
new searchParams (filters, sort toggle, range chips, search submit, Load-more, peek, "N new"
pill). A soft same-route push does NOT trigger `loading.tsx` (no segment change), so there is
NO visible feedback while the server re-renders. That is what feels broken.

## Design-system MOTION vocabulary (use these — do NOT invent)
`packages/pdpp-brand/base.css` motion tokens (duration x ease pairs):
- `--motion-enter`, `--motion-exit`, `--motion-state` (button/surface), `--motion-feedback`
  (spring, for tactile button feedback), `--motion-projection`.
Keyframes already defined: `@keyframes spin`, `fade-in`, `slide-up` (base.css);
`rr-fade-in`, `rr-drawer-in` (shell.css). `prefers-reduced-motion: reduce` is ALREADY
honored (base.css:199, ink-carbon.css:148, shell.css) — any new motion MUST honor it too.
Existing loading motion = Tailwind `animate-pulse` on skeleton bars + `aria-busy` +
`role=status`. The `rr-x-*` Explore classes live in `packages/pdpp-brand-react/src/components.css`.

## The fix (Next.js official patterns + design-system motion)
1. **router.push -> useTransition.** Wrap the `router.push(href)` in `navigate` in
   `startTransition`; expose `isPending`. This is THE App Router pattern for
   router.push-driven loading (loading.tsx does not fire on soft same-route pushes).
2. **Top progress bar (the Vercel/Linear signature).** A thin route-progress bar at the top
   of the Explore canvas, shown while `isPending`. Token-based motion: `fade-in` to appear,
   an indeterminate slide using existing keyframes / `--motion-*` durations; respects
   reduced-motion (fall back to a static visible bar, no animation). This is the single most
   SLVP-ideal global "the view is updating" signal.
3. **Load-more pending (the most acute case).** While its push is pending: button disabled,
   label -> "Loading…" with a `spin` indicator (existing `@keyframes spin`), `aria-busy`.
   Reuse `.pdpp-btn`'s `--motion-feedback`/`--motion-state`. This directly fixes "click Load
   more, nothing happens for a beat."
4. **Feed busy affordance.** While `isPending`, the feed region gets `aria-busy="true"` and a
   subtle opacity dim via `transition: opacity var(--motion-state)` (matches components.css
   precedent) so it's clear the current view is refreshing without yanking content.
5. **Row `<Link>` inline pending (Next canonical).** Add `useLinkStatus()` (`{ pending }`)
   inline feedback on the record-detail/stream row links — a subtle shimmer/`is-pending` on
   the clicked row while navigation completes (covers slow detail opens beyond loading.tsx).
6. **Keep loading.tsx** for initial/segment loads. Do NOT duplicate it.

## Acceptance
- Clicking a filter chip / sort / range / search / Load-more / "N new" shows IMMEDIATE
  feedback (progress bar + button/feed busy state) while the server round-trips.
- Load-more button is disabled + shows a spinner while its page loads; re-enables on arrival.
- All motion uses `--motion-*` tokens / existing keyframes; `prefers-reduced-motion: reduce`
  disables animation (static visible state, never a flash).
- a11y: `aria-busy`, `role=status` / `aria-live=polite` on the progress indicator; the
  spinner is `aria-hidden` with a text label.
- No new motion library (design system is CSS-token based, no framer-motion). No bespoke
  durations/eases — tokens only.
- Test: the pending wiring is unit-testable via the extracted navigation/pending helper
  (mirror explore-navigation.ts precedent) OR a behavioral assert that navigate runs inside a
  transition and Load-more disables while pending.
