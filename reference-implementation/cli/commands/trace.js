import { parseArgs, requirePositional } from '../lib/args.js';
import { PdppUsageError } from '../lib/errors.js';
import { fetchJson } from '../lib/fetch.js';
import { resolveFormat, writeData } from '../lib/output.js';
import { resolveReferenceAsUrl } from '../lib/reference.js';

function writeTimeline(body, format) {
  if (format === 'table') {
    writeData(body.data || [], 'table');
    return;
  }
  writeData(body, format);
}

export async function runTrace(argv) {
  const [subcommand, ...rest] = argv;
  const { flags, positionals } = parseArgs(rest);
  const asUrl = await resolveReferenceAsUrl(flags);
  const format = resolveFormat(flags, 'table', 'json');

  if (subcommand === 'show') {
    const traceId = requirePositional(positionals, 0, 'trace-id');
    const { body } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(traceId)}`);
    writeTimeline(body, format);
    return;
  }


  throw new PdppUsageError(
    'Usage: pdpp trace show <trace-id> [--as-url <url> | --rs-url <url>] [--format json|table]'
  );
}
