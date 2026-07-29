// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { parseArgs, requirePositional } from "../lib/args.ts";
import { appendQuery, resolveOwnerToken, resolveRsUrl } from "../lib/common.ts";
import { PdppUsageError } from "../lib/errors.ts";
import { attachReferenceQueryMetadata, bearer, bodyDataArray, bodyNextCursor, fetchJson } from "../lib/fetch.ts";
import { resolveFormat, writeData } from "../lib/output.ts";

export async function runOwner(argv: string[]): Promise<void> {
  const [subcommand, ...rest] = argv;
  const { flags, positionals } = parseArgs(rest);
  const rsUrl = resolveRsUrl(flags);
  const token = resolveOwnerToken(flags);
  if (!token) {
    throw new PdppUsageError("Missing owner token. Use --token or PDPP_OWNER_TOKEN.");
  }

  if (subcommand === "streams") {
    const connectorId = flags["connector-id"];
    const url = appendQuery(`${rsUrl}/v1/streams`, { connector_id: connectorId });
    const { body, headers } = await fetchJson(url, { headers: bearer(token) });
    const format = resolveFormat(flags, "table", "json");
    writeData(format === "json" ? attachReferenceQueryMetadata(body, headers) : bodyDataArray(body), format);
    return;
  }

  if (subcommand === "query" || subcommand === "records") {
    const stream = requirePositional(positionals, 0, "stream");
    const connectorId = flags["connector-id"];
    const url = appendQuery(`${rsUrl}/v1/streams/${encodeURIComponent(stream)}/records`, {
      changes_since: flags["changes-since"],
      connector_id: connectorId,
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
    const connectorId = flags["connector-id"];
    const url = appendQuery(
      `${rsUrl}/v1/streams/${encodeURIComponent(stream)}/records/${encodeURIComponent(recordId)}`,
      {
        connector_id: connectorId,
      }
    );
    const { body, headers } = await fetchJson(url, { headers: bearer(token) });
    writeData(attachReferenceQueryMetadata(body, headers), resolveFormat(flags, "json", "json"));
    return;
  }

  if (subcommand === "export") {
    const stream = requirePositional(positionals, 0, "stream");
    const connectorId = flags["connector-id"];

    let cursor: string | null = typeof flags.cursor === "string" ? flags.cursor : null;
    const records: unknown[] = [];
    do {
      const url = appendQuery(`${rsUrl}/v1/streams/${encodeURIComponent(stream)}/records`, {
        connector_id: connectorId,
        cursor,
        limit: flags.limit,
      });
      // Deliberate cursor-pagination loop: each page's cursor comes from the
      // previous response, so requests are inherently sequential, not
      // parallelizable.
      // biome-ignore lint/performance/noAwaitInLoops: see comment above
      const { body } = await fetchJson(url, { headers: bearer(token) });
      records.push(...bodyDataArray(body));
      cursor = bodyNextCursor(body);
      if (flags.limit) {
        break;
      }
    } while (cursor);

    writeData(records, resolveFormat(flags, "jsonl", "jsonl"));
    return;
  }

  throw new PdppUsageError(
    "Usage: pdpp owner <streams|query|records|get|export> ... [--rs-url <url>] [--token <token>] [--connector-id <id>]\n" +
      "--connector-id is only for personal-server/polyfill owner access. Native-provider owner access is provider-local and omits it."
  );
}
