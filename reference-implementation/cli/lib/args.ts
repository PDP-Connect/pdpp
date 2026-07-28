// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { PdppUsageError } from "./errors.ts";

// A `--flag value` pair holds `value`; a bare `--flag` (no inline `=value`
// and no following non-flag token) holds `true`. Every command reads flags
// through this shape, so callers must narrow `true` away before using a
// flag as a string (matching the pre-migration behavior, where a bare flag
// read as a string produced "true").
export type CliFlagValue = string | true;
export type CliFlags = Record<string, CliFlagValue>;

export interface ParsedArgs {
  flags: CliFlags;
  positionals: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: CliFlags = {};
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    if (!rawKey) {
      throw new PdppUsageError("Invalid empty flag");
    }

    if (inlineValue !== undefined) {
      flags[rawKey] = inlineValue;
      continue;
    }

    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      flags[rawKey] = next;
      i += 1;
      continue;
    }

    flags[rawKey] = true;
  }

  return { flags, positionals };
}

export function requirePositional(positionals: string[], index: number, name: string): string {
  const value = positionals[index];
  if (!value) {
    throw new PdppUsageError(`Missing required argument: ${name}`);
  }
  return value;
}

export function requireFlag(flags: CliFlags, name: string, message: string | null = null): string {
  const value = flags[name];
  if (!value || value === true) {
    throw new PdppUsageError(message || `Missing required flag: --${name}`);
  }
  return value;
}
