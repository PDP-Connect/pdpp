# First-Party Aggregation Declarations

This note documents the conservative `query.aggregations` declarations added for the first single-stream aggregate surface.

## Included

- `ynab.transactions`: count, amount sum/min/max, date min/max, and grouped counts by low-cardinality status/type fields.
- `chase.transactions`: count, amount sum/min/max, date min/max, and grouped counts by currency/type.
- `usaa.transactions`: count, amount and balance sum/min/max, date min/max, and grouped counts by currency/category.
- `gmail.messages`: count, size sum/min/max, received/date min/max, and grouped counts by boolean message-state fields.
- `slack.messages`: count, engagement count sum/min/max, sent_at min/max, and grouped counts by boolean message-shape fields.

## Excluded

- Free-text fields such as memo, name, description, subject, snippet, and Slack text are not groupable or aggregatable.
- Stable identifiers such as message ids, user ids, channel ids, account ids, payee ids, transaction ids, and thread ids are not groupable because they are high-cardinality and can disclose sensitive relationships.
- Arrays, objects, blob references, attachment filenames, email participant lists, and relationship-expanded child data are excluded from v1 aggregation declarations.
- Cross-stream summaries, joins, entity resolution, percentiles, arbitrary expressions, and dashboard-specific rollups remain out of scope.
