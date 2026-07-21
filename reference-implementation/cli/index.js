#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PdppCliError, PdppUsageError } from './lib/errors.js';
import { runCli as runPublicCli } from '../../packages/cli/src/index.js';
import { createPdppCliCommand, PDPP_CLI_BIN_NAME, PDPP_CLI_PACKAGE_NAME } from '../../packages/cli/src/package-info.js';
import { runAgent } from './commands/agent.js';
import { runAuth } from './commands/auth.js';
import { runGrant } from './commands/grant.js';
import { runInspect } from './commands/inspect.js';
import { runOwner } from './commands/owner.js';
import { runProvider } from './commands/provider.js';
import { runQuery } from './commands/query.js';
import { runRun } from './commands/run.js';
import { runSeed } from './commands/seed.js';
import { runTrace } from './commands/trace.js';

const HELP = `PDPP CLI (reference implementation surface; reference-only commands are marked)

Public CLI package:
  package: ${PDPP_CLI_PACKAGE_NAME}
  command: ${createPdppCliCommand()}

Public commands delegated to ${PDPP_CLI_PACKAGE_NAME}:
  ${PDPP_CLI_BIN_NAME} --help
  ${PDPP_CLI_BIN_NAME} package-info [--provider-url <url>]
  ${PDPP_CLI_BIN_NAME} connect <provider-url>  (gated)
  ${PDPP_CLI_BIN_NAME} collector <advertise|enroll|run> ...  (run connectors from a host you control)
  ${PDPP_CLI_BIN_NAME} ref connectors list --as-url <url> [--format json|table] [--verbose]
  ${PDPP_CLI_BIN_NAME} ref connectors show <connector-id> --as-url <url> [--format json|table] [--verbose]

Agent access (project-local grant management for coding agents):
  pdpp agent bootstrap [--rs-url <url>] [--as-url <url>] [--initial-access-token <tok>]  (reference-only)
  pdpp agent status [--format json|table]  (reference-only)
  pdpp agent request --source-kind <kind> --source-id <id> --streams <s1,s2> --purpose <text> [--access-mode <mode>]  (reference-only)
  pdpp agent store --grant-id <id> --token <token>  (reference-only)
  pdpp agent use [<grant-id>]  (reference-only)
  pdpp agent forget <grant-id>  (reference-only)
  pdpp agent revoke <grant-id>  (reference-only)

Standard CLI (reference implementation surface; some commands are reference-only)

Usage:
  pdpp auth login [--client-id <id>] [--as-url <url> | --rs-url <url>] [--timeout-seconds <n>] [--format json]
  pdpp auth introspect --token <token> [--as-url <url> | --rs-url <url>] [--format json|table]
  pdpp provider show --rs-url <url> [--as-url <url>] [--format json|table]
  pdpp provider register <path-or-> --rs-url <url> [--as-url <url>] [--initial-access-token <token>] [--format json]
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
  agent: runAgent,
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

const PUBLIC_DELEGATED_COMMANDS = new Set(['package-info', 'connect', 'token', 'ref', 'collector']);

// Legacy top-level operator aliases that the canonical `pdpp ref ...`
// surface now replaces. They still route through the existing repo-local
// handler so flags like `--rs-url` keep working for scripts, but we emit a
// one-line deprecation hint pointing at the canonical command. Dashboard,
// docs, and `@pdpp/cli` help MUST NOT advertise these aliases.
const LEGACY_ALIAS_HINTS = new Map([
  ['run timeline', 'pdpp ref run timeline'],
  ['grant timeline', 'pdpp ref grant timeline'],
  ['trace show', 'pdpp ref trace show'],
]);

export function legacyAliasHint(group, sub) {
  if (typeof group !== 'string') return null;
  const key = sub ? `${group} ${sub}` : group;
  return LEGACY_ALIAS_HINTS.get(key) || null;
}

async function main() {
  const argv = process.argv.slice(2);
  const [group, ...rest] = argv;

  if (!group || group === 'help' || group === '--help' || group === '-h') {
    process.stdout.write(`${HELP}\n`);
    return;
  }

  // Delegate the public CLI command surface (including the entire `ref ...`
  // namespace) to @pdpp/cli. This is the single canonical entry point for
  // public commands; the wrapper does not re-implement any of them.
  if (PUBLIC_DELEGATED_COMMANDS.has(group)) {
    const exitCode = await runPublicCli(argv, { stdout: process.stdout, stderr: process.stderr });
    process.exitCode = exitCode;
    return;
  }

  // Legacy operator aliases: emit a deprecation hint, then run the existing
  // repo-local handler so `--rs-url` and other historical flags keep working.
  const canonical = legacyAliasHint(group, rest[0]);
  if (canonical) {
    process.stderr.write(
      `warning: "pdpp ${group} ${rest[0]}" is deprecated; use "${canonical}" instead.\n`,
    );
  }

  const handler = COMMANDS[group];
  if (!handler) {
    throw new PdppUsageError(`Unknown command group: ${group}\n\n${HELP}`);
  }

  await handler(rest);
}

export const __test = { LEGACY_ALIAS_HINTS, PUBLIC_DELEGATED_COMMANDS, isCliEntryPoint, legacyAliasHint };

function isCliEntryPoint(invoked = process.argv[1], moduleUrl = import.meta.url) {
  try {
    if (!invoked) return false;
    return realpathSync(invoked) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isCliEntryPoint()) {
  main().catch(handleError);
}

function handleError(error) {
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
}
