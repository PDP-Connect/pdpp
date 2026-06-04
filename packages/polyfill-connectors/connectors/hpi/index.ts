#!/usr/bin/env node
/**
 * PDPP HPI Connector (v0.1.0) — wraps karlicoss/HPI as an OSS adapter.
 *
 * HPI ("Human Programming Interface") is a maintained personal-data layer over
 * exports/APIs/local files. This connector delegates the source-specific
 * complexity (DALs, export parsing, schema drift) to HPI's upstream-maintained
 * modules and exposes them as PDPP streams via the external-tool adapter:
 *
 *   hpi query my.<module>.<fn> -o json --stream [--order-key ...] [--after ...]
 *
 * One connector + a per-module stream mapping turns many HPI modules into PDPP
 * streams. The mapping below is the default (Reddit + coding commits); it is
 * overridable via the HPI_STREAMS env option today, and via
 * START.connector_options.STREAMS once the options_schema lands
 * (promote-connector-config-schema).
 *
 * Binding: HPI modules typically read user-provided exports configured via
 * my.config (export_path) on the host, so this is a FILESYSTEM-binding, offline
 * connector — no live-account brittleness. Network is also requested because a
 * few HPI modules fetch.
 *
 * External tool: `hpi` (MIT). Install: `pip install HPI`; configure each
 * module's my.config on the host. Declared in manifests/hpi.json
 * runtime_requirements.external_tools (enforced by external-tool-manifest-honesty).
 *
 * Streams (default mapping):
 *   reddit_saved     my.reddit.all.saved      (mutable_state, cursor: created)
 *   reddit_comments  my.reddit.all.comments   (append_only,  cursor: created)
 *   commits          my.coding.commits.commits(append_only,  cursor: committed_dt)
 */

import { readOptions } from "../../src/connector-options.ts";
import { type CollectContext, nowIso, type RecordData, runConnector } from "../../src/connector-runtime.ts";
import { type HpiQueryWindow, type HpiStreamMapping, queryHpiStream, windowFromScope } from "../../src/hpi-adapter.ts";
import { isMainModule } from "../../src/is-main-module.ts";
import { validateRecord } from "./schemas.ts";

const DEFAULT_MAPPINGS: readonly HpiStreamMapping[] = [
  { stream: "reddit_saved", hpiFunction: "my.reddit.all.saved", orderKey: "created", orderType: "datetime" },
  { stream: "reddit_comments", hpiFunction: "my.reddit.all.comments", orderKey: "created", orderType: "datetime" },
  { stream: "commits", hpiFunction: "my.coding.commits.commits", orderKey: "committed_dt", orderType: "datetime" },
];

const OPTIONS_SPEC = {
  envPrefix: "HPI_",
  fields: {
    // JSON array of {stream,hpiFunction,orderKey,orderType}. Empty -> defaults.
    STREAMS: { parse: "string" as const, default: "" },
  },
};

function resolveMappings(): readonly HpiStreamMapping[] {
  const opts = readOptions(null, OPTIONS_SPEC);
  const raw = typeof opts.STREAMS === "string" ? opts.STREAMS.trim() : "";
  if (!raw) {
    return DEFAULT_MAPPINGS;
  }
  try {
    const parsed = JSON.parse(raw) as HpiStreamMapping[];
    if (
      Array.isArray(parsed) &&
      parsed.every((m) => m && typeof m.stream === "string" && typeof m.hpiFunction === "string")
    ) {
      return parsed;
    }
  } catch {
    // fall through to defaults on malformed override
  }
  return DEFAULT_MAPPINGS;
}

/** Advance a string cursor to the larger of (current, candidate). */
function advanceCursor(current: string | null, candidate: unknown): string | null {
  if (typeof candidate !== "string") {
    return current;
  }
  return current === null || candidate > current ? candidate : current;
}

/** Fetch + emit one HPI-backed stream. Per-stream failures skip, never abort. */
async function collectStream(ctx: CollectContext, mapping: HpiStreamMapping, window: HpiQueryWindow): Promise<void> {
  const { emit, emitRecord } = ctx;
  let records: Record<string, unknown>[];
  try {
    records = await queryHpiStream(mapping, window);
  } catch (err) {
    // A missing module/config is a per-stream skip, not a whole-run failure:
    // an owner may have configured my.reddit but not my.coding.commits.
    await emit({
      type: "SKIP_RESULT",
      stream: mapping.stream,
      reason: "hpi_query_failed",
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  let latest: string | null = null;
  for (const record of records) {
    if (record.id == null) {
      await emit({
        type: "SKIP_RESULT",
        stream: mapping.stream,
        reason: "missing_id",
        message: `record on ${mapping.stream} has no id field`,
      });
      continue;
    }
    const data: RecordData = { ...record, fetched_at: record.fetched_at ?? nowIso() };
    await emitRecord(mapping.stream, data);
    if (mapping.orderKey) {
      latest = advanceCursor(latest, record[mapping.orderKey]);
    }
  }
  await emit({ type: "STATE", stream: mapping.stream, cursor: { last_cursor: latest, last_run_at: nowIso() } });
}

async function collect(ctx: CollectContext): Promise<void> {
  const { progress, requested } = ctx;
  for (const mapping of resolveMappings()) {
    const scope = requested.get(mapping.stream);
    // requested is the runtime-resolved scope map. When non-empty and this
    // stream isn't in it, the runtime did not request it — skip silently.
    if (requested.size > 0 && !scope) {
      continue;
    }
    const window = windowFromScope(
      (scope ?? {}) as { time_range?: { since?: string; until?: string }; limit?: number }
    );
    await progress(`hpi query ${mapping.hpiFunction} → stream ${mapping.stream}`, { stream: mapping.stream });
    await collectStream(ctx, mapping, window);
  }
}

if (isMainModule(import.meta.url)) {
  runConnector({ name: "hpi", collect, validateRecord });
}

export { collect, DEFAULT_MAPPINGS, resolveMappings };
