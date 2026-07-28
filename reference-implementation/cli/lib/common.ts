// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

import type { CliFlags } from "./args.ts";
import { PdppUsageError } from "./errors.ts";

// `flags['as-url'] || ...` short-circuits to `true` when the caller passed a
// bare `--as-url` with no value (see args.ts CliFlagValue) — that is a
// pre-existing behavior quirk this migration preserves rather than silently
// "fixes"; downstream URL construction (discovery.ts's normalizeUrl) already
// coerces defensively via String(value).
export function resolveAsUrl(flags: CliFlags): string | true {
  return flags["as-url"] || process.env.PDPP_AS_URL || process.env.AS_URL || "http://localhost:7662";
}

export function resolveRsUrl(flags: CliFlags): string | true {
  return flags["rs-url"] || process.env.PDPP_RS_URL || process.env.RS_URL || "http://localhost:7663";
}

export function resolveOwnerToken(flags: CliFlags): string | true | null {
  return flags.token || process.env.PDPP_OWNER_TOKEN || null;
}

export function resolveClientToken(flags: CliFlags): string | true | null {
  return flags.token || process.env.PDPP_CLIENT_TOKEN || null;
}

export function resolveInitialAccessToken(flags: CliFlags): string | true | null {
  return flags["initial-access-token"] || process.env.PDPP_INITIAL_ACCESS_TOKEN || null;
}

export function readJsonInput(pathOrDash: string): unknown {
  const raw = pathOrDash === "-" ? readFileSync(0, "utf8") : readFileSync(pathOrDash, "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    // PdppCliError carries context via `details`, not the native cause chain
    // (see errors.ts); the message already folds in the underlying
    // JSON.parse error.
    // biome-ignore lint/style/useErrorCause: see comment above
    throw new PdppUsageError(`Invalid JSON input: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function appendQuery(url: string, params: Record<string, unknown>): string {
  const next = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    next.searchParams.set(key, String(value));
  }
  return next.toString();
}
