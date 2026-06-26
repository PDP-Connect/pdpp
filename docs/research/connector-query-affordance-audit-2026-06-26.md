# Connector Query Affordance Audit

Date: 2026-06-26
Status: captured
Source: read-only audit in `/home/tnunamak/.tmp/pdpp-deploy/tmp/workstreams/manifest-semantics-0626.md`

## Question

Do first-party connector manifests expose all useful search, time, range, aggregation, and presentation affordances they already know, without making clients infer semantics from field names?

## Findings

The first-pass `complete-connector-semantic-affordances` change closed the biggest gap: message-like text fields such as Slack `messages.text`, WhatsApp `messages.content`, Claude Code `messages.content`, and Codex `messages.content` now advertise lexical and semantic search where appropriate.

The remaining gaps are second-order but still material for an SLVP-grade read surface:

- Several streams have schema-known creation, start, modified, observed, or message times that are not consistently exposed through range filters or time-bucket aggregation declarations.
- Some event-like streams have start or captured times that should support charting and bounded date reads, such as calendar events and media posts.
- Some stats or inventory streams expose observation dates, but whether those should be `event-time` presentation roles or only query-time range/grouping affordances needs explicit authoring guidance. The older role guide cautions against using `x_pdpp_role: event-time` as a generic timestamp marker.
- Searchability remains uneven for some owner-recognizable fields such as commerce merchant/store names, trip addresses, handles, and history/search-query titles.
- Equality/facet support is not consistently declared or explicitly denied for category/status/type/account fields, leaving clients to guess whether facets are supported.

## Conclusion

The next manifest tranche should not blindly add `event-time` roles to every timestamp. It should separate:

- presentation roles (`x_pdpp_role`) for how a record card reads;
- retrieval affordances (`query.search`, `query.range_filters`) for how a client narrows records;
- aggregation affordances (`query.aggregations.group_by_time`) for time-bucket counts, only on schema-compatible time fields;
- facet/equality affordances, if supported, for stable category-like fields.

The implementation should be driven by manifest-honesty tests plus an allowlist of intentionally unsupported fields with short justifications. The connector authoring guide should be updated after deeper prior-art research rather than relying on field-name intuition.

## Follow-Up

OpenSpec change: `complete-connector-query-affordances`.

