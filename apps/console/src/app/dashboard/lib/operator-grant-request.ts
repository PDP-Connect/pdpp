/**
 * Compatibility source for tests and legacy dashboard-path imports. The live
 * console route-group implementation lives under `app/(console)/lib`.
 */

import { DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN } from "pdpp-reference-implementation/reference-local-defaults";

export { DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN };

export const DEFAULT_DCR_INITIAL_ACCESS_TOKEN =
  (process.env.PDPP_DCR_INITIAL_ACCESS_TOKENS || "")
    .split(",")
    .map((value) => value.trim())
    .find(Boolean) || DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN;
