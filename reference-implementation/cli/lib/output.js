export function resolveFormat(flags, defaultWhenTty = 'json', defaultWhenPipe = 'json') {
  return flags.format || (process.stdout.isTTY ? defaultWhenTty : defaultWhenPipe);
}

export function writeData(data, format = 'json') {
  if (format === 'json') {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }

  if (format === 'jsonl') {
    if (!Array.isArray(data)) {
      process.stdout.write(`${JSON.stringify(data)}\n`);
      return;
    }
    for (const item of data) {
      process.stdout.write(`${JSON.stringify(item)}\n`);
    }
    return;
  }

  if (format === 'table') {
    writeTable(data);
    return;
  }

  throw new Error(`Unsupported format: ${format}`);
}

function writeTable(data) {
  const rows = Array.isArray(data) ? data : [data];
  if (!rows.length) {
    process.stdout.write('(empty)\n');
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

  process.stdout.write(`${renderRow(Object.fromEntries(columns.map((column) => [column, column])))}\n`);
  process.stdout.write(`${columns.map((column) => '-'.repeat(widths[column])).join('  ')}\n`);
  for (const row of normalized) {
    process.stdout.write(`${renderRow(row)}\n`);
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
