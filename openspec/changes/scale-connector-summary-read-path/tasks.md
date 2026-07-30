## Completed implementation

- [x] Identity-first keyset pages use immutable `(connector_id, created_at,
  connector_instance_id)` ordering, owner-bound cursors, and `limit + 1` lookahead.
- [x] Bare unscoped reads are rejected; `limit` is required and at most 100.
- [x] `connector_id`, `limit`, and `cursor` form one bounded contract; exact
  `connection` remains exclusive and unpaged.
- [x] Every page evidence axis uses exact page ids; empty scopes short-circuit.
- [x] Console first render fetches one page and its interactive pager is
  stateless. First-party scripts use one shared page-follow helper.
- [x] CLI defaults to one bounded page; `--all` is capped, detects repeated
  cursors per invocation, and fails resumably rather than silently truncating.
- [x] SQLite/PostgreSQL identity, cursor, filter, zero-write, and query-slope
  authorities are covered, including large record corpora.
- [x] Connector/run candidates are batch-hydrated once per identity page;
  summary matching, ordering, singleton-active fallback, and bounded event
  windows are unchanged.
- [x] Terminal pages can optionally include health composed from their exact
  inventory; incomplete pages omit it and Overview retains explicit fallback.
