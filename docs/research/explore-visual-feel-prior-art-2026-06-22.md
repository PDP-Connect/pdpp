# Explore visual-feel layer — SLVP prior art (2026-06-22)

Targeted research filling the gap the existing corpus did NOT cover: the VISUAL-FEEL layer of a record feed (row anatomy, type hierarchy, loading-feedback placement, facet-rail/operator clarity). Existing ~25 Explore docs cover LOGIC; this covers LOOK & FEEL. Drives the redesign for Tim's 'doesn't feel SLVP' critical pass.

## feed-row-anatomy-density

I now have comprehensive, well-sourced material across all the dimensions asked. I have enough to synthesize a concrete, grounded answer. Let me compile the findings.

---

# Record-Feed Row Anatomy: SLVP-Grade Prior Art

## (a) Specific findings, each tied to a named product/design-system

**1. Linear — dense single-line row (~32px), 4px grid, muted-with-pops hierarchy.** A Linear issue row packs title, status, priority, assignee, labels, project, and cycle into one ~32px line and still reads clean. The mechanism: every element aligns to a 4px grid (padding, icon sizes, text all multiples of 4), and the palette is grey-heavy — most text/icons sit at 40–60% opacity, with only status/priority/interactive elements getting full-saturation color. This produces instant in-row hierarchy (status + priority pop; title + assignee recede) without any element shouting. Density works *because* the grid is tight, not despite it. Source: [925 Studios — Linear design breakdown](https://www.925studios.co/blog/linear-design-breakdown-saas-ui-2026), [performance.dev — How is Linear so fast](https://performance.dev/how-is-linear-so-fast-a-technical-breakdown).

**2. GitHub Primer ActionList — explicit two-line "block description" pattern + reserved-space leading visuals.** Primer's row model is the most concrete spec available. Leading visuals reserve a fixed area via `leadingVisualSize`: **octicons take 16px, avatars take 20px**, and to center-align a mixed list you place 16px octicons inside the 20px area. Descriptions have two variants set via `variant`: `inline` (default, secondary text *beside* the label, can `truncate` with ellipsis) and `block` (secondary text on a *second line below* the label) — this is the canonical primary+secondary two-line row. Trailing visual/trailing text sits right-aligned for status, counters, labels, or a right-arrow ("more options after selecting"). Source: [Primer ActionList](https://primer.style/components/action-list/), [Primer ActionList guidelines](https://primer.style/product/components/action-list/).

**3. Sentry issue stream — content-rich row, NOT metadata-only.** Each row carries: **title** (the actual error message, e.g. "This is an example Python exception"), **culprit** (where it happened — `raven.scripts.runner in main`), an inline **sparkline graph** of event volume over 24h, an **event count**, and a **last-seen** relative timestamp. Critically, the two primary text lines are *content* (error + location), not "error · service · time." The row is self-explanatory at a glance and the sparkline encodes trend without a click. Source: [Sentry Issues docs](https://docs.sentry.io/product/issues/), [Sentry issue-details](https://docs.sentry.io/product/issues/issue-details/).

**4. Stripe Dashboard — transaction row = amount + merchant/description + status + time, click-row → detail overlay.** Stripe's payments/transactions list is one-payment-intent-per-row showing **amount, status, description/merchant context, and timestamp** — i.e. real transaction content (merchant + money), never bare type metadata. The "click for more" affordance is a persistent behavior: clicking any row opens a payment-detail **overlay** (the same component Stripe ships as an embeddable "payment-details" element), not an inline expand. Source: [Stripe payment-details component](https://docs.stripe.com/connect/supported-embedded-components/payment-details), [Stripe Dashboard basics](https://docs.stripe.com/dashboard/basics).

**5. Airtable — row height is the density/content-preview dial (Short default → taller = more content per record).** Airtable defaults to **Short** row height = one line of text + small thumbnails for "maximum density of records"; the three taller options progressively reveal multiple lines of text, multiple linked records, multiple select options, and larger images. Explicit, named tradeoff: shorter = more records visible; taller = more *content per record*. Every row is anchored by the **primary field** (the record's title). Press Space to expand a row into a full vertical detail panel. Source: [Airtable grid view](https://support.airtable.com/docs/airtable-grid-view), [Airtable record detail](https://support.airtable.com/docs/airtable-interface-layout-record-detail).

**6. Notion list view — minimal title-first row with properties pushed to the far right + peek-on-open.** Notion's list view deliberately drops the grid: just the **item title** (primary, clickable) with selected **properties at the far right**, drag-reorderable and visibility-toggleable. Opening a row uses **Side peek / Center peek / Full page** — a progressive-disclosure spectrum rather than navigating away. List view is recommended specifically when you "don't need a ton of properties." Source: [Notion lists](https://www.notion.com/help/lists), [Notion using-database-views](https://www.notion.com/help/guides/using-database-views).

**7. Activity-feed canon (Microsoft Teams / Aubergine) — the "complete story" rule for a row.** The standard feed-row anatomy is **avatar (actor) + activity-type icon + title (actor + reason) + text preview (truncated snippet) + timestamp + location**. The explicit guidance: a row must tell a *self-contained story* — avatars alone are insufficient ("a team member may not recognize the actor," so show the actor name *and* a concise description), and a text preview "saves [the user] time" so they don't click into each item to understand it. Best practices: light-weight icons, abbreviate time ("min" not "m"), remove redundancy, don't overload the row with controls. Source: [Microsoft Teams activity-feed design](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/design/activity-feed-notifications), [Aubergine chronological feeds guide](https://www.aubergine.co/insights/a-guide-to-designing-chronological-activity-feeds).

## (b) The consensus pattern

Across all of these, a polished record/activity/transaction row converges on the same shape:

- **Leading type-glyph or avatar** in a fixed-size slot (Primer: 16px octicon / 20px avatar) so the row is scannable *by category* at a glance, every row's content left-aligned to the same x-position.
- **A primary line that is CONTENT, not a type label** — the error message, the merchant + amount, the message snippet, the record title — i.e. something a human recognizes (Airtable primary field, Sentry title, Stripe merchant/amount, Notion item title). "What is this?" is answered by the content, not by a `<type>` token.
- **A secondary line/segment of meaningful context** — Sentry's culprit (where), Stripe's status, the feed's truncated preview, or Primer's block description. This is *where the source/type/time live*, but they ride *alongside* content, never replacing it.
- **Time as a recede-able, abbreviated, right-aligned secondary detail** — present but never the headline.
- **Density is a dial, not a fixed choice.** Short/one-line dense (Linear ~32px, Airtable Short) for triage; a taller two-line variant (Primer block description, Airtable taller heights) when content preview earns the pixels. The one-line variant still survives because the *content* is on it.
- **"Click for more" is a persistent, low-clutter behavior, not a button.** The whole row is the target → a peek/overlay/detail panel (Stripe overlay, Notion side/center peek, Airtable Space-to-expand). Hover reveals *secondary actions*, not the primary affordance.
- **Hierarchy by muted-with-pops color + tight grid, not by borders.** Linear's 40–60%-opacity baseline with saturation reserved for status; dividers are optional hairlines (Primer `showDividers` is off by default, inset to align with content), not zebra striping.

**On the stated anti-pattern (`<type> · <source> · <time>` with no content):** No SLVP-grade product does this. Every one surfaces real content on the primary line — Stripe shows the merchant and amount (not "charge · acct · 2h"), Sentry shows the error and culprit (not "error · prod · 5m"), the activity-feed literature explicitly warns that avatar/metadata alone is insufficient and that a preview must let the user "view this information from the feed" without clicking in. A metadata-only row is the canonical *debug-log* look: it forces a click to learn what every row actually is, which is exactly the friction these products designed away. It is unambiguously low-signal.

## (c) Concrete RECOMMENDATION for a personal-data record-feed row

Default to a **two-line row, content-first, ~48–56px tall**, on a tight 4px grid:

**Leading slot (fixed 20px, left edge):** a per-source / per-type glyph or favicon-style avatar (email, message, transaction, order, etc.) so the eye triages by category before reading. One consistent x-anchor for all row content (Primer's inset model).

**Line 1 — primary content (the headline IS data, not a type label):** the most human-recognizable field for that record — message subject/first line, transaction merchant + amount, order item, email sender + subject. Title-cased, full-opacity, single line, `truncate` with ellipsis (Primer inline+truncate). This is the line that must answer "what is this?" without a click.

**Line 2 — secondary context (muted, ~60% opacity):** a one-line content preview/snippet *plus* the lightweight metadata that belongs here — source name and an abbreviated relative time, right-aligned ("3 min", "Jun 21"). Source/type/time live here as supporting detail, never as the headline. Model this on Primer's `variant="block"` description and Sentry's title→culprit pairing.

**Trailing slot (right-aligned):** abbreviated timestamp + an optional status pill or count, in muted color with saturation only when it signals something actionable (Linear's muted-with-pops). No persistent chevron.

**Affordance:** the entire row is the click target → opens a **side-peek / overlay detail** (Stripe/Notion model), not an inline expand and not a "View" button. Reserve hover-reveal strictly for *secondary* actions.

**Density control:** offer a one-line **Compact** variant (Linear ~32px / Airtable Short) that keeps line 1's content and demotes line 2 to inline-truncated, for users scanning hundreds of records — but the *default* is two-line because a personal-data feed mixes heterogeneous record types where a content preview is what makes a stranger's data legible.

**Dividers:** optional hairline insets aligned to the content x-anchor (Primer `showDividers`), or none with adequate vertical rhythm — never zebra striping.

**The one rule that separates "polished product" from "debug log":** never ship a row whose primary line is `<type> · <source> · <time>`. Put real content (merchant, subject, snippet, item) on line 1; relegate source and time to the muted secondary line. Every SLVP exemplar (Stripe, Sentry, Linear, Notion, Airtable) does exactly this, and the activity-feed literature codifies it as the "self-contained story" requirement.

Sources: [925 Studios Linear breakdown](https://www.925studios.co/blog/linear-design-breakdown-saas-ui-2026), [performance.dev Linear](https://performance.dev/how-is-linear-so-fast-a-technical-breakdown), [Primer ActionList](https://primer.style/components/action-list/), [Primer ActionList guidelines](https://primer.style/product/components/action-list/), [Sentry Issues](https://docs.sentry.io/product/issues/), [Sentry issue-details](https://docs.sentry.io/product/issues/issue-details/), [Stripe payment-details component](https://docs.stripe.com/connect/supported-embedded-components/payment-details), [Stripe Dashboard basics](https://docs.stripe.com/dashboard/basics), [Airtable grid view](https://support.airtable.com/docs/airtable-grid-view), [Airtable record detail](https://support.airtable.com/docs/airtable-interface-layout-record-detail), [Notion lists](https://www.notion.com/help/lists), [Notion database views](https://www.notion.com/help/guides/using-database-views), [Microsoft Teams activity-feed design](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/design/activity-feed-notifications), [Aubergine chronological feeds guide](https://www.aubergine.co/insights/a-guide-to-designing-chronological-activity-feeds).

---

## feed-type-hierarchy-monospace

The Linear file doesn't exist at that path, but I have ample Linear-relevant data from shadcn/Inter (which Linear's aesthetic shares) and strong primary sources for the other six systems. I have everything needed. Let me synthesize the final report.

Here is my synthesized research report.

---

# SLVP Typography in Dense Record Feeds — Research Findings

## (a) Findings — each tied to a named product/design system + source

**1. Vercel Geist is explicit: sans sets UI+prose, mono is reserved for code/data/tabular — and this is the cleanest statement of the exact decision in question.**
Geist's official spec says verbatim: *"Geist Sans sets UI and prose; Geist Mono sets code, data, and tabular figures... The `-mono` tokens pair Geist Mono with the same metrics; prefer tabular figures when numbers need to align."* The type scale has paired tokens — `label-14` (Geist Sans, 14px/400) for human text and `label-14-mono` / `label-13-mono` (Geist Mono, 14px/13px, 400) for IDs/codes/data — same size and metrics, only the family swaps. So mono is a **per-field family override on otherwise-sans rows**, never the row default. Body paragraphs are *never* set in mono; their breakdown lists "Mono for the technical layer only... Body paragraphs never set in mono."
Source: https://vercel.com/design.md and https://vercel.com/geist/typography ; mirror: https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/design-md/vercel/DESIGN.md

**2. GitHub Primer: build hierarchy with font WEIGHT and SIZE, NOT color — color is explicitly de-prioritized as an emphasis tool.**
Primer's guidance: *"Adjust font weight to add emphasis and differentiate content hierarchy"* and *"Refrain from utilizing color as a primary method of emphasis."* Secondary text uses the `fgColor-muted` token; primary uses `fgColor-default`. Weight tokens are `--base-text-weight-normal` (400), `-medium` (500), `-semibold` (600). A hard token rule: on `bgColor-muted` backgrounds use `fgColor-default` and **NEVER** `fgColor-muted` (it fails the 4.5:1 WCAG AA body-text contrast). Lighter weights are capped — they reduce legibility below 20px.
Source: https://primer.style/foundations/typography/ and https://github.com/primer/primitives/blob/main/DESIGN_TOKENS_GUIDE.md

**3. Stripe (Söhne / "sohne-var"): money and numerics get `tnum` tabular figures — NOT a monospace font.**
Stripe's body-tabular token is *the same Söhne sans* at 14px with `font-feature-settings: "tnum"` plus slightly tightened tracking (−0.42px). The guidance: *"Any cell rendering currency, transaction amounts, or numeric counts uses `tnum`... The brand quietly signals its financial DNA through this micro-detail."* The broadly-cited engineering rule: *"If you're using a monospace font purely to stop digits from jittering, you almost certainly want `font-variant-numeric: tabular-nums` instead — one property, no font swap. The trade-off of going full monospace is stylistic: your dashboard now looks like a terminal."* Stripe's text tiers: ink/near-black primary, `ink-secondary #273951` for secondary text on white.
Source: https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/design-md/stripe/DESIGN.md and https://dev.to/alanwest/tabular-numbers-in-css-font-variant-numeric-vs-monospace-hacks-25cn

**4. Raycast — a literally text-driven, command-palette product — uses ZERO monospace in its UI; everything is Inter.**
*"There is no monospace face used outside of inline `<code>` chips in documentation; the marketing/UI pages use Inter for everything."* Raycast is the proof that "looks like a dev tool" does **not** require mono. Its hierarchy is built from a tight weight/size/opacity ladder on one sans: row primary = 14px/500, secondary = 14px/400, metadata/caption = 13px/400. Color tiers are opacity-based: primary `#ffffff` (`on-dark`), secondary `rgba(255,255,255,0.72)` (`on-dark-mute`), metadata `#9c9c9d` (`mute`). The brand signature is a stylistic-set detail (`ss03` alternate `g`), not mono.
Source: https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/design-md/raycast/DESIGN.md ; analysis: https://getdesign.md/raycast/design-md

**5. Vercel's own UI-table token shows the canonical two-tier row: mono ONLY in the header eyebrow, sans-medium for the data emphasis.**
Geist's `data-table` recipe: *"Header uses caption-mono uppercase mono; body uses body-sm."* Row emphasis (`body-sm-strong`) is sans 14px/500; secondary body is sans 14px/400. So even in a *table* the mono is confined to a small uppercase technical header label — the body content is proportional sans with weight (not family) carrying the emphasis.
Source: https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/design-md/vercel/DESIGN.md (component: `data-table`, typography tokens table)

**6. The "mono everywhere" anti-pattern is named and documented.**
*"Treating monospace as a decorative effect — for the 'tech' signal alone, without considering rhythm and hierarchy — produces designs that feel costume-y rather than considered."* And: *"Monospace reads slower than proportional fonts at body sizes (14–16px)... reserve it for shorter passages, callouts, captions, and code." The clean pattern is to pair a sans for UI/body with its matching mono for code* (Geist Sans+Geist Mono, IBM Plex Sans+Plex Mono). A pale, all-mono, equal-weight, hairline-divided list is the recognized "raw terminal / unfinished" look.
Source: https://madegooddesigns.com/best-monospace-fonts-2026/ and https://www.jetbrains.com/lp/mono/

**7. The two-tier row spec (primary 14px medium near-black + secondary 13px regular muted-gray) is the field consensus, expressed as `text-muted-foreground` in shadcn/Tailwind systems (the stack Linear's aesthetic shares).**
Common floors: table body 13–14px, secondary line 12–13px, exactly two weights (regular 400 + medium 500). Color ladder: primary ≈ stone-900, secondary ≈ stone-600, muted ≈ stone-500, micro-labels ≈ stone-400. Row heights: condensed 40px / regular 48px / relaxed 56px (a two-line primary+secondary cell needs ≥48px).
Source: https://github.com/arhamkhnz/ui-prompts/blob/main/dashboard-ui-prompt-v40.md and https://www.pencilandpaper.io/articles/ux-pattern-analysis-enterprise-data-tables

---

## (b) Consensus pattern across Stripe, Vercel/Geist, GitHub Primer, Raycast, Sentry, shadcn

1. **One proportional sans is the row default; monospace is a per-field family override reserved for protocol strings** (IDs, hashes, trace/event IDs, raw JSON, code, commands). No leading product sets record-list *body* in mono. Geist states this as a rule; Raycast proves it even for a command-palette product.
2. **Hierarchy is carried by weight + size + color/opacity tiers, in that priority order — weight first, color last.** Primer explicitly forbids color as the primary emphasis tool.
3. **Three text tiers, two weights:**
   - Primary (the human identifier/title): **14px, weight 500–600**, near-black / full-opacity foreground.
   - Secondary (description/body): **13–14px, weight 400**, foreground.
   - Tertiary (metadata, timestamps, micro-labels): **12–13px, weight 400**, muted/~70% opacity.
4. **Numbers use tabular figures (`tnum` / `font-variant-numeric: tabular-nums`), NOT a mono font.** Stripe is the canonical example. This gives column alignment without the terminal look.
5. **Color is rationed:** reserve hue for status (success/warn/error badges) and links/the interactive primary identifier. Everything else is a neutral foreground/muted ladder. Stripe ≈ one violet accent on a near-monochrome canvas; Raycast saturated color only on category tiles.
6. **Section/day-group headers** are smaller + heavier + muted/uppercase (a "label," not a "heading"), sitting *quieter* than row primary by color while reading as structure by weight/caps — e.g. Vercel's `caption-mono` uppercase header, Primer's `fgColor-muted` subhead. They should not out-shout the rows.
7. **Anti-pattern confirmed:** all-mono + uniform weight + pale low-contrast + hairline dividers = "raw dev tool / unfinished." The minimal fix is **(1) swap row body to sans and confine mono to ID/code fields, (2) bump the primary line to weight 500–600, (3) introduce a 2–3 step foreground→muted color ladder.** No new layout, color palette, or font needed.

### Day-group header vs row-primary vs row-secondary weight & size relationship (consensus)
| Element | Size | Weight | Color | Family |
|---|---|---|---|---|
| Day-group / section header | 12–13px | 500–600, often uppercase + letter-spacing +0.2–0.4px | muted (~60–70%) | sans |
| Row primary (identifier/title) | 14–15px | 600 (or 500) | foreground / near-black | sans |
| Row secondary (description) | 13–14px | 400 | foreground | sans |
| Row metadata (time, counts) | 12–13px | 400, `tnum` | muted | sans (tabular) |
| Protocol ID / hash / code | 12–13px | 400 | muted or foreground | **mono** |

The key relationship: **the day-header is heavier-but-smaller-and-quieter than the row primary** — it reads as structure via weight/caps/letterspacing while staying recessive via color, so it never competes with the actual records.

---

## (c) Recommendation for the stated decision — record feed that feels like Stripe/Linear while keeping mono for protocol IDs

**Set the whole feed in one proportional sans (Geist or Inter). Do NOT set record-list body in monospace. Confine mono to protocol strings only.**

Concrete type/weight/color hierarchy (Inter/Geist; values lifted from the systems above):

- **Day-group header** — sans, 12px, weight 600, uppercase, letter-spacing +0.3px, color `muted` (~`oklch` equivalent of stone-500 / `rgba(…,0.6)`). Sticky if the feed scrolls. (Pattern: Primer subhead / Vercel `caption-mono`.)
- **Row primary (the human identifier — sender, merchant, title, subject)** — sans, 14–15px, **weight 600**, color `foreground` (near-black / full-opacity). This single weight step is what flips the list from "terminal" to "product." (Pattern: Vercel `body-sm-strong` 500, Geist `heading-14` 600.)
- **Row secondary (snippet/description)** — sans, 14px, weight 400, color `foreground`. (Vercel `body-sm`.)
- **Row metadata (timestamp, count, amount)** — sans, 13px, weight 400, color `muted` (~70% opacity), and **`font-variant-numeric: tabular-nums`** so times/amounts align without a mono font. Money cells right-aligned + tabular (Stripe pattern). (Raycast `caption-md` 13/400; Stripe `body-tabular` `tnum`.)
- **Protocol ID / hash / trace ID / raw JSON / code** — **mono** (Geist Mono / JetBrains Mono), 12–13px, weight 400, color `muted`. This is the ONLY mono in the row, scoped to one field. (Geist `label-13-mono`.)

**Color discipline:** neutral foreground→muted ladder for ~95% of pixels; reserve hue for (1) status badges (success/warn/error) and (2) links/the one interactive primary identifier. Don't color the whole primary line — weight already carries it (Primer rule).

**Dividers:** keep hairlines, but pair them with the weight+color steps above. Hairlines alone on a flat pale all-mono list are the anti-pattern; hairlines *plus* a weight-600 primary and a foreground→muted ladder read as Stripe/Linear.

**Minimal-change version (if the current feed is the pale all-mono anti-pattern):** three edits, no redesign — (1) switch row text from mono to sans, leaving mono only on the ID/hash field; (2) raise the primary line to weight 600; (3) add the foreground→muted color tier on secondary/metadata + `tabular-nums` on numbers. That is the smallest delta that makes the list read as a polished product rather than a raw terminal dump.

---

### Source URLs
- Vercel Geist (decisive sans-vs-mono rule): https://vercel.com/design.md • https://vercel.com/geist/typography • mirror https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/design-md/vercel/DESIGN.md
- GitHub Primer (weight-not-color, muted/default tokens): https://primer.style/foundations/typography/ • https://github.com/primer/primitives/blob/main/DESIGN_TOKENS_GUIDE.md
- Stripe / Söhne (tabular `tnum`, not mono): https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/design-md/stripe/DESIGN.md • https://dev.to/alanwest/tabular-numbers-in-css-font-variant-numeric-vs-monospace-hacks-25cn
- Raycast (zero-mono UI, opacity tiers): https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/design-md/raycast/DESIGN.md • https://getdesign.md/raycast/design-md
- Sentry (Rubik UI + Monaco code only, muted token `rgba(255,255,255,0.72)`): https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/design-md/sentry/DESIGN.md • https://sentry.design/
- "Mono everywhere" anti-pattern: https://madegooddesigns.com/best-monospace-fonts-2026/ • https://www.jetbrains.com/lp/mono/
- Two-tier row spec / shadcn `muted-foreground` consensus: https://github.com/arhamkhnz/ui-prompts/blob/main/dashboard-ui-prompt-v40.md • https://www.pencilandpaper.io/articles/ux-pattern-analysis-enterprise-data-tables

---

## loading-feedback-placement

I have authoritative, quoted primary-source material. I have enough to deliver a grounded answer.

---

# SLVP-grade loading/pending placement for a scrollable record feed — findings, consensus, recommendation

## (a) Specific findings, each tied to a named product/design-system + URL

**1. Vercel Geist — the Spinner is the canonical control for pagination/button-triggered fetches, mounted AT the trigger.** Geist's Spinner doc states the spinner "should generally be used to indicate loading feedback in response to a user action, like for **buttons, pagination, etc.**" and lists the exact use cases: "indeterminate, single-action waits of roughly one to three seconds: submit buttons, inline icon refresh, **row-level retries**." It also rules out the off-screen-bar approach for this case: "Mount the Spinner only after the action starts." The division of labor is explicit: "Pick `Skeleton` when async data fills a known layout, `LoadingDots` for inline copy, and `Progress` when total work is known." So for a Load-more button, Geist puts a spinner *inside/at the button*; for the initial known-shape list, it uses a Skeleton. Source: https://vercel.com/geist/spinner and https://vercel.com/geist/skeleton

**2. BBC GEL "Load more" — the documented gold-standard places the spinner directly ABOVE the button (at the load point), not at page top, plus an ARIA live region and focus moved to the new content.** GEL's spec: on press, "the loading indicator ('spinner') appears **above the button**, and 'loading, please wait' is announced in screen readers via the supplemental live region." When results arrive, "the loading indicator is hidden and the live region emptied," results "appear, introduced by a separator element that confirms how many items have been loaded ('items 12 to 18:') and **is focused**." This is the strongest documented pattern that the feedback and the new content both land where attention already is (the foot of the loaded list). Source: https://bbc.github.io/gel/components/load-more/

**3. GitHub — a documented FAILURE of misplaced load-more feedback/position: users complain the affordance forces a scroll round-trip.** GitHub collapses long issue/PR threads behind a "Load more" link; community discussions report "you still have to scroll to the bottom of the page to get to the load more, which then **scrolls you back to the top**, so you have to scroll back down," and that "the 'Load more' link jumps." This is the concrete real-world symptom of feedback/anchoring not living at the user's scroll position. Sources: https://github.com/orgs/community/discussions/5119 and https://github.com/orgs/community/discussions/134214

**4. Slack — appends/prepends in modest batches and fetches on scroll, with feedback in the list footer/header at the scroll edge (not a global top bar).** Slack settled on "the ever-magical 42 for a page of history" and fetches "older messages … as the user scrolls back through history" — feedback rides the scroll edge being approached, not a viewport-top chrome element. Source: https://slack.engineering/making-slack-faster-by-being-lazy/

**5. NN/G — the "illusion of completeness" is the named failure when there's no in-context loading indication at the scroll edge; the fix is a visible indicator (or a Load More button) right where new content appends.** NN/G: "On some pages that use infinite scrolling without a Load More button, there can be an illusion of completeness… **this problem arises when there is no indication that additional content is loading as users reach the end of their preloaded content**." A big whitespace/ad gap at the bottom "created an illusion of completeness." The corrective is an explicit Load-More button or a loader at the bottom edge — i.e., feedback at the point of attention. Source: https://www.nngroup.com/articles/infinite-scrolling-tips/

**6. NProgress top-bar anti-pattern is documented: fixed `top:0` bars become invisible feedback once scrolled, especially on mobile.** NProgress's bar uses `position: fixed; top: 0`; practitioners note that on small screens the header/top region is occluded and the bar "could be useful for clarity purposes — but only if it's actually visible to the user." The documented mitigations: reposition the indicator to stay in-viewport, OR "pair the global top bar with **localized in-context loading states for the specific component being updated**" (the inline-button-spinner + skeleton-rows fix). Sources: https://github.com/rstacruz/nprogress and https://github.com/gatsbyjs/gatsby/issues/2975

**7. Skeleton-at-insertion-point vs spinner-in-button — the consensus split, with layout-stability as the gating concern.** Across NN/G and design-system guidance: spinners for short/blocking user actions; skeletons for content that "fills a known layout" (feeds, lists, search results) because they preview shape and reduce perceived wait. Critically, skeletons at the insertion point must "reserve enough space … to minimize CLS" and append "without pushing content down unexpectedly." Mobile note: animate skeletons with `transform` not `background-position` to hold 60fps. Sources: https://www.nngroup.com/articles/skeleton-screens/, https://uxpatterns.dev/patterns/navigation/infinite-scroll, https://addyosmani.com/blog/infinite-scroll-without-layout-shifts/

**8. Mobile specifics — pending feedback lives in the list FOOTER at the bottom edge (within thumb reach), pre-fetched before the true end; pull-to-refresh owns the TOP.** React Native's canonical pattern uses `ListFooterComponent` driven by an `isFetchingNextPage` boolean, fired on `onEndReached` with a threshold so the loader appears just before the user hits the end. Top-anchored feedback on mobile is reserved for pull-to-refresh (a top gesture), not for appended content. Sources: https://medium.com/@andrew.chester/react-native-infinite-scrolling-with-lazy-loading-a-step-by-step-guide-e91647348689, https://uxpatterns.dev/patterns/navigation/infinite-scroll

## (b) The consensus pattern

For appended/paginated content in a scrollable list, SLVP-grade products converge on:

- **Put the pending indicator at the load point — the bottom edge / inside-or-above the Load-more button — never solely at the viewport top.** A top-fixed progress bar (NProgress-style) is an acknowledged anti-pattern for appended content because it is above the fold and invisible once the user scrolls down. It is fine *only* for full-route transitions, not for in-place "load more."
- **Spinner-in-button (or just above it) for the explicit Load-more action; skeleton rows at the insertion point for the incoming batch** — because the row shape is known, skeletons preview structure and reduce perceived wait, but they MUST reserve space to avoid CLS/jump.
- **Anchor scroll position and announce via an ARIA live region**, then optionally move focus to a "items N–M loaded" separator (GEL) so keyboard/SR users get the feedback too.
- **Sticky-to-the-scroll-container, not sticky-to-viewport**, for any persistent progress affordance — so it tracks the list the user is reading rather than chrome they've scrolled past.
- **Mobile: footer loader at the bottom edge** (thumb-reachable, pre-fetched before true end); reserve the top for pull-to-refresh only.

## (c) Recommendation for Explore

The user's report is exactly the documented NProgress anti-pattern (finding 6): the top progress bar is above the fold when scrolled down, so a scrolled-down user gets no feedback. Fix it by moving pending feedback to the point of attention:

1. **Primary fix — put the Load-more feedback ON the Load-more control at the bottom of the loaded feed.** Disable the button on click and swap its label/icon to an inline spinner with "Loading…" (Geist: spinner is the control "for buttons, pagination"; GEL: spinner above the button + live region). This is always within view when a scrolled-down user triggers it, because they clicked it.
2. **Render 2–4 skeleton rows at the insertion point** (matching the record-row shape) immediately below the existing rows while the batch fetches — Geist Skeleton ("async data fills a known layout") + NN/G. Reserve their height to prevent the jump GitHub users complain about (finding 3). Gate skeleton-row keyframes behind `prefers-reduced-motion` and animate via `transform`.
3. **Keep the top progress bar ONLY for full-route navigations** (filter/search/clear that re-fetch the whole feed and reset scroll to top), where the top is in view. Do NOT use it as the sole signal for in-place "load more." Pair it with the in-context states per the NProgress mitigation (finding 6).
4. **If you want a persistent progress affordance during append, make it sticky to the scroll container, not the viewport** — but the button-spinner + skeleton-rows combo already satisfies "always visible to a scrolled-down user" and is the lower-risk choice.
5. **Announce via `aria-live="polite"`** ("Loading more records…" → "Loaded N more") and set `aria-busy` on the feed region during fetch, so the feedback is non-visual-accessible too (Geist + GEL).
6. **Mobile:** footer loader at the bottom edge, pre-fetched just before end (`onEndReached`-style threshold); never rely on the top bar on a thumb-scrolled phone.

Net: move load-more feedback from the top bar to **(a) an inline spinner on the Load-more button + (b) reserved-height skeleton rows at the insertion point + (c) an aria-live announcement**, and demote the top progress bar to full-route transitions only. This guarantees a scrolled-down user always sees the pending state at their point of attention.

## Sources
- https://vercel.com/geist/spinner
- https://vercel.com/geist/skeleton
- https://bbc.github.io/gel/components/load-more/
- https://github.com/orgs/community/discussions/5119
- https://github.com/orgs/community/discussions/134214
- https://slack.engineering/making-slack-faster-by-being-lazy/
- https://www.nngroup.com/articles/infinite-scrolling-tips/
- https://www.nngroup.com/articles/skeleton-screens/
- https://github.com/rstacruz/nprogress
- https://github.com/gatsbyjs/gatsby/issues/2975
- https://uxpatterns.dev/patterns/navigation/infinite-scroll
- https://addyosmani.com/blog/infinite-scroll-without-layout-shifts/
- https://medium.com/@andrew.chester/react-native-infinite-scrolling-with-lazy-loading-a-step-by-step-guide-e91647348689

---

## facet-rail-and-filter-operator-model

Research corpus saved to `/home/tnunamak/code/pdpp/docs/research/explore-filter-rail-vs-operator-language-prior-art-2026-06-22.md`.

# (a) Findings — each tied to a named product/design system + URL

**F1 — Linear: facet click and typed query are ONE model; the menu is searchable and shows match counts.** The filter menu shows "the number of matching issues" next to each option and supports "free text search to find the exact filter." Every selection becomes an editable "formula" pill: for `Assignee is Andreas`, clicking `is` toggles to `is not`; adding a second value auto-shifts `is` → `is either of`. Negation has no separate UI — "to filter for no labels, select all labels and switch the operator to **does not include**." https://linear.app/docs/filters

**F2 — Datadog: facet panel and query bar are two views of one query, kept in sync bidirectionally.** "The search bar and URL automatically reflect your selections from the facet panel," and editing the bar reselects facets. Clicking a facet writes `key:value` verbatim (`type:api`), a second same-facet value writes `type:("api" OR "api-ssl")`, cross-facet selections join by space (AND). Qualitative facets list a per-value match count; the 2025 bar adds syntax highlighting and autocomplete "in the order they appear in the facet panel." https://docs.datadoghq.com/logs/explorer/facets/ , https://docs.datadoghq.com/logs/explorer/search_syntax/

**F3 — GitHub: the sidebar IS a query-builder.** "The filters shown in the search text box are updated accordingly" — sidebar label → `label:"in progress"`, type → `type:"Bug"`, state → `is:open`. Multiple selections join with implicit AND; the 2026-GA advanced UI adds explicit AND/OR, parentheses, and live suggestions. Inversion: prefix `-` negates any filter/combination; `has:`/`no:` test presence and are themselves negatable. https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/filtering-and-searching-issues-and-pull-requests , https://github.blog/changelog/2026-04-02-improved-search-for-github-issues-is-now-generally-available/

**F4 — Sentry: facet-map rail clicks edit the same token query; counts are result-scoped, not total (the decisive count-semantics source).** The right-rail "tag summary (facet map)" shows the "top 10 keys sorted by frequency"; "click on any of these sections to further refine your search" (adds e.g. `browser:Chrome`). Crucially: "the event and user counts represent the counts **given the search, environments, or time period selected** above. This is **different from the counts in the header which are the total counts across the lifetime of the issue**." Negation is the `!` operator. https://docs.sentry.io/product/issues/issue-details/ , https://sentry.io/changelog/improved-search-ui/

**F5 — Facet counts consensus: DYNAMIC + result-scoped; never leave 0-count clickable.** Counts "should update dynamically as other filters are applied"; `Blue (47)` sets a true expectation, `Blue (0)` warns of a dead end. Zero-count handling splits two valid ways — Google says **grey-out/disable** ("with zero items, grey out filtering options"); Elasticsuite/Doofinder say **hide via show-only-non-empty** threshold. Empty-result moments are the most damaging in search (Baymard ~69% abandon). https://developers.google.com/search/blog/2014/02/faceted-navigation-best-and-5-of-worst , https://www.brokenrubik.com/blog/faceted-search-best-practices

**F6 — Many values without a wall: parent→child scoping + collapsible groups + search-in-filter.** Linear scopes via parent ("to filter by milestones, filter by project first"). Airtable makes "neat, collapsible sections" with right-click "Collapse all" and suggests a dropdown/tabbed filter rather than a flat list. Notion's advanced filter groups nest AND/OR up to 3 levels. https://support.airtable.com/docs/grouping-records-in-airtable , https://www.notion.com/help/guides/using-advanced-database-filters

**F7 — Chips are the single unified state surface; one "Clear filters" regardless of source facet.** PatternFly: every selection "will always show up as a chip," and chips show all selections when the menu is collapsed, with "Clear filters" after the last chip. Material 3: "do not display a single chip by itself — chips should appear in a set"; the `×` dismisses one filter. https://www.patternfly.org/2022.11/guidelines/filters/ , https://m3.material.io/components/chips/guidelines

# (b) Consensus pattern

**One model, two surfaces.** The clickable rail and the typed operator language are not separate systems — the rail is a query-BUILDER. A facet click writes the equivalent operator/chip into one shared, URL-encoded query (Datadog `key:value`, GitHub qualifiers, Sentry tokens, Linear formula pills); editing the query reselects the rail; the chip row is the canonical state. That's how leading products eliminate "filters vs operators confusion" — there is only one thing, shown two ways, always in sync. Counts are result-scoped and dynamic, recomputed against the current query, and visibly distinguished from lifetime/total counts (Sentry states this outright). Zero-count options are never live dead-ends (disable or hide). Many values are tamed by search-within-the-menu, parent→child scoping, collapsible/grouped sections, and top-N-by-frequency-then-more. Inversion is the same chip with a flipped operator (Linear `is not`/`does not include`, GitHub `-`/`no:`, Sentry `!`), never a separate negative control.

# (c) Recommendation for Explore's source/stream rail + `con:`/`stream:` operators

Ship the rail and operators as ONE query, two surfaces — not parallel mechanisms:

1. **Rail clicks author operators.** Clicking a source writes `con:<key>`, a stream writes `stream:<key>`, each rendering as a removable chip in the same input the user can type into; typing `stream:` reselects the rail row. The chip row is the source of truth. (Datadog/GitHub/Linear) — this is the single highest-leverage fix for filter/operator confusion.
2. **Group streams under their source, collapsible, with search-within.** For 70+ streams, never show a flat wall: `source → its streams` as default-collapsed collapsible sections with a "search streams" box; selecting a source first narrows the stream set; optionally top-N-by-record-count then "Show all N." (Airtable + Linear parent→child + Sentry top-10)
3. **Counts = matching records in the CURRENT result set, recomputed dynamically and labeled.** A bare `(12)` is opaque; follow Sentry's explicit split — result-scoped ("12 in current results"), with any lifetime/total visibly distinct (tooltip "12 of 340 total"). Counts must honor active chips. This directly upholds PDPP's count==reachability invariant: the badge equals what clicking yields.
4. **0-record streams: disable (grey-out) or hide via "show empty streams" — never a live dead-end.** Keeps the count-as-promise honest and avoids the most damaging UX moment.
5. **Exclusion = the same chip flipped, not a new control.** Toggle a source/stream chip's operator to `-con:`/`-stream:` (GitHub `-`, Sentry `!`, Linear `is not`); one affordance covers include and exclude.

Net: a collapsible source→stream rail with result-scoped, reachability-honest counts whose every click writes/edits the same `con:`/`stream:` chips the user can type — one model, two surfaces, synced via the URL — is the SLVP-convergent answer and removes the filter/operator ambiguity by construction.

---
