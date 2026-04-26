# Commerce Receipt / Invoice Blob Hydration — Follow-Up

Status: open
Owner: owner/connectors
Created: 2026-04-26
Related: hydrate-first-party-blob-streams, polyfill-connectors:amazon, polyfill-connectors:heb, polyfill-connectors:wholefoods, polyfill-connectors:doordash, polyfill-connectors:shopify, polyfill-connectors:uber

## Why this is its own note

None of the commerce connectors today declare an invoices/receipts
stream. They emit `orders` and `order_items` only. Hydrating receipt
PDFs is a real-world ask (lease evidence, tax documentation, expense
reimbursement) but it is **not** a tweak to this change — it requires a
new manifest stream per connector that doesn't exist yet.

## Decisions required before any byte collection

1. **Stream shape.** Two reasonable models:
   - Per-order child stream: `amazon.order_invoices` with one row per
     PDF, FK to `orders.id`. Mirrors Gmail `messages → attachments`. This
     is the recommended default — relationship is clear and
     `expand=order_invoices` is a natural query.
   - Field on `orders`: `invoice_blob_ref` directly on the order row.
     Simpler but breaks the "one record carries one blob" convention and
     loses the ability to model multi-document orders (Amazon orders can
     have multiple shipment invoices, refund credits, gift receipts).
   Default: per-order child stream.
2. **Source path.** Amazon, HEB, Wholefoods, DoorDash, Shopify, Uber all
   expose receipts via authenticated browser-scrape only (no public API).
   Each connector's existing browser path needs an "open invoice → save
   PDF" extension. This is mechanically simple but multiplies
   selector-maintenance burden by 6×. Worth doing one at a time, not as
   a wave.
3. **Source availability.** Many of these surfaces only retain receipts
   for ~12-24 months. Re-running a sync on older orders will emit
   `hydration_status: "unavailable"` for purged receipts; the metadata
   row must remain truthful.
4. **Wholefoods inheritance.** Wholefoods piggybacks on Amazon session.
   If Amazon receipts ship first, Wholefoods receipts likely follow
   without independent design.

## Suggested order of operations

1. **Amazon `order_invoices` first.** Highest record volume, real users
   exercising it, browser path already mature. Validates the per-order
   child-stream pattern.
2. Defer the others until at least one consumer asks. Six similarly-
   shaped connectors is real maintenance load; pull when there's value.

## Out of scope for this follow-up

- No new public RS endpoint. The `POST /v1/blobs` + `GET /v1/blobs/{blob_id}`
  contract from the Gmail slice is the only path used.
- No OCR. Extracted text is a separate capability.
- No "merchant returns scrape." Returns metadata is on `order_items`
  already; return-receipt PDFs are a future stream if asked.

## Exit criteria for the first slice (Amazon)

- New manifest stream `amazon.order_invoices` with `blob_ref`,
  `content_sha256`, `hydration_status`, `hydration_error`, FK to
  `orders.id`, `invoice_kind` (enum: `purchase | refund | gift`),
  `issued_at`.
- Connector emits at least one real invoice through the same content-
  addressed `POST /v1/blobs` path Gmail uses.
- Query test proves `expand=order_invoices` is grant-gated.
- Idempotent re-run produces identical `blob_id`.
