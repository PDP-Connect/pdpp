export function resolveFormat(flags, defaultWhenTty = 'json', defaultWhenPipe = 'json') {
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
export function extractEnvelopeWarnings(body) {
  if (!body || typeof body !== 'object') {
    return [];
  }
  const meta = body.meta;
  if (!meta || typeof meta !== 'object') {
    return [];
  }
  const warnings = Array.isArray(meta.warnings) ? meta.warnings : [];
  return warnings.filter((w) => w && typeof w === 'object' && typeof w.code === 'string');
}

/**
 * Write canonical `meta.warnings` to stderr in a human-readable form.
 * Stays on stderr so machine-readable stdout (JSON, JSONL, table) is not
 * polluted; operators piping to jq/grep keep their parseable output and
 * still see the warning.
 */
export function writeEnvelopeWarnings(body, err = process.stderr) {
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
    err.write(`${parts.join(' — ')}\n`);
  }
}

export function writeData(data, format = 'json', out = process.stdout) {
  if (format === 'json') {
    out.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }

  if (format === 'jsonl') {
    if (!Array.isArray(data)) {
      out.write(`${JSON.stringify(data)}\n`);
      return;
    }
    for (const item of data) {
      out.write(`${JSON.stringify(item)}\n`);
    }
    return;
  }

  if (format === 'table') {
    writeTable(data, out);
    return;
  }

  throw new Error(`Unsupported format: ${format}`);
}

function writeTable(data, out = process.stdout) {
  const rows = Array.isArray(data) ? data : [data];
  if (!rows.length) {
    out.write('(empty)\n');
    return;
  }

  const normalized = rows.map((row) => flattenRow(row));
  const columns = Array.from(
    normalized.reduce((acc, row) => {
      Object.keys(row).forEach((key) => acc.add(key));
      return acc;
    }, new Set())
  );

  const widths = Object.fromEntries(
    columns.map((column) => [
      column,
      Math.max(column.length, ...normalized.map((row) => String(row[column] ?? '').length)),
    ])
  );

  const renderRow = (row) =>
    columns
      .map((column) => String(row[column] ?? '').padEnd(widths[column]))
      .join('  ');

  out.write(`${renderRow(Object.fromEntries(columns.map((column) => [column, column])))}\n`);
  out.write(`${columns.map((column) => '-'.repeat(widths[column])).join('  ')}\n`);
  for (const row of normalized) {
    out.write(`${renderRow(row)}\n`);
  }
}

function flattenRow(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (Array.isArray(value)) {
      out[key] = value.join(', ');
    } else if (value && typeof value === 'object') {
      out[key] = JSON.stringify(value);
    } else {
      out[key] = value ?? '';
    }
  }
  return out;
}
