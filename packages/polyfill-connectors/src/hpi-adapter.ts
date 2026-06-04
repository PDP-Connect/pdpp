/**
 * HPI (karlicoss/HPI) adapter — the flagship OSS wrap.
 *
 * HPI is "my life in a Python package": a personal-data layer over exports/APIs/
 * local files with maintained per-source modules. It exposes a first-class CLI:
 *
 *   hpi query my.<module>.<function> -o json [--stream] \
 *     [--order-key <field>] [--order-type datetime] [--after <iso>] \
 *     [--before <iso>] [--limit <n>]
 *
 * which emits the function's output as JSON/JSONL on stdout — exactly the shape
 * our external-tool adapter consumes. One `hpi` adapter + a small per-module
 * mapping (HPI function -> PDPP stream, order-key -> cursor_field) turns HPI's
 * many modules into PDPP connectors. We delegate the source-specific complexity
 * (DALs, export parsing, schema drift) to upstream, which actively maintains it.
 *
 * Most HPI modules read user-provided exports configured via `my.config`
 * export_path on the host, so an HPI-backed connector is a FILESYSTEM-binding,
 * offline connector — no live-account brittleness.
 */

import { type ExternalToolSpec, parseToolRecords, runExternalTool } from "./external-tool-adapter.ts";

export const HPI_TOOL: ExternalToolSpec = {
  name: "hpi",
  binEnvVar: "HPI_BIN",
  defaultBin: "hpi",
  installHint:
    "pip install HPI (or pipx install HPI), then configure the module's my.config (e.g. export_path) on the host. See https://github.com/karlicoss/HPI/blob/master/doc/SETUP.org.",
  timeoutEnvVar: "HPI_TIMEOUT_MS",
  defaultTimeoutMs: 30 * 60 * 1000,
};

/** Maps one PDPP stream onto an HPI query. */
export interface HpiStreamMapping {
  /** Fully-qualified HPI function, e.g. "my.reddit.all.saved". */
  readonly hpiFunction: string;
  /** Object field to order/cursor by (e.g. "created"), maps to cursor_field. */
  readonly orderKey?: string;
  /** Order type for the CLI when orderKey is a time field. */
  readonly orderType?: "datetime" | "date" | "int" | "float";
  /** PDPP stream name. */
  readonly stream: string;
}

/** Time window + limit derived from PDPP START.scope for one stream. */
export interface HpiQueryWindow {
  /** Max items, maps to --limit. */
  readonly limit?: number;
  /** ISO lower bound (inclusive), maps to --after. */
  readonly since?: string;
  /** ISO upper bound (exclusive), maps to --before. */
  readonly until?: string;
}

/**
 * Build `hpi query` argv for one stream mapping + window. Pure + unit-testable:
 * the exact CLI contract is asserted in tests so an HPI version bump that moves
 * a flag is caught without a live run.
 */
export function buildHpiQueryArgs(mapping: HpiStreamMapping, window: HpiQueryWindow = {}): string[] {
  const args = ["query", mapping.hpiFunction, "-o", "json", "--stream"];
  if (mapping.orderKey) {
    args.push("--order-key", mapping.orderKey);
    if (mapping.orderType) {
      args.push("--order-type", mapping.orderType);
    }
  }
  if (window.since) {
    args.push("--after", window.since);
  }
  if (window.until) {
    args.push("--before", window.until);
  }
  if (typeof window.limit === "number" && window.limit > 0) {
    args.push("--limit", String(window.limit));
  }
  return args;
}

/** Run one HPI stream query and return parsed records. */
export async function queryHpiStream(
  mapping: HpiStreamMapping,
  window: HpiQueryWindow = {},
  options: { env?: NodeJS.ProcessEnv } = {}
): Promise<Record<string, unknown>[]> {
  const args = buildHpiQueryArgs(mapping, window);
  const { stdout } = await runExternalTool(HPI_TOOL, args, options);
  return parseToolRecords(stdout);
}

/** Derive the HPI query window for a stream from a PDPP START stream scope. */
export function windowFromScope(scope: {
  time_range?: { since?: string; until?: string };
  limit?: number;
}): HpiQueryWindow {
  const window: HpiQueryWindow = {
    ...(scope.time_range?.since == null ? {} : { since: scope.time_range.since }),
    ...(scope.time_range?.until == null ? {} : { until: scope.time_range.until }),
    ...(typeof scope.limit === "number" ? { limit: scope.limit } : {}),
  };
  return window;
}
