# Amazon v0.2 plan — scope, code-readiness, and the live-DOM-pending items

**Status:** v0.1 scaffolded (orders + order_items with ~11 stubbed fields). v0.2 gated on live Amazon session with DOM probes of three page kinds.

## Current reality (2026-04-21)

```sql
SELECT stream, COUNT(*) FROM records WHERE connector_id LIKE '%amazon' AND deleted=0 GROUP BY stream;
-- (empty — 0 records)
```

Amazon has never successfully landed records. The connector code exists and syntax-checks; `ensureAmazonSession` handles login + OTP via INTERACTION; the orders list page parser exists. What's missing is a successful end-to-end run.

The account-identity blocker from the original scope note ("2FA on wife's phone") was resolved 2026-04-21: the owner switched to his wife's primary Amazon account. The login path is now unblocked in principle; awaits the first live run.

## Why I didn't run Amazon tonight

1. **Amazon's persistent-device fingerprint**: earlier tonight's wipe-then-retry probe showed Amazon silently re-authenticated without 2FA because the daemon profile's Chrome fingerprint is trusted. Running a fresh probe on the current profile would just confirm it still works — it wouldn't exercise the 2FA flow that the owner wants tested.
2. **the owner's explicit wait-for-me instruction**: "I will do it again with my wife's account tomorrow which will 2fa. just keep going". The "keep going" that followed was to push Chase forward first. Chase is done to the extent I can do autonomously (v0.1 base streams + statements code + isolated-profile infra — see `chase-anti-bot.md`).
3. **The remaining Amazon valuable streams require live DOM probes I can't do without the session being in the 2FA-verified state the owner wants to test.**

## Streams we should target for Amazon "pristine"

| Stream | Value | Source page | Probe status |
|---|---|---|---|
| `orders` | Core reconciliation data | `/your-orders/orders` | Code exists; selectors (`div.order-card`) are fragile per audit |
| `order_items` | Per-item line items | same page | Code exists; ~11 fields stubbed |
| `returns` | Returns + refund status | `/returns` or detail-page `refund_status` | Not implemented |
| `subscriptions` | Subscribe & Save recurring | `/auto-deliveries` | Not implemented |
| `digital_orders` | Kindle, Prime Video, apps, music | `/gp/digital/your-account` | Not implemented |
| `reviews` | Reviews the owner has written | `/profile` or `/gp/cdp/member-reviews` | Not implemented |
| `addresses` | Shipping addresses (metadata, not bodies) | `/gp/address/ui` | Not implemented |
| `payment_methods` | Card type + last4 only (PII-safe) | `/cpe/managepaymentmethods` | Not implemented |

## The ~11 missing fields on existing streams

From the audit (landed 2026-04-21 in `design-notes/amazon.md`):

**On `orders`, always null today:**
- `status_detail` ("Delivered Monday, April 20" — richer than the list-page status)
- `recipient_name`
- `shipping_address_summary`
- `payment_method_summary` ("Visa ending in 1234")
- `gift_order` (heuristic from detail page)
- `digital_order` (heuristic from detail page)

**On `order_items`, always null today:**
- `unit_price` + `unit_price_cents` (list page shows only order total, not per-item)
- `quantity` (hardcoded to 1)
- `seller` ("Sold by X")
- `item_image_url`
- `refund_status`

All of these live on the order-details page at `/gp/your-account/order-details?orderID=<ID>`. The detail URL has been stable for years (unlike the list-page `.order-card` class which Amazon A/B-tests).

## Recommended run order when the owner is back

1. **One manual Amazon login** via the daemon's wife's-account session (establishes trusted-device state — ~30d lifetime)
2. **Run `orchestrate run amazon`** once with whatever selectors we have today. Expected outcomes:
   - ✅ Orders discovered via dashboard year dropdown
   - ✅ Orders emitted with 6 real fields + 6 null fields
   - ✅ order_items emitted with 3 real fields + 5 null fields
   - ⚠ Selector-drift diagnostic SKIP_RESULT if `.order-card` has shifted — screenshot to `/tmp/amazon-drift-*.png`
3. **Audit output**: are counts right? Are the non-null fields correctly populated? Spot-check 10 orders against the actual amazon.com UI.
4. **If orders flow works**, pivot the daemon onto order-details fetches for the 11 stubbed fields. DOM probe, get real selectors, ship v0.2.
5. **If orders flow is drift-broken**, calibrate the list-page selectors first before moving on.

## Code in-place for v0.2

- `fetchOrderDetail(page, orderId)` stub at `connectors/amazon/index.js:118`. Returns `null`. Callsite at line 318 optional-chains safely.
- Schema allows all ~11 fields; connector emits null for them today. When `fetchOrderDetail` returns a populated object, main() merges in.
- Selector-drift diagnostic on list-page empty result: captures DOM fingerprint + screenshot + emits SKIP_RESULT `selector_drift`. This is the "never silently return zero records" protection the audit flagged as missing.

## Interaction with session infrastructure

Amazon will likely NOT need the isolated-profile treatment Chase did:
- Amazon's anti-bot is per-device, not per-profile-cookie. The shared daemon profile has a trusted-device cookie set during the owner's prior login; wiping session cookies doesn't invalidate device trust.
- This means Amazon can use the shared browser daemon (`acquireBrowser` — already what the connector does).
- The Xvfb + rebrowser-playwright infra that Chase now requires is OPT-IN — the daemon defaults to plain-Playwright-headless, which is fine for Amazon.

## Non-goals for v0.2

- **Amazon Prime Video watch history** — different product surface, bundles are complex.
- **Photos (Amazon Photos)** — potentially huge, separate storage topology.
- **Fresh / Whole Foods delivery orders** — separate URLs, covered under their own connector scaffolds (`connectors/wholefoods`).
- **Gift cards / Treasure Truck / Amazon Lockers** — peripheral.

## Cross-cutting

- `amazon.md` — original audit (2026-04-20) flagged this work.
- `chase-anti-bot.md` — isolated-profile pattern is available if Amazon ever needs it.
- `partial-run-semantics-open-question.md` — the ~11-null-fields is a Category 2 (connector capability gap) per the taxonomy.
