import { parseArgs, requirePositional } from '../lib/args.js';
import { readJsonInput } from '../lib/common.js';
import { PdppUsageError } from '../lib/errors.js';
import { attachReferenceQueryMetadata, fetchJson, ownerSessionHeaders } from '../lib/fetch.js';
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
    // The reference revoke endpoint requires an owner bearer or the grant's
    // own client bearer. See
    // openspec/changes/harden-reference-auth-surfaces/specs/
    //   reference-implementation-architecture/spec.md
    const token = flags.token || process.env.PDPP_CLIENT_TOKEN || process.env.PDPP_OWNER_TOKEN;
    if (!token) {
      throw new PdppUsageError(
        'Missing required token. Use --token, PDPP_OWNER_TOKEN, or PDPP_CLIENT_TOKEN. ' +
        'Owner bearer revokes any grant; a client bearer only revokes the grant it is bound to.'
      );
    }
    const { body, headers } = await fetchJson(`${asUrl}/grants/${encodeURIComponent(grantId)}/revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    const format = resolveFormat(flags, 'json', 'json');
    writeData(format === 'json' ? attachReferenceQueryMetadata(body, headers) : body, format);
    return;
  }

  if (subcommand === 'timeline') {
    const { body } = await fetchJson(`${asUrl}/_ref/grants/${encodeURIComponent(grantId)}/timeline`, {
      headers: { ...ownerSessionHeaders() },
    });
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
