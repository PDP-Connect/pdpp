# SLVP Benchmark Screenshots — 2026-06-23

Visual benchmarks for redesigning the personal-data Explore surface.
Captured via Playwright MCP (headed Chromium). Two viewports targeted where responsive: desktop 1440×900, mobile 390×844.

---

## Linear

| Filename | Viewport | What it shows | Source URL |
|---|---|---|---|
| `linear-docs-filters-desktop.png` | 1440×900 | Linear Docs "Filters" reference page: two-column docs layout with sidebar nav; embedded product screenshot of the filter chip UI (label, assignee, status chips active on an issue list); prose describing filter operators and keyboard shortcuts | https://linear.app/docs/filters |
| `linear-docs-search-desktop.png` | 1440×900 | Linear Docs "Search" reference page: two-column docs layout; embedded product screenshot of the search modal showing "Recent issues" rows (identifier, title, status icon) and scope-selector tabs | https://linear.app/docs/search |

## Vercel Geist Design System

| Filename | Viewport | What it shows | Source URL |
|---|---|---|---|
| `vercel-geist-typography-desktop.png` | 1440×900 (full page) | Complete Geist type scale — Heading 72→14, Button sizes, Label sizes, Copy styles; each with class name and usage note columns | https://vercel.com/geist/typography |
| `vercel-geist-colors-desktop.png` | 1440×900 | Geist colors above-fold — dark-mode semantic color token categories, swatch grid | https://vercel.com/geist/colors |
| `vercel-geist-introduction-desktop.png` | 1440×900 | Geist Design System introduction page: sidebar nav listing all token/component categories; overview cards for Brand Assets, Icons, Colors, Grid, and Typeface (Geist Sans / Geist Mono shown); color swatch row and icon grid visible | https://vercel.com/geist/introduction |
| `vercel-changelog-deployments-list-desktop.png` | 1440×900 | "Redesigned Deployments List" changelog article at desktop: embedded product screenshot of the dense deployments feed showing status dots, commit messages, env badges, branch names, and filter bar | https://vercel.com/changelog/redesigned-deployments-list |
| `vercel-changelog-deployments-list-mobile.png` | 390×844 | Same Vercel changelog article at mobile: article header with authors/date, thumbnail of the deployments list product UI, and description of the denser layout redesign | https://vercel.com/changelog/redesigned-deployments-list |

## GitHub Primer Design System

| Filename | Viewport | What it shows | Source URL |
|---|---|---|---|
| `primer-typography-desktop.png` | 1440×900 (full page) | Primer typography foundations — full type scale table with sizes, weights, line heights; rendered heading/body/code examples | https://primer.style/foundations/typography |
| `primer-color-desktop.png` | 1440×900 | Primer color primitives above-fold — color role tables, semantic bg/fg/border token categories, swatch grid | https://primer.style/foundations/color |
| `primer-relative-time-desktop.png` | 1440×900 | Primer RelativeTime component page — definition, rendered examples, and format options for human-readable relative timestamps | https://primer.style/product/components/relative-time/ |
| `primer-action-list-top-desktop.png` | 1440×900 | Primer ActionList component page at desktop: above-fold shows component title, React/Rails/Figma availability badges, then "React examples / Default" section with a live rendered list ("Item one", "Item two") | https://primer.style/product/components/action-list/ |

---

## Pruned (not useful references)

These files were moved to `pruned/` — they contain no usable product-UI pixels for Explore surface design.

| Filename | Why pruned |
|---|---|
| `linear-changelog-new-ui-desktop.png` | Blog hero for the "new Linear" changelog — large heading and abstract art, no rendered product UI visible in the captured frame |
| `linear-redesign-article-desktop.png` | Blog article hero ("How we redesigned the Linear UI part II") — dark background, centered heading, no product UI |
| `linear-redesign-article-mobile.png` | Same blog article hero at mobile — no product UI |
| `linear-docs-search-mobile.png` | Captured the Primer ActionList intro page (wrong content) — component description text only, no rendered list UI |
| `primer-action-list-desktop.png` | Primer ActionList intro page at mobile viewport — text description + React/Rails availability badges only, no rendered component |
| `primer-action-list-mobile.png` | Identical content to primer-action-list-desktop.png (same intro page, same viewport) — redundant, no product UI |
| `primer-action-list-scrolled-desktop.png` | Primer docs code panel — shows raw source markup for ActionList examples, not rendered UI pixels |
| `raycast-homepage-hero-desktop.jpeg` | Raycast marketing landing hero — abstract red/teal gradient background with tagline, no product UI |
| `stripe-homepage-hero-desktop.png` | Stripe marketing homepage hero — gradient background, headline, customer logo strip; no product UI |
| `stripe-homepage-mobile.png` | Same Stripe marketing homepage at mobile — no product UI |
| `stripe-dashboard-productui2-desktop.png` | Stripe homepage marketing section scrolled — feature cards with small embedded mockup thumbnails (checkout form, billing widget); no browsable dashboard UI |
| `superhuman-blog-desktop.png` | Superhuman blog index — card grid of post thumbnails, no inbox or feed UI |
| `superhuman-blog-ai-hero-desktop.png` | Superhuman blog article hero ("Superhuman AI") — article header with gradient image, no product UI |
| `superhuman-blog-inbox-ui-desktop.png` | Superhuman marketing page section showing an email compose dialog (not inbox/feed/list); not relevant to record-feed/filter UI patterns |
| `things3-homepage-desktop.png` | Things 3 marketing homepage — app icon + tagline on plain background, no task list UI |
| `things3-homepage-mobile.png` | Things 3 marketing homepage at mobile — app icon + tagline, tiny partially visible task list at bottom edge |
