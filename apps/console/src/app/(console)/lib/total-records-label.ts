// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Console-side re-export of the centralized state-aware count/label
 * primitives (Sol fourth-verdict P1.3, "Health boundary" —
 * reconcile-active-summary-evidence design.md). Every renderer of a
 * `total_records` value MUST check `isTotalRecordsAuthoritative` (directly or
 * via `formatTotalRecordsLabel`) before treating the number as a proven exact
 * count.
 *
 * The implementation moved to `@pdpp/operator-ui/lib/total-records-label` so
 * that package's pure render-models (`source-storage.ts`, which feeds the
 * deployment page's per-source storage table) can route through the same
 * branching instead of re-deriving it — the dependency runs console →
 * operator-ui, so the shared authority has to live there. This module stays
 * as the console's import path so existing call sites are unchanged.
 */
// biome-ignore lint/performance/noBarrelFile: thin re-export of the ONE shared count-label authority in @pdpp/operator-ui; preserves the console's historical import path (`./total-records-label.ts`) for the view-models, pages, and tests that import these by name.
export { formatTotalRecordsLabel, isTotalRecordsAuthoritative } from "@pdpp/operator-ui/lib/total-records-label";
