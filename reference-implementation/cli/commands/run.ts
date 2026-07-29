// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { parseArgs, requirePositional } from "../lib/args.ts";
import { PdppUsageError } from "../lib/errors.ts";
import { bodyDataArray, fetchJson, ownerSessionHeaders } from "../lib/fetch.ts";
import { resolveFormat, writeData } from "../lib/output.ts";
import { resolveReferenceAsUrl } from "../lib/reference.ts";

export async function runRun(argv: string[]): Promise<void> {
  const [subcommand, ...rest] = argv;
  const { flags, positionals } = parseArgs(rest);
  const asUrl = await resolveReferenceAsUrl(flags);

  if (subcommand === "timeline") {
    const runId = requirePositional(positionals, 0, "run-id");
    const { body } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(runId)}/timeline`, {
      headers: { ...ownerSessionHeaders() },
    });
    const format = resolveFormat(flags, "table", "json");
    writeData(format === "table" ? bodyDataArray(body) : body, format);
    return;
  }

  throw new PdppUsageError("Usage: pdpp run timeline <run-id> [--as-url <url> | --rs-url <url>] [--format json|table]");
}
