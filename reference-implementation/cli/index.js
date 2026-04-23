#!/usr/bin/env node

import { PdppCliError, PdppUsageError } from './lib/errors.js';
import { runAuth } from './commands/auth.js';
import { runGrant } from './commands/grant.js';
import { runInspect } from './commands/inspect.js';
import { runOwner } from './commands/owner.js';
import { runProvider } from './commands/provider.js';
import { runQuery } from './commands/query.js';
import { runRun } from './commands/run.js';
import { runSeed } from './commands/seed.js';
import { runTrace } from './commands/trace.js';

const HELP = `PDPP CLI (reference implementation surface; some commands are reference-only)

Usage:
  pdpp auth login [--client-id <id>] [--as-url <url> | --rs-url <url>] [--timeout-seconds <n>] [--format json]
  pdpp auth introspect --token <token> [--as-url <url> | --rs-url <url>] [--format json|table]
  pdpp provider show --rs-url <url> [--as-url <url>] [--format json|table]
  pdpp provider register <path-or-> --rs-url <url> [--as-url <url>] --initial-access-token <token> [--format json]
  pdpp owner streams [--connector-id <id>] [--rs-url <url>] [--token <token>] [--format json|table]
  pdpp owner query <stream> [--connector-id <id>] [--rs-url <url>] [--token <token>] [--format json]
  pdpp owner get <stream> <record-id> [--connector-id <id>] [--rs-url <url>] [--token <token>]
  pdpp owner export <stream> [--connector-id <id>] [--rs-url <url>] [--token <token>] [--format jsonl]
  pdpp query streams [--rs-url <url>] [--token <token>] [--format json|table]
  pdpp query records <stream> [--rs-url <url>] [--token <token>] [--format json]
  pdpp query get <stream> <record-id> [--rs-url <url>] [--token <token>]
  pdpp run timeline <run-id> [--as-url <url> | --rs-url <url>] [--format json|table]
  pdpp grant start <path-or-> [--as-url <url> | --rs-url <url>] [--format json|table]
  pdpp grant revoke <grant-id> [--as-url <url> | --rs-url <url>]
  pdpp grant timeline <grant-id> [--as-url <url> | --rs-url <url>] [--format json|table]
  pdpp trace show <trace-id> [--as-url <url> | --rs-url <url>] [--format json|table]
  pdpp inspect <grant|request|manifest> <path-or-> [--format json|table]
  pdpp seed [--connector <name[,name...]>] [--as-url <url>] [--rs-url <url>] [--subject <id>]
    Seeds the running reference server with deterministic fixture data for local
    development. Defaults to spotify, github, reddit. Requires open local-dev owner
    auth (no PDPP_OWNER_PASSWORD).

Notes:
  --connector-id is only for polyfill/personal-server owner access. Native-provider owner access is provider-local.
`;

const COMMANDS = {
  auth: runAuth,
  grant: runGrant,
  inspect: runInspect,
  owner: runOwner,
  provider: runProvider,
  query: runQuery,
  run: runRun,
  seed: runSeed,
  trace: runTrace,
};

async function main() {
  const argv = process.argv.slice(2);
  const [group, ...rest] = argv;

  if (!group || group === 'help' || group === '--help' || group === '-h') {
    process.stdout.write(`${HELP}\n`);
    return;
  }

  const handler = COMMANDS[group];
  if (!handler) {
    throw new PdppUsageError(`Unknown command group: ${group}\n\n${HELP}`);
  }

  await handler(rest);
}

main().catch((error) => {
  if (error instanceof PdppCliError) {
    process.stderr.write(`${error.message}\n`);
    if (error.details?.request_id) {
      process.stderr.write(`Request ID: ${error.details.request_id}\n`);
    }
    if (error.details?.reference_trace_id) {
      process.stderr.write(`Reference trace ID: ${error.details.reference_trace_id}\n`);
    }
    if (error.details && process.env.PDPP_DEBUG) {
      process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
    }
    process.exit(error.exitCode);
  }

  process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
  process.exit(1);
});
