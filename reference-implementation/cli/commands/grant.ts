// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { parseArgs, requirePositional } from "../lib/args.ts";
import { readJsonInput } from "../lib/common.ts";
import { PdppUsageError } from "../lib/errors.ts";
import { attachReferenceQueryMetadata, bodyDataArray, fetchJson, ownerSessionHeaders } from "../lib/fetch.ts";
import { resolveFormat, writeData } from "../lib/output.ts";
import { resolveReferenceAsUrl } from "../lib/reference.ts";

export async function runGrant(argv: string[]): Promise<void> {
  const [subcommand, ...rest] = argv;
  const { flags, positionals } = parseArgs(rest);
  const asUrl = await resolveReferenceAsUrl(flags);

  if (subcommand === "start") {
    const source = requirePositional(positionals, 0, "path-or--");
    const request = readJsonInput(source);
    const { body, headers } = await fetchJson(`${asUrl}/oauth/par`, {
      body: JSON.stringify(request),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const format = resolveFormat(flags, "json", "json");
    writeData(format === "json" ? attachReferenceQueryMetadata(body, headers) : body, format);
    return;
  }

  const grantId = requirePositional(positionals, 0, "grant-id");

  if (subcommand === "revoke") {
    // The reference revoke endpoint requires an owner bearer or the grant's
    // own client bearer. See
    // openspec/changes/harden-reference-auth-surfaces/specs/
    //   reference-implementation-architecture/spec.md
    const token = flags.token || process.env.PDPP_CLIENT_TOKEN || process.env.PDPP_OWNER_TOKEN;
    if (!token) {
      throw new PdppUsageError(
        "Missing required token. Use --token, PDPP_OWNER_TOKEN, or PDPP_CLIENT_TOKEN. " +
          "Owner bearer revokes any grant; a client bearer only revokes the grant it is bound to."
      );
    }
    const { body, headers } = await fetchJson(`${asUrl}/grants/${encodeURIComponent(grantId)}/revoke`, {
      headers: { Authorization: `Bearer ${token}` },
      method: "POST",
    });
    const format = resolveFormat(flags, "json", "json");
    writeData(format === "json" ? attachReferenceQueryMetadata(body, headers) : body, format);
    return;
  }

  if (subcommand === "timeline") {
    const { body } = await fetchJson(`${asUrl}/_ref/grants/${encodeURIComponent(grantId)}/timeline`, {
      headers: { ...ownerSessionHeaders() },
    });
    const format = resolveFormat(flags, "table", "json");
    writeData(format === "table" ? bodyDataArray(body) : body, format);
    return;
  }

  throw new PdppUsageError(
    "Usage: pdpp grant <start|revoke|timeline> ...\n" +
      "  start <path-or-> [--as-url <url> | --rs-url <url>] [--format json|table]\n" +
      "  revoke <grant-id> [--as-url <url> | --rs-url <url>] [--format json|table]\n" +
      "  timeline <grant-id> [--as-url <url> | --rs-url <url>] [--format json|table]"
  );
}
