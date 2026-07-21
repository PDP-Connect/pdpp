---
title: "Product identity on purchase line items: collection fact versus catalog enrichment"
date: 2026-07-15
topic: connectors
tags: [heb, product-identity, gtin, gs1, catalog-enrichment]
status: decided-for-heb-now
---

# Product identity enrichment boundary — 2026-07-15

## Question and conclusion

What is the SLVP-grade contract when a retailer exposes its own catalog ID and might
also expose UPC/EAN/GTIN in page state or product metadata?

**Recommendation for H-E-B now: retain `order_items.product_id` as the nullable,
provider-scoped H-E-B catalog reference and do not add a GTIN field or a generic
identifier object.** The current collection path obtains the ID from the purchased
line's product-detail link; the repository's H-E-B research says GTIN appears only on
the separately fetched product page, which is deliberately outside the owner-data
collector. A product-page lookup is catalog enrichment, not a fact observed on the
purchase line, and must not silently turn `product_id` into a claimed global identity.

This is a contract recommendation, not a schema or code change.

## Local evidence

- The H-E-B manifest and collector emit `product_id` from the last path component of
  the order-detail product link. It is nullable and also participates in the
  order-scoped line-item key. It has no declared global-identifier semantics.
- The H-E-B site research says product-detail pages, rather than order-detail pages,
  may expose `gtin8`, `gtin12`, `gtin13`, or `gtin` in JSON-LD/metadata; that same
  research excludes product-page crawling as non-owner catalog enrichment and a
  high-risk surface.
- The supplied worktree does not contain `docs/north-star.md` or
  `ai/research/INDEX.md`; this report therefore could not read or update those named
  corpus files. The H-E-B manifest design, H-E-B research, and current connector were
  read.

## Identity contract

| Thing | Contract | Do not infer |
| --- | --- | --- |
| `order_items.id` | An order-scoped purchase-line identity. It identifies this collected line, not a catalog item. | That equal names or equal retailer IDs across historical orders mean the same physical item. |
| `product_id` | The exact H-E-B provider/catalog identifier observed in the order-detail link. Preserve it as text, including leading zeroes; null when the source link does not yield one. | UPC, EAN, GTIN, SKU, brand identity, package size, or an H-E-B product *variant* taxonomy not evidenced by the source. |
| GTIN (including UPC/EAN renderings) | A GS1 trade-item identifier. Accept only a source assertion with an explicit GTIN/UPC/EAN field or an unambiguous GS1 Digital Link/JSON-LD property, after digit-length and check-digit validation. | That a numeric provider ID is a GTIN, or that name/price/image matching establishes one. |
| Variant / packaging / fulfilment | A GTIN identifies a trade item at its assigned packaging level; a package grouping can have its own GTIN. GTIN + CPV is a distinct GS1 variant granularity. The purchased/fulfilled line can also be a substitution or variable-measure amount. | That one GTIN identifies a product family, every pack, every catalog variation, or the exact physical instance delivered. |
| Inferred match | A separately produced, fallible assertion, never a replacement for an observed identifier. | That a high-confidence match is source truth or may be used as the order line's stable key. |

GS1 describes GTIN as identifying trade items (products/services priced, ordered, or
invoiced). Its Digital Link syntax represents GTIN in a 14-digit form (padding GTIN-8,
GTIN-12, and GTIN-13 with leading filler zeroes), and distinguishes GTIN plus a
Consumer Product Variant qualifier. Schema.org likewise publishes distinct
`gtin8`/`gtin12`/`gtin13`/`gtin14` properties and describes GTIN-12 as the UPC form and
GTIN-13 as the EAN/UCC-13 form. These are representations of the GTIN family, not
evidence that a retailer-local numeric ID is one.

## Provenance, confidence, and failure behavior

1. **Observed provider ID:** provenance is the H-E-B order-detail link and extraction
   rule; confidence is not a score—it is source-observed. If missing or malformed,
   emit `product_id: null`; retain the order line with its order-scoped fallback key.
2. **Observed GTIN:** only a direct, named source value can populate a future GTIN
   field. Preserve the raw source value in capture evidence where the runtime supports
   it; validate the check digit and normalize a usable GTIN to the 14-digit GS1 form
   for comparison. Invalid, ambiguous, or conflicting source values are **null**, not
   repaired or chosen by heuristic. The collection run should expose a diagnostic,
   rather than emit an invented identity.
3. **Metadata/catalog lookup:** record the source URL/type, retrieval time, extractor
   version, and the provider product ID used to look it up. Its confidence is
   `source_asserted_catalog`, not purchase-line-observed. A lookup failure or absent
   GTIN leaves the purchase record unchanged.
4. **Matched/inferred identity:** carry match method/version, candidates or decisive
   evidence, and numeric confidence in the enrichment result. It is nullable and is
   never written back into `product_id`, a GTIN observed field, `order_items.id`, or
   aggregates that claim observed distinct products.

The distinction is deliberately observable: `null` means “this collection contract
has no valid assertion,” not “unknown GTIN that a consumer may safely guess from the
name.” A checksum only establishes syntactic plausibility; it does not prove that the
value belongs to the purchased line.

## Placement decision

### H-E-B now — direct line-item field only

`product_id` belongs directly on `order_items`: it is collected with the purchase
line, is useful for same-provider deduplication and detail navigation, and the flat
manifest already makes it queryable. Keep the existing name for migration
compatibility, but describe it explicitly as an H-E-B provider product ID in future
manifest prose. Do not rename it to `gtin`, `upc`, `catalog_id`, or
`canonical_product_id`.

If a future **already-collected purchase response** contains an explicit GTIN, the
smallest compatible addition is a nullable scalar `gtin` on `order_items`, defined as
the validated, normalized 14-digit value. Add it only with a field description that
states the direct source surface and validation rule. The source-specific provenance is
then stable connector behavior, rather than per-record speculative metadata. Do not
claim a GTIN merely because a product URL is available.

### Later catalog work — separate enrichment layer/stream

If H-E-B intentionally fetches product pages or embedded catalog state, make that an
optional, separately declared catalog-identity enrichment stream/layer keyed by
`order_item_id` plus the observed `provider_product_id`. It should contain the asserted
GTIN (if any), assertion provenance, retrieval time, extractor/version, validation
status, and—only for matching—method and confidence. This preserves the purchase fact,
lets the catalog refresh on its own lifecycle, and makes a crawl's coverage/failures
honest without downgrading order-item coverage.

For a flat manifest-declared stream, a separate flat enrichment record is preferable to
an array such as `identifiers: [{ type, value, provenance, confidence }]`: the latter
creates nested selection/query semantics that current manifest affordances do not
declare, mixes direct observation with enrichment, and over-designs a one-connector,
one-identifier case. A reusable identifiers structure should be considered only after
multiple connectors demonstrate heterogeneous, source-backed identifiers needing the
same query and provenance behavior.

## Rejected alternatives

1. **Treat H-E-B `product_id` as a UPC/GTIN.** Rejected: it is only a URL-derived
   provider identifier in the current collector; numeric shape is not identifier
   semantics.
2. **Put a guessed/matched GTIN directly on `order_items`.** Rejected: it conflates
   purchase evidence with a revocable enrichment decision and hides confidence and
   provenance.
3. **Crawl product pages during the order collector and call the result a line-item
   field.** Rejected: the H-E-B design expressly excludes that non-owner catalog
   surface, and its failures/rate risk should not become invisible purchase-data
   failures.
4. **Create a universal product ontology now.** Rejected: there is no demonstrated
   cross-connector contract for nested identifiers, variants, packages, and matching.
   The provider ID plus a future narrow GTIN/enrichment seam is lossless and testable.
5. **Make GTIN the line-item primary key.** Rejected: one GTIN may recur across orders,
   pack/variant granularity can differ, and lines without a valid GTIN must still exist.
   Square similarly keeps an order-local line UID separate from a catalog variation
   reference; Shopify associates a purchased line with a product variant rather than
   collapsing the two identities.

## Sources

All external sources accessed 2026-07-15.

- GS1, [Global Trade Item Number (GTIN)](https://www.gs1.org/standards/id-keys/gtin) — GTIN identifies trade items priced, ordered, or invoiced.
- GS1, [Digital Link URI Syntax, release 1.4.0](https://ref.gs1.org/standards/digital-link/uri-syntax/1.4.0/) — 14-digit GTIN representation, primary key and CPV qualifier semantics.
- Schema.org, [Product](https://schema.org/Product) — `gtin8`, `gtin12`, `gtin13`, and `gtin14` field meanings (the rendered reference is also available at [finance.schema.org](https://finance.schema.org/Product)).
- Shopify, [Admin GraphQL `LineItem`](https://shopify.dev/docs/api/admin-graphql/latest/objects/LineItem) and [ProductVariant](https://shopify.dev/docs/api/admin-graphql/latest/objects/Productvariant) — order line, product variant, SKU, and barcode remain distinct concepts.
- Square, [Orders API `OrderLineItem`](https://developer.squareup.com/reference/square/enums/OrderLineItem) — order-local `uid`, catalog variation reference, version, and measured quantity are distinct fields.

## Confidence

**High** on the standards distinction and the recommended H-E-B-now boundary. **Medium**
on the exact future scalar shape because no live H-E-B capture proving an embedded
purchase-page GTIN was provided; that path should be live-verified before any schema
change.
