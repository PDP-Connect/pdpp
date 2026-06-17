## MODIFIED Requirements

### Requirement: CLI and tests are first-class consumers

The CLI and executable tests SHALL consume the real public or reference-designated surfaces of the implementation rather than private database shortcuts or website-only glue.

#### Scenario: The CLI needs to inspect a reference object
- **WHEN** the CLI needs trace, grant, run, owner, or provider information
- **THEN** it SHALL use the relevant public or explicitly reference-designated HTTP surface rather than bypassing the server through direct database access

#### Scenario: The test suite verifies behavior
- **WHEN** executable tests prove reference behavior
- **THEN** those tests SHALL prefer black-box interaction with the running reference surfaces unless a narrower white-box test is intentionally justified for implementation internals

#### Scenario: Broad owner search runs on Postgres
- **WHEN** the reference implementation serves owner-token lexical or semantic search from a Postgres storage backend across multiple owner-visible connector instances
- **THEN** it SHALL bound concurrent per-source database work so broad packages do not start every source query at once
- **AND** it SHALL use database indexes shaped to the authorization scope predicates used by the search query
- **AND** it SHALL size semantic per-source candidate work from the requested page size rather than always using the maximum page size
- **AND** it SHALL coalesce unfiltered same-connection semantic scope reads when doing so preserves the same grant and filter semantics
- **AND** it SHALL NOT rely on fixed wall-clock sleeps or request-duration caps as the primary safety mechanism
