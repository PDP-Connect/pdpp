# Owner Console — Mobile / Responsive / Craft Prior Art

**Date:** 2026-06-18
**Owner:** Claude (Lens 9 — mobile/responsive/craft)
**Status:** Research complete — corpus doc, no application code changed.
**Why this note exists (and what existing doc it extends):** The PDPP owner console "feels fairly vibe-coded" (the owner, verbatim). Craft is not decoration — for a self-hostable tool that asks the owner to trust it with *all* their personal data and to grant AI apps read access, felt craft *is* the trust signal. A wobbly touch target, a row that doesn't react when tapped, a spinner with no progress, or a slide animation that fights the layout all read as "this is unfinished, don't trust it with my bank data." This note **extends `slvp-ideal-mobile-master-detail-2026-06-14.md`** (which already settled the *structural* verdict: full-page push navigation below `xl`/1280px for all 5 list-detail surfaces, side-panel desktop-only, **97% confidence** — that figure is stated verbatim in that doc at "**Confidence: 97%**" / "**97% confidence** in the full-page push verdict," with the 3% reserved for the Explore-feed bottom-sheet tension). That doc answered *what layout*. This doc answers the **craft contracts underneath it**: minimum touch target, row affordance on touch, selected/focus visual treatment, the master-detail breakpoint behavior at the *interaction* level, and a catalog of **motion that communicates state, not decoration**. It also pulls in the access-transparency surfaces from `explorer-workbench-and-access-transparency-prior-art-2026-06-18.md` (the "what does ChatGPT have access to" surface must survive at phone width too).

---

## 1. Prior-art sources

Each source below was fetched and indexed on **2026-06-18**. Two intended sources — Apple Human Interface Guidelines pages (`developer.apple.com/design/...`) and the live Material Design 3 site (`m3.material.io`) — are JavaScript-rendered single-page apps and returned empty/near-empty bodies through a plain HTTP fetch (and `developer.apple.com` DNS-timed-out repeatedly through the research host). Where I rely on their guidance I (a) cite the **Android Developers** docs and **WCAG/web.dev/NN/g**, which restate the same engineering rules in fetchable form, and (b) explicitly label any remaining claim "(observed product behavior, not a fetched citation)."

1. **WCAG 2.2 SC 2.5.8 Target Size (Minimum)** — https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html (retrieved 2026-06-18). Pattern: pointer targets must be **≥ 24×24 CSS px**, with five exceptions. The most useful for dense lists is the **Spacing** exception: an undersized target is allowed *if* a 24px-diameter circle centered on its bounding box does not intersect the circle of any adjacent target — i.e. small icon buttons are acceptable only when surrounded by ≥24px of clearance. Also the **Inline** exception (links inside flowing text are exempt; line-height governs them) and **Equivalent** (a small control is exempt if an equivalent larger control achieves the same function on the page).

2. **NN/g — Touch Targets on Touchscreens** (Aurora Harley) — https://www.nngroup.com/articles/touch-target-size/ (retrieved 2026-06-18). Pattern: recommended minimum is **1cm × 1cm (~0.4in, ≈ 38–44 CSS px)** physical size — larger than the WCAG AA floor. "Crowding causes errors": stacked thin buttons/links too close together cause mis-taps (slips); even a *near*-miss "adds to the perception that the interface is difficult to use." Bigger is warranted for **primary CTAs** and **mobile/in-motion contexts** (Target app uses ~2cm×2cm scan/search buttons). Directly relevant: the console's stacked row actions and small status pills.

3. **Android Developers — Build a list-detail layout (`NavigableListDetailPaneScaffold`)** — https://developer.android.com/develop/ui/compose/layouts/adaptive/list-detail (retrieved 2026-06-18). This is the fetchable, engineering-grade restatement of Material 3's list-detail canonical layout. Patterns: the scaffold **adapts by window size** — large windows show list+detail side-by-side; **small windows show only one pane at a time, switching as the user navigates**. Back behavior is a *named, explicit contract*: `PopUntilScaffoldValueChange` (recommended) means in single-pane (phone) "pressing back will skip through content changes within the detail view and return to the list view, as this represents a clear layout change," while in multi-pane (desktop) back may exit the flow because no layout change occurred. The key craft idea: **back semantics differ by breakpoint and that difference is designed, not accidental.**

4. **Android Developers — Material Design 3 in Compose** — https://developer.android.com/develop/ui/compose/designsystems/material3 (retrieved 2026-06-18). Fetchable restatement of M3's interaction-state and ripple/state-layer model: components express state (hover/focus/pressed/dragged) through **state layers** (a translucent overlay of the content/primary color at a defined opacity) rather than ad-hoc color swaps, so every interactive element reacts consistently to touch and focus.

5. **WCAG 2.1 SC 2.3.3 Animation from Interactions** — https://www.w3.org/WAI/WCAG21/Understanding/animation-from-interactions.html (retrieved 2026-06-18). Pattern: motion *triggered by interaction* (scroll, transition) must be disable-able; the canonical mechanism is honoring `prefers-reduced-motion`. Example given: "a non-essential transition when loading new content … a page-flipping animation that respects the `prefers-reduced-motion` CSS media query." Essential animation (where motion *is* the information) is exempt.

6. **web.dev — `prefers-reduced-motion`: Sometimes less movement is more** (Thomas Steiner) — https://web.dev/articles/prefers-reduced-motion (retrieved 2026-06-18). Pattern + code: "some users outright experience motion sickness when faced with parallax scrolling, zooming effects." The media query detects an OS-level request to minimize motion; design a **motion-reduced variant**. Baseline: widely available across browsers since Jan 2020. Practical guidance: default to *no* large-movement animation and *add* it only inside `@media (prefers-reduced-motion: no-preference)`.

7. **MDN — `prefers-reduced-motion`** — https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion (retrieved 2026-06-18). Pattern: the two values `no-preference` and `reduce`; the standard idiom is to keep essential opacity/color transitions and drop transforms/translates under `reduce`.

8. **NN/g — The Role of Animation and Motion in UX** (Page Laubheimer) — https://www.nngroup.com/articles/animation-purpose-ux/ (retrieved 2026-06-18). Pattern (the spine of this lens's motion catalog): "Animation in UX must be **unobtrusive, brief, and subtle**. Use it for **feedback, state-change and navigation metaphors, and to enhance signifiers**" — *not* "to induce delight or entertain." Names **attention-grabbing vs attention-hijacking**: motion that makes a subtle signifier obvious is good; gratuitous motion is a distraction and, when used to manufacture urgency/loss, a dark pattern.

9. **NN/g — Skeleton Screens 101** (Samhita Tankala) — https://www.nngroup.com/articles/skeleton-screens/ (retrieved 2026-06-18). Pattern: choose the loading indicator by **expected duration**: spinners/skeletons for **<10s**, **progress bars for >10s** ("they give users a sense of the state of the system and of how much longer they have to wait. Anything above 10 seconds requires an explicit estimation of duration"). Spinners suit a *single module*; skeleton screens suit *full-screen* loads because the wireframe previews layout and lowers cognitive load. Animated shimmer keeps users engaged but "can potentially be distracting … or create accessibility problems."

10. **WCAG 2.2 SC 2.5.8 Spacing exception (detail)** — same URL as (1), retrieved 2026-06-18. Used for the dense-list / icon-button clearance contract in §4.

11. **GitHub Mobile (product page)** — https://github.com/mobile (retrieved 2026-06-18). Pattern: GitHub's strategy for small screens is *task triage on the go*, not a shrunk-down desktop — notifications, issues, PR review, and now "assign issues to Copilot and get a ready-to-review pull request … refine, iterate, approve and merge—all directly within GitHub Mobile." The mobile surface is a *first-class, purpose-built* view of the same data, not a responsive afterthought.

12. **GitHub Docs — Filtering and searching issues and pull requests** — https://docs.github.com/en/issues/tracking-your-work-with-issues/filtering-and-searching-issues-and-pull-requests (retrieved 2026-06-18). Pattern: filters expressed as a stable, shareable query (review status, requested-reviewer, etc.) — the same filter grammar drives desktop and mobile, so a narrowed view survives a breakpoint change. Relevant to keeping Explore's "6 of 1,183" basis label and filter state intact across widths.

13. **Stripe — Express Dashboard** — https://docs.stripe.com/connect/express-dashboard (retrieved 2026-06-18). Pattern: Stripe's mobile-accessible dashboards are **delivered in a real web browser**, explicitly *not* inside embedded webviews ("Express users must access the Dashboard in a web browser, not in embedded web views inside mobile or desktop applications"). Reinforces: the responsive web view is the product surface; rely on real browser back/scroll-restoration/`prefers-reduced-motion`, don't reinvent them.

14. **Linear — Method (Principles & Practices)** — https://linear.app/method/introduction (retrieved 2026-06-18; page is SPA-thin on fetch, principle list rendered client-side). Pattern (principles visible in the fetched nav + observed product behavior): "Build for the creators," opinionated defaults, and **speed as a feature** — Linear's UI commits state changes optimistically (the row updates the instant you act; the network reconciles behind it) and is keyboard-first. *(Linear's specific optimistic-UI and command-motion behaviors below are observed product behavior, not a fetched citation, since the marketing page renders client-side.)*

15. **Apple Human Interface Guidelines — Accessibility / Buttons / Motion / Layout** — `developer.apple.com/design/human-interface-guidelines/` (attempted 2026-06-18; pages are JS-rendered SPAs and returned empty bodies / DNS timeouts via the research host). The well-known HIG rules I lean on — **44×44 pt minimum hit target**, split-views collapsing to a navigation push stack on compact iPhone width with a back chevron + title bar, and "Reduce Motion" replacing slide/zoom transitions with cross-fades — are therefore labeled **(observed product behavior, not a fetched citation)** and cross-anchored to the fetchable Android/WCAG sources above.

---

## 2. Observed patterns (cross-source synthesis)

**P1 — There are two touch-target floors, and SLVP picks the higher one.** WCAG AA is **24×24 CSS px** (a *legal* floor, source 1). NN/g and Apple converge on the *craft* floor of **~44 CSS px / 1cm** (sources 2, 15). The difference matters: 24px passes an audit; 44px *feels* trustworthy. Vibe-coded UIs sit at the audit floor (or below) with no clearance; crafted ones sit at the higher floor with deliberate spacing.

**P2 — Crowding, not just size, causes the "hard to use" feeling.** NN/g (2) and WCAG's Spacing exception (1, 10) both say a *small* target is tolerable only when *isolated*; stacked thin controls close together produce slips and the *perception* of fragility even when no error occurs. Felt craft is as much about gaps as sizes.

**P3 — One pane at a time on phone, with designed back semantics.** Android/M3 (3) and Apple split-views (15) agree: compact width shows a single pane and navigating *is* a layout change; back returns to the list. This is the interaction-level confirmation of the structural verdict already in `slvp-ideal-mobile-master-detail`. The novel addition here: back behavior is a *named contract* (`PopUntilScaffoldValueChange`), not an accident — selecting a different item on desktop is *not* a back-stack entry, but drilling in on phone *is*.

**P4 — Every interactive element must visibly react to touch and focus, via a consistent state model.** M3 state layers (4) and Apple's pressed/highlight states (15) make pressed/hover/focus a *systematic* overlay, not a per-component hack. A row that doesn't change under a finger reads as dead/broken — a core "vibe-coded" tell.

**P5 — Motion is for feedback, state-change, and navigation metaphor — never delight-for-its-own-sake.** NN/g (8): unobtrusive, brief, subtle; enhance signifiers. Decorative/attention-hijacking motion is a defect (and sometimes a dark pattern). Motion that *communicates state* (this saved; this is loading; this is terminal; this moved here) earns its place; everything else is removed.

**P6 — Match the wait indicator to the wait length, and graduate to real progress past 10s.** NN/g (9): <10s → spinner (single module) or skeleton (full screen); >10s → progress bar with a duration estimate. This is the direct fix for the owner's local-recovery "blinking cursor, no progress indicator."

**P7 — Always honor `prefers-reduced-motion`; design the reduced variant first.** WCAG 2.3.3 (5), web.dev (6), MDN (7): keep opacity/color, drop transforms under `reduce`. Essential motion (where the movement *is* the information) is exempt but rare in this console.

**P8 — The responsive web view is a first-class surface, not a shrink.** GitHub Mobile (11) and Stripe (13) treat the small-screen experience as a purpose-built triage view delivered in a real browser — leaning on native back, scroll restoration, and OS motion prefs rather than reimplementing them. Filter grammar (12) is shared across widths so a narrowed view survives a breakpoint flip.

**P9 — Optimism + keyboard = perceived speed (Linear).** State changes apply instantly in the UI and reconcile with the server afterward (14, observed). The perceived-craft win is that the interface never makes you wait on the network to *see* your own action land.

---

## 3. PDPP implications (tied to specific surfaces and the owner's complaints)

| the owner's complaint (proof phrase) | Craft root cause | Surface |
|---|---|---|
| "feels fairly vibe-coded" | Targets at/under the audit floor; rows don't react to touch; ad-hoc motion; spinners without progress | Whole console, sharpest on phone |
| "blinking cursor; no progress indicator" (local recovery) | Long (>10s) operation shown with no progress model (P6) | Local-collector recovery / CLI-handoff surface |
| "no indication of what yellow and green mean" | Color-only state with no label and no state-layer/legend system (P4) | Sources / connector-health pills |
| bounded sample "6 of 1,183" without basis label or full-set path | Truncation shown without a basis chip or "see all" affordance; on phone the basis label is the first thing to get clipped (P8, P2) | Explore / Records Explorer |
| jump-to-ID "undiscoverable / no feedback" | Control too small to find on touch, and no motion/state confirming the jump landed (P1, P5) | Explore |
| "can't tell if I'm looking at a source or a connection" | No selected/focus treatment distinguishing the active row; on phone both collapse into an undifferentiated stack (P3, P4) | Sources |
| can't answer "what does ChatGPT have access to / what did ChatGPT read" | Access-transparency surface (Grants) must survive phone width as a readable single pane, not a clipped split (P3, P8; extends explorer/access-transparency doc) | Grants |
| "One Thing Needs You" vs "three things wrong" | Priority motion/emphasis must point at the *one* actionable thing without hijacking attention to all three (P5) | Overview / hero |
| wall-of-text status copy ("Suppressed evidence. Drain detail gap backlog.") | At phone width this wraps to an unreadable block; needs truncation + tap-to-expand, not a wall (P8) | Run/trace status |

Concretely, the structural fix from `slvp-ideal-mobile-master-detail` (push-nav below 1280px) is necessary but **not sufficient** to kill "vibe-coded." Even a correct push-nav feels cheap if (a) rows are 28px tall with no pressed state, (b) the detail page fades in with a janky transform that ignores `prefers-reduced-motion`, (c) the back chevron is a 16px icon with no label, and (d) the local-recovery screen still shows a blinking cursor. This lens supplies the contracts that make the correct structure *feel* SLVP.

---

## 4. Concrete affordance / copy / IA recommendations

### 4.1 Touch-target contract (name the tokens)

- **Minimum interactive height/width: 44 CSS px** for any standalone touch target (rows, buttons, pills-as-buttons, the jump-to-ID trigger, back chevron). This is the NN/g/Apple craft floor (sources 2, 15), above the WCAG 24px legal floor (source 1).
- **List rows:** target ≥ **48px** row height on touch (`min-h-12`), full-row tap area (the whole row is the link/button, not just the title text).
- **Icon-only buttons** (revoke, overflow, copy-ID): visual glyph may be ~20px but the *hit area* must be ≥44px (`p-3` around a 20px icon). If a glyph must stay small, satisfy WCAG's **Spacing exception**: keep ≥24px clearance so a 24px circle on each doesn't intersect a neighbor (source 1, 10).
- **Inline links inside body copy** (e.g. an ID inside a sentence) are exempt under WCAG's Inline exception — do *not* pad them to 44px; instead set readable line-height. Only *standalone* controls get the 44px floor.
- **Spacing between stacked actions:** ≥ **8px** gap minimum, ≥12px preferred, to avoid the slip/"hard to use" perception (source 2).
- Define these as Ink Carbon tokens (`--touch-min: 44px`, `--row-touch-h: 48px`, `--hit-pad: 12px`) so the floor is enforced in one place, not re-litigated per component.

### 4.2 Row affordance on touch (the "this is tappable / I tapped it" contract)

- **Whole row is the target.** Wrap the row in the `<Link>`/`<button>`, not an inner `<a>` on the title only.
- **Pressed state via a state layer** (source 4): on `:active`/`pressed`, overlay a translucent token (`bg-[--state-pressed]`, e.g. content color at ~8–12% opacity) for the full row. This is the single biggest "is this thing alive?" signal on touch and the cheapest fix for the vibe-coded feel.
- **No hover-only affordances on touch.** Anything that only appears on `:hover` (e.g. a reveal-on-hover action) is invisible on phone — promote it to always-visible or to the detail page.
- **Chevron/disclosure glyph** on rows that push to a detail page (`›` right-aligned) so the row reads as "drills in," distinguishing it from a row that only selects.

### 4.3 Selected / focus visual treatment (kills "source or connection?" confusion)

- **Selected (desktop split, the peeked row):** a 2–3px **leading accent bar** (`border-l-2 border-[--accent]`) + a subtle tonal background (state layer at ~12%). Not color-alone — pair the accent with a persistent state.
- **Focus (keyboard/AT):** a visible **2px focus ring** (`outline outline-2 outline-offset-2 outline-[--focus]`) that is *not* removed by `outline-none`. Focus and selection are *different* states and must look different (focus = "where the keyboard is," selected = "what's open in the detail pane").
- **Source vs connection differentiation:** give the row a **typed leading affordance** — a source row carries a source-kind glyph + the label "Source," a connection row carries a connection glyph + "Connection," and the selected one gets the accent bar. The confusion is currently caused by *identical* rows; a typed icon + a one-word kind label resolves it without new screens (ties to the owner's "can't tell if I'm looking at a source or a connection").

### 4.4 Master-detail breakpoint behavior at the interaction level (extends the structural doc)

- **Breakpoint:** keep the existing `xl` (1280px) split/push boundary from `slvp-ideal-mobile-master-detail`. Below it, **one pane at a time** (source 3, 15).
- **Back contract by breakpoint (name it like `NavigableListDetailPaneScaffold` does, source 3):**
  - *Phone (push):* drilling into a detail page **is** a history entry; OS/browser back returns to the list at restored scroll. The detail page carries a **labeled** back affordance: `‹ Grants` (chevron + section name), placed as the first focusable element, ≥44px hit area, in the `PageHeader` actions slot.
  - *Desktop (split):* selecting a different row updates the peek pane and is **not** a separate back entry — back leaves the surface, matching the multi-pane `PopUntilScaffoldValueChange` semantics. This prevents "back button does nothing / cycles selections" confusion on desktop.
- **Focus on navigate:** on phone push, move focus to the detail `<h1>` (or a `tabIndex={-1}` heading ref `.focus()` on mount) so AT users and keyboard users land in the detail, not back at the top of the document.
- **Header/title bar on detail:** sticky `h-12` strip, `border-b`, carrying `‹ [Section]` + the item title. Mirrors Linear/Stripe/Plaid back bars already cited in the structural doc.

### 4.5 Motion-communicates-state catalog (the core deliverable — short, named patterns)

Every entry: **what state it communicates**, the **motion**, the **duration**, and the **`prefers-reduced-motion: reduce` fallback**. Default posture: author the *reduced* variant first, then add motion inside `@media (prefers-reduced-motion: no-preference)` (sources 5, 6, 7). NN/g rule (8): unobtrusive, brief, subtle; feedback/state/navigation only.

| Pattern | State it communicates | Motion (no-preference) | Duration | `reduce` fallback |
|---|---|---|---|---|
| **Row press** | "I registered your tap" | State-layer overlay fades in on `:active` | ≤100ms | Instant overlay (opacity step, no transform) |
| **Pane transition (phone push)** | "You moved from list → detail" | Cross-fade + ≤8px directional nudge | ~200ms | Cross-fade only (no translate) — matches Apple "Reduce Motion" cross-fade (15) |
| **Optimistic apply** — *non-destructive only* (enable, rename, reorder, toggle a setting) | "Your action landed *now*; server is reconciling" | Row updates immediately; a subtle in-progress shimmer on just that row until confirmed (Linear-style, 14 observed) | immediate + ≤10s shimmer | Immediate state change + static "Saving…" text label |
| **Destructive apply** — *NOT optimistic* (revoke a grant, delete a connection, disconnect a source) | "You are about to do something hard to undo" → then "It's done" | Explicit **confirm step first** (modal/inline confirm, type-to-confirm for delete); only *after* confirm does the row update, with a brief settle + a time-boxed **Undo** affordance if the action supports rollback | confirm gate, then ≤300ms settle | Confirm gate + immediate static state change + static "Undo" link (no shimmer) |
| **Loading <10s, full screen** | "The page is materializing" | Skeleton screen matching the real layout (source 9) | until ready | Static skeleton (no shimmer sweep) |
| **Loading <10s, single module** | "This card is working" | Inline spinner on that module only (source 9) | until ready | Static "Loading…" label |
| **Loading >10s (local recovery / backfill / run)** | "How far along and how much longer" | **Determinate progress bar** with %/step + ETA text (source 9) — *the fix for "blinking cursor"* | until done | Same bar (progress is essential info, not decoration → exempt from reduce) |
| **Success / terminal-good** | "This completed" | Brief checkmark draw + settle, then persist as a static success badge | ≤300ms then static | Static success badge immediately |
| **Terminal-bad / failed** | "This ended and needs you" | No celebratory motion; static error state + a single attention pulse on the *one* actionable CTA (source 8 — grab attention without hijacking) | one pulse, ≤400ms | Static error state + persistent CTA, no pulse |
| **Priority emphasis ("One Thing Needs You")** | "Start here" | One gentle entrance/scale on the single primary card; the other items are static (source 8) | ≤300ms, once | Static visual emphasis (weight/contrast), no motion |
| **Jump-to-ID landed** | "Your jump worked, this is the row" | Target row gets a brief highlight flash (state layer pulse) + scroll-into-view (source 8) | ≤500ms | Scroll-into-view + static highlight border for ~2s, no flash |

Cross-cutting rules: no parallax, no zoom-on-scroll, no decorative looping motion (sources 5, 6, 8 — motion-sickness + dark-pattern risk). If motion can be removed without losing information, it must be removable via `reduce`. If it *carries* the information (progress bar fill, jump-target highlight position), it stays under `reduce` but in a non-vestibular form (no large translate/scale).

**Optimistic-apply guardrail (load-bearing — read before implementing the "Optimistic apply" row):** optimism is a *perceived-speed* affordance for **non-destructive, easily-reversible** changes only. **Destructive actions — above all `revoke a grant` (the owner is removing an AI app's access to their personal data), plus delete-connection and disconnect-source — MUST NOT be applied optimistically/silently.** A revoke is a security-relevant, hard-to-undo action; making it feel instant invites mis-taps with real consequences. Route those through the **Destructive apply** row: an explicit confirm gate first (type-to-confirm for true deletes, per the console's existing revoke/delete danger-zone ceremony), then a definite state change, then a time-boxed Undo only where the backend genuinely supports rollback. Never show a "Saving… / reconciling" shimmer that implies the destructive change is provisional when it is in fact committed. This is the §7 caveat made normative; do not implement revoke from the optimistic row by mistake.

### 4.6 Status copy at phone width (the wall-of-text fix)

- **Truncate-then-expand:** status strings like "Suppressed evidence. Drain detail gap backlog." render as a **one-line clamped summary** (`line-clamp-1`) with a tap target to expand. Lead with a **plain-language headline** ("Catching up on detail" / "Paused — needs your sign-in") and put the jargon behind disclosure. Ties to the wall-of-text complaint and to the copy/clarity lens.
- **Legend for color states** (yellow/green): pair every status color with a **text label always** (never color-alone — also an accessibility requirement) and a **one-tap legend** ("What do these mean?") on the Sources/health surface. Fixes "no indication of what yellow and green mean."
- **Basis chip for bounded samples:** "Showing 6 of 1,183 (most recent)" as a persistent chip above the list, with a **"See all 1,183"** target ≥44px. On phone the chip must not be the first thing clipped — pin it, don't let it scroll off (P8). Fixes the "6 of 1,183 without basis label or full-set path" complaint.

---

## 5. Anti-patterns to avoid

| Anti-pattern | Why it's bad | Source |
|---|---|---|
| Targets at the 24px WCAG floor (or below) with no clearance | Passes audit, *feels* cheap and causes slips; the literal mechanism of "vibe-coded" | 1, 2 |
| Hover-only affordances on touch surfaces | Invisible on phone; the action effectively doesn't exist | 2, P4 |
| Rows that don't visibly react to a finger (no pressed state) | Reads as dead/broken; top "is this thing alive?" failure | 4 |
| Color-only status (yellow/green) with no label | Inaccessible and uninterpretable — exactly the owner's complaint | P4 |
| Same back behavior on phone and desktop | Desktop back "does nothing" or cycles selections; phone loses the list — back semantics must differ by breakpoint | 3 |
| Slide/transform transitions that ignore `prefers-reduced-motion` | Motion sickness; WCAG 2.3.3 violation | 5, 6, 7 |
| Decorative/looping/parallax motion, urgency animations | Distraction; attention-hijacking; sometimes a dark pattern | 8 |
| Spinner (or blinking cursor) for a >10s operation | No sense of progress or completion → the local-recovery complaint | 9 |
| Wall-of-text status copy unclamped at phone width | Unreadable block; jargon-first | P8 |
| Bounded sample with no basis chip / no "see all," chip scrolls off on phone | Owner can't tell what they're looking at or how to see the rest | 12, P8 |
| Reinventing back/scroll-restoration/motion-prefs instead of using the browser | Fragile; SLVP products lean on the real browser | 11, 13 |
| Animated shimmer skeletons everywhere | Can distract / cause a11y issues; use plain skeletons, gate shimmer behind `no-preference` | 9 |

---

## 6. Acceptance checks (testable, owner-walkable)

A reviewer on a phone (≤768px) and with browser devtools should be able to verify each:

1. **Touch floor:** Every standalone interactive control (row, button, pill-button, jump-to-ID trigger, back chevron, overflow/revoke icons) has a hit area ≥ 44×44 CSS px — the NN/g ~1cm craft floor (source 2), comfortably above the WCAG 24px legal floor (source 1). Small glyphs that fall below it have ≥24px clearance to neighbors. (Measure in devtools; spot-check Sources, Grants, Explore.)
2. **Row press:** Pressing and holding any list row shows a visible pressed/state-layer change before release. No interactive row is visually inert under a finger.
3. **Selected vs focus distinct:** On desktop, the peeked row shows the accent bar + tonal background; keyboard-tabbing shows a *different* focus ring. The two states never look identical.
4. **Source vs connection legible:** On the Sources surface, a source row and a connection row are distinguishable by a typed glyph + one-word kind label without opening either.
5. **Push back contract:** On phone, tapping a Grants/Subscriptions/Traces/Sources/Explore row opens a full-page detail; browser/OS back returns to the list at the prior scroll position; the detail shows a *labeled* `‹ [Section]` back affordance as the first focusable element.
6. **Focus on navigate:** After a phone push, keyboard focus is in the detail (heading), not at the top of the document.
7. **Reduced motion:** With OS "Reduce Motion" on (or `prefers-reduced-motion: reduce` emulated in devtools), all transform/slide/scale transitions are replaced by opacity/instant changes; no parallax or looping motion plays. Essential progress bars still fill.
8. **Wait indicators match duration:** A <10s full-screen load shows a layout-matching skeleton; a single-module load shows an inline spinner; a >10s operation (local recovery / backfill / run) shows a **determinate progress bar with step/% and ETA** — no blinking cursor, no infinite spinner.
9. **Status copy clamps:** Long status strings render as a one-line plain-language summary with a tap-to-expand; jargon ("Suppressed evidence…") is not the first thing the owner reads and does not wrap into an unreadable block on phone.
10. **Color + label:** Every yellow/green status carries a text label, and a one-tap legend explains the colors on the health surface.
11. **Basis chip survives phone:** Explore shows "Showing N of M (basis)" pinned above the list with a ≥44px "See all M" target that remains visible (does not scroll off) at phone width.
12. **Access-transparency at phone width:** The Grants detail (what an app has access to / what it read) renders as a readable single pane on phone — no clipped two-column split, back affordance present.
13. **Destructive actions are not optimistic:** Revoking a grant, deleting a connection, and disconnecting a source each require an explicit confirm step (type-to-confirm for true deletes) *before* the row changes — the change never appears applied while a "Saving…/reconciling" shimmer implies it is still provisional. Any non-destructive toggle (enable/rename/reorder) MAY apply optimistically; a destructive action MAY NOT.

---

## 7. Open gaps / where prior art is still thin for PDPP

- **Apple HIG and live M3 pages are SPA-rendered** and could not be fetched through the research host (plain HTTP returns empty bodies; `developer.apple.com` also DNS-timed-out). The Apple-specific claims — the **44×44 pt** minimum hit target, split-view-collapses-to-push on compact width, and "Reduce Motion → cross-fade" — are therefore labeled **(observed product behavior, not a fetched citation)** in source 15 and are *cross-anchored* to fetchable sources (Android list-detail, WCAG 2.5.8, web.dev/MDN reduced-motion). **The operative, normatively-citable touch floor in this doc is the fetchable NN/g figure (source 2): ~1cm / ≈38–44 CSS px**, not the Apple "44pt" number. A reviewer who wants to quote the exact Apple **44pt** value normatively MUST confirm it from a browser-rendered HIG page first; do not cite "44pt per Apple HIG" as a fetched fact on the strength of this doc alone.
- **Linear's optimistic-UI and command-driven motion** are observed product behavior; the Method page renders client-side (source 14, labeled). The *principle* (perceived speed via optimistic apply) is sound for non-destructive changes, but the exact reconciliation/error-rollback UX should be validated against the real app before copying it. **It must NOT be copied for destructive actions** — revoking a grant, deleting a connection, or disconnecting a source must use the explicit confirm-gate path in §4.5's "Destructive apply" row, never silent optimism. (See the §4.5 optimistic-apply guardrail, which makes this normative.)
- **No SLVP source uses a bottom sheet for browsing item detail on phone** (confirmed again here) — but PDPP's Sources "compare two sources quickly" use case is mildly underserved by pure push-nav; this lens defers to the structural doc's **97%** push verdict (stated verbatim there) and flags it only as a known 3% tension, not a recommendation to add sheets.

---

*Written 2026-06-18. No application code changed. Extends `docs/research/slvp-ideal-mobile-master-detail-2026-06-14.md` and cross-references `docs/research/explorer-workbench-and-access-transparency-prior-art-2026-06-18.md`.*
