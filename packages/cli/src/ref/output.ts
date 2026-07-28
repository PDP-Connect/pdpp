// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export interface EnvelopeWarning {
  code: string;
  dropped_parameter?: string;
  message?: string;
  [key: string]: unknown;
}

export function resolveFormat(flags: { format?: string }, defaultWhenTty = "json", defaultWhenPipe = "json"): string {
  return flags.format || (process.stdout.isTTY ? defaultWhenTty : defaultWhenPipe);
}

/**
 * Extract the canonical `meta.warnings` array from a public read response
 * body. Returns `[]` when the field is missing or malformed. The canonical
 * envelope (canonicalize-public-read-contract) puts non-fatal lossiness,
 * deprecated alias use, and count downgrades here; the CLI must surface
 * them so operators are not silently misled by a lossy read. Pre-canonical
 * responses have no `meta.warnings`, so this returns an empty array and
 * the renderer prints nothing.
 */
export function extractEnvelopeWarnings(body: unknown): EnvelopeWarning[] {
  if (!body || typeof body !== "object") {
    return [];
  }
  const { meta } = body as Record<string, unknown>;
  if (!meta || typeof meta !== "object") {
    return [];
  }
  const { warnings } = meta as Record<string, unknown>;
  const list = Array.isArray(warnings) ? warnings : [];
  return list.filter(
    (w): w is EnvelopeWarning =>
      // biome-ignore lint/suspicious/noEqualsToNull: != null intentionally catches both null and undefined; !== null would let undefined entries through.
      w != null && typeof w === "object" && typeof (w as EnvelopeWarning).code === "string"
  );
}

/**
 * Write canonical `meta.warnings` to stderr in a human-readable form.
 * Stays on stderr so machine-readable stdout (JSON, JSONL, table) is not
 * polluted; operators piping to jq/grep keep their parseable output and
 * still see the warning.
 */
export function writeEnvelopeWarnings(body: unknown, err: NodeJS.WritableStream = process.stderr): void {
  const warnings = extractEnvelopeWarnings(body);
  if (warnings.length === 0) {
    return;
  }
  for (const warning of warnings) {
    const parts = [`warning: ${warning.code}`];
    if (warning.message) {
      parts.push(warning.message);
    }
    if (warning.dropped_parameter) {
      parts.push(`(dropped: ${warning.dropped_parameter})`);
    }
    err.write(`${parts.join(" — ")}\n`);
  }
}

export function writeData(data: unknown, format = "json", out: NodeJS.WritableStream = process.stdout): void {
  if (format === "json") {
    out.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }

  if (format === "jsonl") {
    if (!Array.isArray(data)) {
      out.write(`${JSON.stringify(data)}\n`);
      return;
    }
    for (const item of data) {
      out.write(`${JSON.stringify(item)}\n`);
    }
    return;
  }

  if (format === "table") {
    writeTable(data, out);
    return;
  }

  throw new Error(`Unsupported format: ${format}`);
}

function writeTable(data: unknown, out: NodeJS.WritableStream = process.stdout): void {
  const rows: unknown[] = Array.isArray(data) ? data : [data];
  if (!rows.length) {
    out.write("(empty)\n");
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

  const renderRow = (row: Record<string, unknown>) =>
    columns.map((column) => String(row[column] ?? "").padEnd(widths[column] ?? column.length)).join("  ");

  out.write(`${renderRow(Object.fromEntries(columns.map((column) => [column, column])))}\n`);
  out.write(`${columns.map((column) => "-".repeat(widths[column] ?? column.length)).join("  ")}\n`);
  for (const row of normalized) {
    out.write(`${renderRow(row)}\n`);
  }
}

function flattenRow(row: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!row || typeof row !== "object") {
    return out;
  }
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      out[key] = value.join(", ");
    } else if (value && typeof value === "object") {
      out[key] = JSON.stringify(value);
    } else {
      out[key] = value ?? "";
    }
  }
  return out;
}
