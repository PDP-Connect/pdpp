/**
 * Compatibility source for tests and legacy dashboard-path imports. The live
 * console route-group implementation lives under `app/(console)/lib`.
 */

import { DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN as REFERENCE_DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN } from "pdpp-reference-implementation/reference-local-defaults";

// biome-ignore lint/performance/noBarrelFile: legacy dashboard-path callers import this compatibility module directly.
export { DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN } from "pdpp-reference-implementation/reference-local-defaults";

export const DEFAULT_DCR_INITIAL_ACCESS_TOKEN =
  (process.env.PDPP_DCR_INITIAL_ACCESS_TOKENS || "")
    .split(",")
    .map((value) => value.trim())
    .find(Boolean) || REFERENCE_DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN;
