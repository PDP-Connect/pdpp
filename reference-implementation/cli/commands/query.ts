// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { parseArgs, requirePositional } from "../lib/args.ts";
import { appendQuery, resolveClientToken, resolveRsUrl } from "../lib/common.ts";
import { PdppUsageError } from "../lib/errors.ts";
import { attachReferenceQueryMetadata, bearer, bodyDataArray, fetchJson } from "../lib/fetch.ts";
import { resolveFormat, writeData } from "../lib/output.ts";

export async function runQuery(argv: string[]): Promise<void> {
  const [subcommand, ...rest] = argv;
  const { flags, positionals } = parseArgs(rest);
  const rsUrl = resolveRsUrl(flags);
  const token = resolveClientToken(flags);
  if (!token) {
    throw new PdppUsageError("Missing client token. Use --token or PDPP_CLIENT_TOKEN.");
  }

  if (subcommand === "streams") {
    const { body, headers } = await fetchJson(`${rsUrl}/v1/streams`, { headers: bearer(token) });
    const format = resolveFormat(flags, "table", "json");
    writeData(format === "json" ? attachReferenceQueryMetadata(body, headers) : bodyDataArray(body), format);
    return;
  }

  if (subcommand === "records") {
    const stream = requirePositional(positionals, 0, "stream");
    const url = appendQuery(`${rsUrl}/v1/streams/${encodeURIComponent(stream)}/records`, {
      changes_since: flags["changes-since"],
      cursor: flags.cursor,
      fields: flags.fields,
      limit: flags.limit,
      view: flags.view,
    });
    const { body, headers } = await fetchJson(url, { headers: bearer(token) });
    writeData(attachReferenceQueryMetadata(body, headers), resolveFormat(flags, "json", "json"));
    return;
  }

  if (subcommand === "get") {
    const stream = requirePositional(positionals, 0, "stream");
    const recordId = requirePositional(positionals, 1, "record-id");
    const { body, headers } = await fetchJson(
      `${rsUrl}/v1/streams/${encodeURIComponent(stream)}/records/${encodeURIComponent(recordId)}`,
      { headers: bearer(token) }
    );
    writeData(attachReferenceQueryMetadata(body, headers), resolveFormat(flags, "json", "json"));
    return;
  }

  throw new PdppUsageError("Usage: pdpp query <streams|records|get> ... [--rs-url <url>] [--token <token>]");
}
