// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { parseArgs, requirePositional } from "../args.ts";
import { PdppUsageError } from "../errors.ts";
import { fetchJson, ownerSessionHeaders, resolveReferenceUrl } from "../fetch.ts";
import { resolveFormat, writeData, writeEnvelopeWarnings } from "../output.ts";
import type { CommandIo } from "./call.ts";

export async function runRefRun(
  argv: string[],
  io: CommandIo = {},
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<number> {
  const [subcommand, ...rest] = argv;
  const { flags, positionals } = parseArgs(rest);
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;

  if (subcommand === "timeline") {
    const runId = requirePositional(positionals, 0, "run-id");
    const asUrl = resolveReferenceUrl(flags);
    const ownerSession = typeof flags["owner-session"] === "string" ? flags["owner-session"] : "";
    const cacheRoot = typeof flags["cache-root"] === "string" ? flags["cache-root"] : undefined;
    const { body } = await fetchJson(
      `${asUrl}/_ref/runs/${encodeURIComponent(runId)}/timeline`,
      { headers: { ...ownerSessionHeaders({ ownerSession, referenceUrl: asUrl, cacheRoot }) } },
      fetchImpl
    );
    const format = resolveFormat(flags, "table", "json");
    const typedBody = body as { data?: unknown[] };
    writeData(format === "table" ? typedBody.data || [] : body, format, out);
    writeEnvelopeWarnings(body, err);
    return 0;
  }

  throw new PdppUsageError(
    "Usage: pdpp ref run timeline <run-id> [--as-url <url>] [--owner-session <cookie>] [--format json|table]"
  );
}
