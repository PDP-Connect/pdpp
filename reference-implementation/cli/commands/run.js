// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { parseArgs, requirePositional } from '../lib/args.js';
import { PdppUsageError } from '../lib/errors.js';
import { fetchJson, ownerSessionHeaders } from '../lib/fetch.js';
import { resolveFormat, writeData } from '../lib/output.js';
import { resolveReferenceAsUrl } from '../lib/reference.js';

export async function runRun(argv) {
  const [subcommand, ...rest] = argv;
  const { flags, positionals } = parseArgs(rest);
  const asUrl = await resolveReferenceAsUrl(flags);

  if (subcommand === 'timeline') {
    const runId = requirePositional(positionals, 0, 'run-id');
    const { body } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(runId)}/timeline`, {
      headers: { ...ownerSessionHeaders() },
    });
    const format = resolveFormat(flags, 'table', 'json');
    writeData(format === 'table' ? (body.data || []) : body, format);
    return;
  }

  throw new PdppUsageError(
    'Usage: pdpp run timeline <run-id> [--as-url <url> | --rs-url <url>] [--format json|table]'
  );
}
