-- @terminator: one
-- Total dirty-scope backlog size. Used by sweep observability and tests
-- asserting the backlog drains to zero after convergence.
SELECT COUNT(*) AS n FROM search_index_dirty WHERE dirty <> 0
