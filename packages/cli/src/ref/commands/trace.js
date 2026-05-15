import { parseArgs, requirePositional } from '../args.js';
import { PdppUsageError } from '../errors.js';
import { fetchJson, ownerSessionHeaders, resolveReferenceUrl } from '../fetch.js';
import { resolveFormat, writeData } from '../output.js';

export async function runRefTrace(argv, io = {}, fetchImpl = globalThis.fetch) {
  const [subcommand, ...rest] = argv;
  const { flags, positionals } = parseArgs(rest);
  const out = io.stdout || process.stdout;

  if (subcommand === 'show') {
    const traceId = requirePositional(positionals, 0, 'trace-id');
    const asUrl = resolveReferenceUrl(flags);
    const ownerSession = flags['owner-session'] || '';
    const cacheRoot = flags['cache-root'];
    const { body } = await fetchJson(
      `${asUrl}/_ref/traces/${encodeURIComponent(traceId)}`,
      { headers: { ...ownerSessionHeaders({ ownerSession, referenceUrl: asUrl, cacheRoot }) } },
      fetchImpl
    );
    const format = resolveFormat(flags, 'table', 'json');
    writeData(format === 'table' ? (body.data || []) : body, format, out);
    return 0;
  }

  throw new PdppUsageError(
    'Usage: pdpp ref trace show <trace-id> [--as-url <url>] [--owner-session <cookie>] [--format json|table]'
  );
}
