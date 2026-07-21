-- @terminator: one
-- Total grant-package count for the owner-console overview badge
-- (`GET /_ref/grant-packages/count`), so the overview can show package
-- presence/count without paging the full `/_ref/grant-packages` list. Counts
-- every package row; the list surface itself is not owner-subject-scoped in
-- the reference (single-owner instance), so the count matches its length.
-- Spec: openspec/changes/redesign-owner-console-product-experience/specs/
--       reference-surface-topology/spec.md
SELECT COUNT(*) AS package_count
FROM grant_packages
