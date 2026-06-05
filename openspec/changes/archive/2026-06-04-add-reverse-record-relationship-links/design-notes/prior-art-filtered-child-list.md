# Prior art — parent → child backlink via filtered list, not unbounded load

Status: captured (2026-06-04). Scope: justification for the bounded filtered-list
form chosen in this change's `design.md` (D1). Non-normative.

## Question

How do mature data/admin/CRM surfaces expose a **parent** record's related
**child** records (the reverse relation — "this account's transactions", "this
customer's invoices") without loading an unbounded child collection inline on the
parent page?

## Survey

| System | Affordance | Children bounded? | Source |
|---|---|---|---|
| Salesforce Related Lists | Parent page shows a small related-list panel with a "View All" link to the full filtered child list | Bounded — Lightning default ~5–10 (configurable), Classic default 5 (5–100); full set behind "View All" | <https://help.salesforce.com/s/articleView?id=sf.basics_understanding_related_lists_lex.htm&type=5> |
| Django admin | Idiomatic backlink is a link from the parent to the child *changelist* pre-filtered by FK: `?<fk>__id__exact=<pk>` | Bounded — changelist paginated (`list_per_page`, default 100). `TabularInline`/`StackedInline` are explicitly **not** paginated, the documented footgun the filtered-changelist link avoids | <https://docs.djangoproject.com/en/dev/ref/contrib/admin/filters/> |
| Stripe Dashboard | Customer page links to that customer's subscriptions, invoices, payments as object lists scoped to the customer | Bounded — scoped, paginated list surfaces, not an inline dump | <https://docs.stripe.com/billing/customer> |
| Airtable / Notion | Linked records shown as a property; drill into a filtered view for the full scoped set | Capped display — Notion relations cap (1-page / no-limit) and recommend filtered linked-DB views; Airtable steers high-cardinality display to lookups/rollups + filtered views | <https://www.notion.com/help/relations-and-rollups> · <https://support.airtable.com/docs/limiting-linked-record-selection-to-a-view> |
| PostgREST / Hasura / Supabase | Children embed via `?select=*,children(...)` / nested fields, but docs require a per-resource `limit` on the embedded set | Must be bounded — PostgREST prefix limits + `db-max-rows`; Hasura: "always set a `limit` on every array relationship, including nested" | <https://docs.postgrest.org/en/stable/references/api/resource_embedding.html> · <https://hasura.io/docs/2.0/queries/postgres/pagination/> |
| Rails / ActiveAdmin | `belongs_to` generates scoped child routes (`/admin/projects/1/tickets`, a filtered child index); inline panels use `paginated_collection` | Bounded — Kaminari pagination required even on inline panels | <https://activeadmin.info/2-resource-customization.html> |

## Synthesis

- The dominant, battle-tested pattern is exactly the one this change proposes:
  the parent detail page links to a **server-side filtered child list view**
  keyed by the foreign key (`filter[<fk>]=<parentKey>`). Salesforce "View All",
  Django `?<fk>__id__exact=<pk>` changelist, Stripe scoped object lists, and
  ActiveAdmin `belongs_to` scoped index are direct instances.
- Where children render inline at all, **every** mature system gates them behind
  an explicit bound (Salesforce ~5, Django `list_per_page` 100, PostgREST/Hasura
  mandatory per-embed `limit` + `db-max-rows`). The recurring lesson (Django
  inlines, Hasura nested `order_by`) is that an *unbounded* inline child load is
  a correctness/performance bug, not a feature.
- Caveat: Notion and Airtable do render linked records on the parent, but those
  are user-curated, low-cardinality relations and still cap or steer
  high-cardinality display to filtered views. They confirm the cap-or-link-out
  rule rather than contradict it.
- Net: "parent detail → **link** to a bounded, filtered child list
  (`filter[<fk>]=<parentKey>`), never an inline unbounded load" is the
  cross-industry consensus. A bounded inline *preview* with a deep link is an
  acceptable later enhancement, provided the preview is capped server-side. This
  change deliberately ships only the link (no preview) as the lean slice.

## Why this matters for PDPP

The reference console already implements the receiving end: the stream list page
reads `filter[<field>]=<value>` query params and passes them to the server's
`GET /v1/streams/<child>/records?filter[<fk>]=<value>` list endpoint, which the
forward `has_many` navigation (`buildRelatedLinks`) already targets. The reverse
parent→child affordance is the inverse of that same bounded form — so the prior
art lands on a pattern the reference already supports server-side, with no new
query grammar, no inline collection load, and no reverse `expand`.
