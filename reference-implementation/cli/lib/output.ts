// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { CliFlags } from "./args.ts";

export type OutputFormat = "json" | "jsonl" | "table";

export function resolveFormat(
  flags: CliFlags,
  defaultWhenTty: OutputFormat = "json",
  defaultWhenPipe: OutputFormat = "json"
): OutputFormat {
  const requested = flags.format;
  if (requested && requested !== true) {
    return requested as OutputFormat;
  }
  return process.stdout.isTTY ? defaultWhenTty : defaultWhenPipe;
}

export function writeData(data: unknown, format: OutputFormat = "json"): void {
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }

  if (format === "jsonl") {
    if (!Array.isArray(data)) {
      process.stdout.write(`${JSON.stringify(data)}\n`);
      return;
    }
    for (const item of data) {
      process.stdout.write(`${JSON.stringify(item)}\n`);
    }
    return;
  }

  if (format === "table") {
    writeTable(data);
    return;
  }

  throw new Error(`Unsupported format: ${format satisfies never}`);
}

// A table row's cell values are display data of unknown shape (record
// fields, API response bodies); flattenRow reduces every value down to a
// displayable string, so downstream table rendering only ever sees strings.
type TableRow = Record<string, unknown>;

function writeTable(data: unknown): void {
  const rows: TableRow[] = Array.isArray(data) ? data : [data as TableRow];
  if (!rows.length) {
    process.stdout.write("(empty)\n");
    return;
  }

  const normalized = rows.map((row) => flattenRow(row));
  const columns = Array.from(
    normalized.reduce((acc, row) => {
      for (const key of Object.keys(row)) {
        acc.add(key);
      }
      return acc;
    }, new Set<string>())
  );

  const widths: Record<string, number> = Object.fromEntries(
    columns.map((column) => [
      column,
      Math.max(column.length, ...normalized.map((row) => String(row[column] ?? "").length)),
    ])
  );

  const renderRow = (row: Record<string, string>) =>
    columns.map((column) => String(row[column] ?? "").padEnd(widths[column] ?? 0)).join("  ");

  process.stdout.write(`${renderRow(Object.fromEntries(columns.map((column) => [column, column])))}\n`);
  process.stdout.write(`${columns.map((column) => "-".repeat(widths[column] ?? 0)).join("  ")}\n`);
  for (const row of normalized) {
    process.stdout.write(`${renderRow(row)}\n`);
  }
}

function flattenRow(row: TableRow): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(row)) {
    if (Array.isArray(value)) {
      out[key] = value.join(", ");
    } else if (value && typeof value === "object") {
      out[key] = JSON.stringify(value);
    } else {
      out[key] = String(value ?? "");
    }
  }
  return out;
}
