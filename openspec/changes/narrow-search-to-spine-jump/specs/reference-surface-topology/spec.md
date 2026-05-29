# reference-surface-topology — narrow-search-to-spine-jump delta

## ADDED Requirements

### Requirement: The operator dashboard SHALL separate record-content search from spine artifact lookup

The operator dashboard (`/dashboard/**`) SHALL provide two distinct search surfaces:

1. **Explore** (`/dashboard/explore`) — record-content search, time-range browsing, and the recency feed across visible connections. This surface is the sole owner-token record-content search surface.
2. **Jump** (`/dashboard/search`) — spine artifact lookup by id. Accepts trace, grant, and run ids and deep-links to the matching artifact page on exact match.

The Jump surface SHALL NOT call record-content search endpoints (`searchRecordsLexical`, `searchRecordsHybrid`, or equivalents). Free-text queries submitted to the Jump surface SHALL redirect to Explore.

#### Scenario: An operator submits a free-text query on Jump

- **WHEN** an operator submits a free-text query on the Jump surface that does not match an exact spine artifact id
- **THEN** the surface SHALL redirect to Explore with the query pre-filled (`/dashboard/explore?q=<query>`)
- **AND** the Jump surface SHALL NOT render record-content search results

#### Scenario: An operator submits an exact id on Jump

- **WHEN** an operator submits a query that exactly matches a known trace id, grant id, or run id
- **THEN** the surface SHALL redirect directly to the matching artifact detail page
- **AND** the `jump=0` query parameter SHALL opt out of the redirect and render the matching spine artifact buckets inline

#### Scenario: The operator dashboard nav labels the two surfaces distinctly

- **WHEN** a user views the operator dashboard navigation
- **THEN** the nav item for record-content search and time-range browsing SHALL be labeled "Explore"
- **AND** the nav item for spine artifact id lookup SHALL be labeled "Jump"
- **AND** no other nav item SHALL present itself as a record-content search surface
