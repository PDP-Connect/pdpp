// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { parseArgs, requirePositional } from "../args.js";
import { PdppUsageError } from "../errors.js";
import { fetchJson, ownerSessionHeaders, resolveReferenceUrl } from "../fetch.js";
import { resolveFormat, writeData, writeEnvelopeWarnings } from "../output.js";

export async function runRefRun(argv, io = {}, fetchImpl = globalThis.fetch) {
  const [subcommand, ...rest] = argv;
  const { flags, positionals } = parseArgs(rest);
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;

  if (subcommand === "timeline") {
    const runId = requirePositional(positionals, 0, "run-id");
    const asUrl = resolveReferenceUrl(flags);
    const ownerSession = flags["owner-session"] || "";
    const cacheRoot = flags["cache-root"];
    const { body } = await fetchJson(
      `${asUrl}/_ref/runs/${encodeURIComponent(runId)}/timeline`,
      { headers: { ...ownerSessionHeaders({ ownerSession, referenceUrl: asUrl, cacheRoot }) } },
      fetchImpl
    );
    const format = resolveFormat(flags, "table", "json");
    writeData(format === "table" ? body.data || [] : body, format, out);
    writeEnvelopeWarnings(body, err);
    return 0;
  }

  throw new PdppUsageError(
    "Usage: pdpp ref run timeline <run-id> [--as-url <url>] [--owner-session <cookie>] [--format json|table]"
  );
}
