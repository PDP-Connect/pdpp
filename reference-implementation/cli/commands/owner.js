// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { parseArgs, requirePositional } from '../lib/args.js';
import { appendQuery, resolveOwnerToken, resolveRsUrl } from '../lib/common.js';
import { PdppUsageError } from '../lib/errors.js';
import { attachReferenceQueryMetadata, bearer, fetchJson } from '../lib/fetch.js';
import { resolveFormat, writeData } from '../lib/output.js';

export async function runOwner(argv) {
  const [subcommand, ...rest] = argv;
  const { flags, positionals } = parseArgs(rest);
  const rsUrl = resolveRsUrl(flags);
  const token = resolveOwnerToken(flags);
  if (!token) {
    throw new PdppUsageError('Missing owner token. Use --token or PDPP_OWNER_TOKEN.');
  }

  if (subcommand === 'streams') {
    const connectorId = flags['connector-id'];
    const url = appendQuery(`${rsUrl}/v1/streams`, { connector_id: connectorId });
    const { body, headers } = await fetchJson(url, { headers: bearer(token) });
    const format = resolveFormat(flags, 'table', 'json');
    writeData(format === 'json' ? attachReferenceQueryMetadata(body, headers) : (body.data || []), format);
    return;
  }

  if (subcommand === 'query' || subcommand === 'records') {
    const stream = requirePositional(positionals, 0, 'stream');
    const connectorId = flags['connector-id'];
    const url = appendQuery(`${rsUrl}/v1/streams/${encodeURIComponent(stream)}/records`, {
      connector_id: connectorId,
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
    const connectorId = flags['connector-id'];
    const url = appendQuery(`${rsUrl}/v1/streams/${encodeURIComponent(stream)}/records/${encodeURIComponent(recordId)}`, {
      connector_id: connectorId,
    });
    const { body, headers } = await fetchJson(url, { headers: bearer(token) });
    writeData(attachReferenceQueryMetadata(body, headers), resolveFormat(flags, 'json', 'json'));
    return;
  }

  if (subcommand === 'export') {
    const stream = requirePositional(positionals, 0, 'stream');
    const connectorId = flags['connector-id'];

    let cursor = flags.cursor;
    const records = [];
    do {
      const url = appendQuery(`${rsUrl}/v1/streams/${encodeURIComponent(stream)}/records`, {
        connector_id: connectorId,
        limit: flags.limit,
        cursor,
      });
      const { body } = await fetchJson(url, { headers: bearer(token) });
      records.push(...(body.data || []));
      cursor = body.next_cursor || null;
      if (flags.limit) break;
    } while (cursor);

    writeData(records, resolveFormat(flags, 'jsonl', 'jsonl'));
    return;
  }

  throw new PdppUsageError(
    'Usage: pdpp owner <streams|query|records|get|export> ... [--rs-url <url>] [--token <token>] [--connector-id <id>]\n' +
    '--connector-id is only for personal-server/polyfill owner access. Native-provider owner access is provider-local and omits it.'
  );
}
