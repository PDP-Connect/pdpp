# Amazon connector — design notes

**Status:** scaffolded 2026-04-19 overnight; BLOCKED on the owner's 2FA (wife's phone) until the owner returns.
**Source:** prior art at `~/code/data-connectors/amazon/amazon-playwright.js`.

## Auth
- Shared Playwright persistent profile.
- Two-level session probe (from prior art):
  1. **Quick check:** `#nav-link-accountList` greeting contains "Hello" and not "Sign in".
  2. **Deep check:** navigate to `https://www.amazon.com/your-orders/orders`, wait 2.5s, confirm URL is `/your-orders` (not `/ap/signin`, `/ap/challenge`, or `/ap/mfa`) AND no `form[name='signIn']` visible.
- The deep check is essential because Amazon caches greeting cookies that persist past session death.
- When session probe fails → emit `INTERACTION kind=manual_action` with link to `https://www.amazon.com/gp/sign-in.html`.

## Primary URLs
- Orders list: `https://www.amazon.com/your-orders/orders?timeFilter=year-YYYY&startIndex=N`
- Order detail: `https://www.amazon.com/gp/your-account/order-details?orderID={orderId}`
- Returns: `https://www.amazon.com/your-orders/returns`
- Your-items: `https://www.amazon.com/gp/history`
- Digital content: `https://www.amazon.com/hz/mycd/digital-console/contentlist/booksAll`
- Subscribe & Save: `https://www.amazon.com/auto-deliveries/normal`

## Streams

### `orders` (`mutable_state`, primary_key `["id"]`, consent_time_field `"order_date"`)
- `id` — order ID, `\d{3}-\d{7}-\d{7}` (stable, unique, never reused)
- `order_date` (ISO date, parsed from "Month DD, YYYY")
- `order_total` (string — keep currency symbol intact for resilience; parse client-side)
- `order_total_cents` (integer, derived; null if parse fails)
- `delivery_status` (enum: "Delivered" / "Arriving" / "Shipped" / "Out for delivery" / "Return" / "Refund" / "Cancelled" / raw string)
- `status_detail` (nullable; e.g., "Delivered Apr 15")
- `recipient_name` (from detail page; nullable)
- `shipping_address_summary` (from detail page; nullable, free-text)
- `payment_method_summary` (nullable; e.g., "Visa ending 1234")
- `gift_order` (boolean)
- `digital_order` (boolean)
- `item_count` (integer)
- `fetched_at` (ISO timestamp of when we scraped)

### `order_items` (`mutable_state`, primary_key `["id"]`, consent_time_field `"order_date"`)
- `id` — composite: `sha256(order_id + '|' + asin || item_name_normalized)` — Amazon doesn't expose a stable item ID in the DOM
- `order_id`
- `order_date` (denormalized for cursor efficiency)
- `asin` (nullable; extracted from `/dp/` or `/gp/product/` href)
- `name` (product title)
- `url` (absolute URL to product page)
- `unit_price` (string; nullable)
- `unit_price_cents` (integer; nullable)
- `quantity` (integer; default 1)
- `seller` (nullable; from detail page)
- `item_image_url` (nullable)
- `returned` (boolean; derived if we can detect)
- `refund_status` (nullable)

### `addresses` (`mutable_state`, primary_key `["id"]`) — v1.5 / optional
- `id` (synthetic hash of formatted address)
- `formatted_address`
- `recipient_name`
- `last_used_at`

### `returns` (`mutable_state`, primary_key `["id"]`, consent_time_field `"return_date"`) — v1.5
- `id` (Amazon return ID)
- `order_id`
- `return_date`
- `refund_amount`
- `refund_status`

### `subscribe_and_save` (`mutable_state`, primary_key `["id"]`) — v2

## Scraping strategy
1. **Session probe** (deep check).
2. **Year discovery** via the time-filter dropdown.
3. **Orders list per year**, paginate by `startIndex += 10`, stop when a page has 0 orders OR no next-page link. Max 50 pages per year safeguard.
4. **Per-order extraction** from list page: orderId, date, total, delivery status, item names + URLs (first pass).
5. **Detail-page enrichment** for orders not already in state (avoid redundant fetches). Detail page adds: shipping address, payment, per-item prices, seller.
6. **Emit RECORDs** as we go. STATE after each year completes.

## Incremental sync strategy
**Year-freezing.** A year's orders don't change once closed. Once we've scraped year Y and the count matches for 2 consecutive runs, Y is "frozen" — skip it on future runs. Only the current year + last 60 days of the prior year need re-scraping each run.

State shape:
```
{
  years: { "2026": { order_count: 12, frozen: false, last_scraped: "..." }, ... },
  deepest_year: 2007,
}
```

## Resilience
- **Use `.innerText` not `.textContent`** for total extraction — excludes `<script>` noise (per prior-art finding).
- **Regex-first extraction** for orderId, date, total — DOM classes churn; raw text is more stable.
- **Two selectors for order cards** (`div.order-card` OR `div.js-order-card`) — covers A/B tests.
- **Graceful degradation**: if detail page fails, emit the order from list data; don't block the run.
- **Never set `\Deleted` or modify Amazon pages** — strictly read-only.

## Humanlike behavior
- 2s pause after every `goto()`.
- 1.5s pause between year pages.
- 1.5s pause before each detail fetch.
- No concurrent detail fetches (sequential to look like a user browsing).
- Full backfill can take hours for heavy users; that's fine — it happens once.

## Failure modes
| Failure | Response |
|---|---|
| Deep session check fails | INTERACTION `manual_action` with Amazon sign-in URL; park run |
| CAPTCHA page | INTERACTION `manual_action` with CAPTCHA URL; park run |
| OTP (Amazon 2FA) | INTERACTION `kind=otp` with schema `{code: string}`; park run |
| Detail page 404 (rare: deleted orders) | SKIP_RESULT for that order, continue |
| Rate-limit / throttle | PROGRESS message + exp. backoff (5, 15, 60s) |

## Tonight's status (2026-04-19)
**Cannot run.** the owner's wife's phone holds the Amazon 2FA factor. Connector is fully scaffolded: manifest, connector script, selectors. On the owner's return, `pdpp-connectors browser bootstrap amazon` will trigger the 2FA (wife awake) and then the connector runs without further interaction.

**Prior art source file:** `/home/user/code/data-connectors/amazon/amazon-playwright.js` (492 lines). We're porting its selector knowledge without carrying forward its global `page` coupling or its flat scoped-blob output shape.

## Explicit non-goals v1
- Write operations (we never modify orders).
- Product reviews written by the user (low priority, separate deep-dig).
- Amazon Photos, Kindle, Music content streams (out of reconciliation scope).
- Full receipt HTML download (blob hydration deferred).
- Wishlists, lists, saved-for-later — low priority.
