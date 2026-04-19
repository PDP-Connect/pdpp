import { parseArgs, requirePositional } from '../lib/args.js';
import { readJsonInput } from '../lib/common.js';
import { PdppUsageError } from '../lib/errors.js';
import { attachReferenceQueryMetadata, fetchJson } from '../lib/fetch.js';
import { resolveFormat, writeData } from '../lib/output.js';
import { resolveReferenceAsUrl } from '../lib/reference.js';

export async function runGrant(argv) {
  const [subcommand, ...rest] = argv;
  const { flags, positionals } = parseArgs(rest);
  const asUrl = await resolveReferenceAsUrl(flags);

  if (subcommand === 'start') {
    const source = requirePositional(positionals, 0, 'path-or--');
    const request = readJsonInput(source);
    const { body, headers } = await fetchJson(`${asUrl}/oauth/par`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    const format = resolveFormat(flags, 'json', 'json');
    writeData(format === 'json' ? attachReferenceQueryMetadata(body, headers) : body, format);
    return;
  }

  const grantId = requirePositional(positionals, 0, 'grant-id');

  if (subcommand === 'revoke') {
    const { body, headers } = await fetchJson(`${asUrl}/grants/${encodeURIComponent(grantId)}/revoke`, {
      method: 'POST',
    });
    const format = resolveFormat(flags, 'json', 'json');
    writeData(format === 'json' ? attachReferenceQueryMetadata(body, headers) : body, format);
    return;
  }

  if (subcommand === 'timeline') {
    const { body } = await fetchJson(`${asUrl}/_ref/grants/${encodeURIComponent(grantId)}/timeline`);
    const format = resolveFormat(flags, 'table', 'json');
    writeData(format === 'table' ? (body.data || []) : body, format);
    return;
  }

  throw new PdppUsageError(
    'Usage: pdpp grant <start|revoke|timeline> ...\n' +
    '  start <path-or-> [--as-url <url> | --rs-url <url>] [--format json|table]\n' +
    '  revoke <grant-id> [--as-url <url> | --rs-url <url>] [--format json|table]\n' +
    '  timeline <grant-id> [--as-url <url> | --rs-url <url>] [--format json|table]'
  );
}
