# Connector Authoring Semantics Prior Art

Status: captured
Date: 2026-06-24
Owner: Codex
Scope: prior art for connector manifest authoring rules: searchable fields, presentation roles, relationships, and docs people actually use.

## Question

How should PDPP connector authors decide which fields are searchable, semantic-searchable, display-primary, actors, event times, relationships, and follow-up affordances, without relying on readers to absorb a long guide?

## Prior Art

| Source | Relevant Pattern | Implication for PDPP |
| --- | --- | --- |
| [Algolia `searchableAttributes`](https://www.algolia.com/doc/api-reference/api-parameters/searchableAttributes) | Searchable attributes are explicit; Algolia warns against searching URLs or image paths; attribute order affects ranking. | PDPP should require explicit searchable fields and reject "all strings are searchable." Natural-language fields should be declared; identifiers and paths should not be semantic text. |
| [Algolia `attributesForFaceting`](https://www.algolia.com/doc/api-reference/api-parameters/attributesForFaceting) | Filter/facet fields are separately declared from searchable text. | Search, filters, facets/aggregations, and presentation roles are separate axes. A field can be readable without being searchable or aggregatable. |
| [Elasticsearch `text` field type](https://www.elastic.co/docs/reference/elasticsearch/mapping-reference/text) | Text fields are analyzed for full-text search; keyword/multi-fields exist for exact matching, sorting, and aggregations. | PDPP should distinguish natural-language retrieval from exact/filter/query capability and avoid treating a string type as one universal behavior. |
| [Elasticsearch multi-fields](https://www.elastic.co/docs/reference/elasticsearch/mapping-reference/multi-fields) | A source value can have multiple index representations; multi-fields do not change `_source`. | PDPP can expose one readable field while declaring separate retrieval/presentation affordances; these declarations should not mutate record data. |
| [Airtable primary field](https://support.airtable.com/docs/the-primary-field) | The primary field represents each record and is special for display; field type alone does not determine the record's identity label. | PDPP needs `primary-title` roles. Clients should not guess the title from "first string field." |
| [Airtable field types](https://support.airtable.com/docs/supported-field-types-in-airtable-overview) | Field type is an explicit part of authoring and user display. | PDPP should keep `x_pdpp_type` for formatting separate from `x_pdpp_role` for placement. |
| [Salesforce compact layouts](https://developer.salesforce.com/docs/atlas.en-us.api_tooling.meta/api_tooling/tooling_api_objects_compactlayoutinfo.htm) | Compact layout metadata determines which fields represent a record in constrained surfaces. | PDPP connector manifests should carry compact display roles for model/UI surfaces, not bury them in dashboard code. |
| [Salesforce REST search result layouts](https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/resources_list.htm) | Search result layout fields are returned as metadata separate from object schema. | Retrieval result presentation is an authored contract. Search result fields should be discoverable, not inferred by each client. |
| [Stripe API reference](https://docs.stripe.com/api) | Resource objects are predictable; fields include semantics like IDs, expandable references, metadata, and display descriptions. | PDPP manifests should preserve predictable field semantics and separate source IDs, display text, relationships, and metadata. |
| [Stripe Search](https://docs.stripe.com/search) | Search is a distinct API surface for looking up objects; not every resource or field is searched the same way. | PDPP's `query.search` declarations are a capability boundary, not an incidental property of schemas. |
| [Stripe Metadata](https://docs.stripe.com/api/metadata) | Metadata is structured lookup context, often for linking system IDs. | PDPP should not index system IDs as semantic text just because they help lookup. Exact/filter affordances are the correct path. |
| [Plaid Transactions API](https://plaid.com/docs/api/products/transactions/) | Transaction records separate merchant, geolocation, category, account, and date fields. | Financial connectors need typed roles and filter/aggregation affordances, not a single body-text model. |
| [Plaid Identity API](https://plaid.com/docs/api/products/identity/) | Identity fields such as name, address, phone, and email have different use and sensitivity than transaction text. | Names may be lexical/actor/display roles; phone/email/address should not become semantic body fields by default. |
| [GitHub issue/PR APIs](https://docs.github.com/rest/issues/issues) | Issues and pull requests share concepts but use explicit fields such as title, body, comments, author, and pull request markers. | Related streams can share role vocabulary while still declaring source-specific fields. |
| [Slack `conversations.history`](https://docs.slack.dev/reference/methods/conversations.history) | Message history retrieval is paginated/time-bounded and returns message records from scoped conversations. | Chat connectors should declare message text, actor, thread/time fields, and bounded read escalation affordances explicitly. |
| [Slack Conversations API](https://docs.slack.dev/apis/web-api/using-the-conversations-api) | Slack unifies different conversation kinds behind a common conversation interface. | PDPP should use a common role vocabulary across Slack, WhatsApp, iMessage, Gmail, and model chats while preserving connector-specific fields. |
| [OpenAPI Specification](https://spec.openapis.org/oas/v3.2.0.html) | Machine-readable API descriptions let consumers understand and interact with a service with minimal implementation logic. | The connector manifest must be machine-enforced. A prose-only authoring guide is not enough. |
| [Prisma relations](https://www.prisma.io/docs/orm/prisma-schema/data-model/relations) | Relations are explicit links between models. | PDPP connector relationships should be declared, not discovered by clients matching `*_id` fields. |
| [Segment Protocols Tracking Plan](https://www.twilio.com/docs/segment/protocols/tracking-plan/create) | Tracking plans validate observed data against the spec and produce violations. | PDPP should pair authoring docs with manifest-honesty tests that fail when declarations drift. |
| [MCP tools specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) | Tools are model-callable operations with names, descriptions, and schemas. | PDPP MCP output must include enough schema metadata for a model to choose the right next action without inspecting raw records. |
| [Diátaxis](https://diataxis.fr/) | Documentation serves different needs: tutorials, how-to guides, reference, and explanation. | The connector guide should be a short task checklist plus examples, while deeper rationale stays in research/design docs. |
| [Google developer documentation style guide](https://developers.google.com/style) | Developer docs should be clear, consistent, and user-friendly. | The connector guide should use direct language, active voice, and concrete examples. |
| [Write the Docs beginner guide](https://www.writethedocs.org/guide/writing/beginners-guide-to-docs/) | Good docs explain why the project exists, how to install, and how to use it. | The guide should start from the reviewer's job: "make this connector useful and honest," not from a field-by-field taxonomy dump. |

## Findings

1. Mature systems separate schema/type from search, filter, relation, and display behavior. PDPP should keep those as independent manifest declarations.
2. Search configuration must be explicit. Good search products do not blindly search every string; they prioritize natural-language fields and exclude URLs, paths, hashes, status codes, and IDs.
3. Presentation is authored metadata. Airtable and Salesforce both show that constrained record surfaces need explicitly chosen display fields.
4. Relationships are contracts. Prisma/OpenAPI-style explicit relation metadata beats clients guessing from `*_id` fields.
5. Documentation must be backed by enforcement. Segment-style validation is the relevant pattern: a guide plus checks that fail when live artifacts drift.
6. The connector guide should be short and operational: a checklist, examples, anti-patterns, and links to tests. Longer rationale belongs in research or OpenSpec.

## Design Consequences

- Add/keep manifest-honesty tests for retrieval affordances and presentation roles.
- Treat `query.search`, filter/range/aggregation declarations, relationships, `x_pdpp_type`, and `x_pdpp_role` as separate axes.
- Require every supported stream to declare at least one presentation role and at most one `primary-title`.
- Require top-level natural-language fields to be searchable unless the field is intentionally excluded by rule.
- Write the connector authoring guide as a review checklist that points to tests, not a long essay.
