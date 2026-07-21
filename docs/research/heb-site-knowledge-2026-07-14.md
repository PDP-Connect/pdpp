# HEB (heb.com) site knowledge — mined from vana-com/data-connectors

Date: 2026-07-14. Source: `vana-com/data-connectors/connectors/heb` (README.md, heb-playwright.json,
heb-playwright.js ~857 lines, schemas/*.json), read in full via GitHub API. That connector's
*architecture* is rejected (see design note in `design-notes/heb-connector-manifest-design-2026-07-14.md`);
this file preserves only its hard-won facts about H-E-B's website.

## Authentication and session

- Form-based login, no OAuth. The vana connector never fills credentials; it opens
  `https://www.heb.com/my-account/your-orders` headed and has the user sign in manually, polling
  every 2s until logged-in markers appear.
- Logged-OUT signals: `input[type="password"]` present, `form[action*="sign-in"|"login"]`, or URL
  containing `/challenge`, `/checkpoint`, `/sign-in`, `/login`.
- Logged-IN signals: `button[aria-label*="account" i]`, `a[href*="/my-account"]`,
  `button[aria-label="My account"]`.
- Session persists via the browser profile's cookies across runs; no explicit token extraction.
- No MFA/OTP flow was coded; unknown whether H-E-B accounts ever require one.

## Bot protection: Imperva Incapsula (confirmed)

- The `_Incapsula_Resource` marker appears in the HTML of **every** heb.com page — presence alone
  is NOT a block signal (the vana author explicitly fixed this false-positive).
- A real block/challenge renders as an **empty shell**: no `h3`, no breadcrumb nav, no
  `[data-testid]` elements, `document.body.children.length <= 2`, and at least one `iframe`
  (the challenge document replaces all content as a single iframe).
- Secondary markers checked: `iframe[src*="captcha"]`, `[id*="captcha"]`, `[class*="captcha"]`,
  URLs `geo.captcha-delivery.com` / `/challenge` / `/blocked`, titles matching
  `captcha|verify|access.denied|are.you.human|security.check`.
- Recovery pattern that worked: show headed browser, let the user solve, return to headless,
  sleep 5–8s jittered, retry; after 3+ consecutive blocks pause 30s first.
- Politeness that worked: 1500–2500 ms fixed waits after every navigation (pages are
  client-hydrated; DOM is not ready on `load`), 400–500 ms between order pages, jittered
  1.5–3 s between product-page fetches (the surface most likely to trigger Incapsula).

## Data surfaces (all pure DOM scraping — no usable JSON/GraphQL API was found)

### Profile — `GET https://www.heb.com/my-account/profile`
Label→value scraping (`<p>` with exact text `Name`/`Email`/`Mobile number`, read
`nextElementSibling`). Delivery-address cards under `main > div > div`, detected by
`/[A-Z]{2}\s+\d{5}/`; primary flag = card text contains "Primary".

### Order list — `GET https://www.heb.com/my-account/your-orders?page=N`
- Order links: `a[href*="/my-account/order-history/HEB"]`. **Order IDs are prefixed `HEB`**
  (last path segment of the href).
- Per-card free-text regex parsing:
  - date `/([A-Z][a-z]+ \d+, \d{4})/` — long-form US dates ("July 14, 2026")
  - total + count `/\$(\d+\.\d+),?\s*(\d+)\s*items?/i`
  - status `/Status:\s*([^\n]+)/i`
  - fulfillment `/(?:Delivery to|Curbside at)\s+([^\n]+)/i` — **the curbside-vs-delivery
    signal is a free-text prefix**, followed by an address/store string.
- Pagination: `nav[aria-label*="Pagination"] a[href*="page="]`, max page from `page=(\d+)`.
  Global reverse-chronological pagination — NOT year-partitioned like Amazon.
- **Scope limit: only curbside/delivery orders appear in account history. In-store purchases
  are structurally unreachable** (H-E-B's app has receipt-photo upload, but no web surface).

### Order detail — `GET https://www.heb.com/my-account/order-history/{orderId}`
- Line items: `a[href*="/product-detail"]` anchors, dedup by href;
  `productId = href.split('/').pop()`.
- Per-item, from the closest `<li>` text: quantity `/Quantity:\s*([^\n.]+)/` (free text —
  may be non-numeric for weighted items; unverified), price `/Price:\s*\$?([\d.]+)/`
  (**unverified whether this is unit price or line total**).
- Item image URL is derived, not scraped: `https://images.heb.com/is/image/HEBGrocery/prd-small/{productId zero-padded to 9 digits}.jpg`
  (full size: `https://images.heb.com/is/image/HEBGrocery/{id}-1`). Reverse-engineered CDN
  convention, not documented by H-E-B.
- The detail page does NOT expose UPC, department, or nutrition — those only exist on
  product-detail pages (see below).

### Product page — `GET https://www.heb.com/product-detail/{slug}/{productId}` (NOT user data)
Kept for reference only; a per-user connector should not crawl these (catalog data, and the
highest-Incapsula-risk surface). UPC/GTIN is available via JSON-LD (`gtin12`/`gtin13`/`gtin`/
`gtin8` in `script[type="application/ld+json"]`), meta tags, or visible-text fallback.
Nutrition Facts panel is an `<h3>`+`<ul>` structure (0-calorie items omit the calorie row);
ingredients/allergens under `<h4>` headers; category from breadcrumb nav.

## Explicitly excluded from the pdpp connector (bloat in the vana design)

Roughly half the vana connector is USDA FoodData Central enrichment: product-name cleaning,
`api.nal.usda.gov/fdc/v1/foods/search` lookups by UPC then fuzzy name match, USDA nutrient-id
mapping, provenance/confidence tagging — plus the per-unique-product page crawl that feeds it.
This is non-user-specific catalog enrichment layered on the order crawl. Deliberately excluded.
