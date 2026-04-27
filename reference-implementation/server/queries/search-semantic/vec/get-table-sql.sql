-- @terminator: one
SELECT sql FROM sqlite_master
WHERE type = 'table' AND name = 'semantic_search_vec'
