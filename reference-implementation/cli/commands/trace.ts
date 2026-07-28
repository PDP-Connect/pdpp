// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { parseArgs, requirePositional } from "../lib/args.ts";
import { PdppUsageError } from "../lib/errors.ts";
import { bodyDataArray, fetchJson, ownerSessionHeaders } from "../lib/fetch.ts";
import type { OutputFormat } from "../lib/output.ts";
import { resolveFormat, writeData } from "../lib/output.ts";
import { resolveReferenceAsUrl } from "../lib/reference.ts";

function writeTimeline(body: unknown, format: OutputFormat): void {
  if (format === "table") {
    writeData(bodyDataArray(body), "table");
    return;
  }
  writeData(body, format);
}

export async function runTrace(argv: string[]): Promise<void> {
  const [subcommand, ...rest] = argv;
  const { flags, positionals } = parseArgs(rest);
  const asUrl = await resolveReferenceAsUrl(flags);
  const format = resolveFormat(flags, "table", "json");

  if (subcommand === "show") {
    const traceId = requirePositional(positionals, 0, "trace-id");
    const { body } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(traceId)}`, {
      headers: { ...ownerSessionHeaders() },
    });
    writeTimeline(body, format);
    return;
  }

  throw new PdppUsageError("Usage: pdpp trace show <trace-id> [--as-url <url> | --rs-url <url>] [--format json|table]");
}
