// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { parseArgs, requirePositional } from '../lib/args.js';
import { appendQuery, resolveClientToken, resolveRsUrl } from '../lib/common.js';
import { PdppUsageError } from '../lib/errors.js';
import { attachReferenceQueryMetadata, bearer, fetchJson } from '../lib/fetch.js';
import { resolveFormat, writeData } from '../lib/output.js';

export async function runQuery(argv) {
  const [subcommand, ...rest] = argv;
  const { flags, positionals } = parseArgs(rest);
  const rsUrl = resolveRsUrl(flags);
  const token = resolveClientToken(flags);
  if (!token) {
    throw new PdppUsageError('Missing client token. Use --token or PDPP_CLIENT_TOKEN.');
  }

  if (subcommand === 'streams') {
    const { body, headers } = await fetchJson(`${rsUrl}/v1/streams`, { headers: bearer(token) });
    const format = resolveFormat(flags, 'table', 'json');
    writeData(format === 'json' ? attachReferenceQueryMetadata(body, headers) : (body.data || []), format);
    return;
  }

  if (subcommand === 'records') {
    const stream = requirePositional(positionals, 0, 'stream');
    const url = appendQuery(`${rsUrl}/v1/streams/${encodeURIComponent(stream)}/records`, {
      limit: flags.limit,
      cursor: flags.cursor,
      changes_since: flags['changes-since'],
      view: flags.view,
      fields: flags.fields,
    });
    const { body, headers } = await fetchJson(url, { headers: bearer(token) });
    writeData(attachReferenceQueryMetadata(body, headers), resolveFormat(flags, 'json', 'json'));
    return;
  }

  if (subcommand === 'get') {
    const stream = requirePositional(positionals, 0, 'stream');
    const recordId = requirePositional(positionals, 1, 'record-id');
    const { body, headers } = await fetchJson(
      `${rsUrl}/v1/streams/${encodeURIComponent(stream)}/records/${encodeURIComponent(recordId)}`,
      { headers: bearer(token) }
    );
    writeData(attachReferenceQueryMetadata(body, headers), resolveFormat(flags, 'json', 'json'));
    return;
  }

  throw new PdppUsageError('Usage: pdpp query <streams|records|get> ... [--rs-url <url>] [--token <token>]');
}
