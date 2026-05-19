import {
  createPdppCliCommand,
  getPdppCliPackageInfo,
  PDPP_CLI_BIN_NAME,
} from './package-info.js';
import { ConnectError, connectProvider, normalizeProviderUrl, readStoredCredential } from './connect/flow.js';
import { runCollector } from './collector/commands.js';
import { runRefRun } from './ref/commands/run.js';
import { runRefGrant } from './ref/commands/grant.js';
import { runRefTrace } from './ref/commands/trace.js';
import { runRefLogin } from './ref/commands/login.js';
import { PdppCliError, PdppUsageError } from './ref/errors.js';

const HELP = `PDPP CLI

Usage:
  ${PDPP_CLI_BIN_NAME} --help
  ${PDPP_CLI_BIN_NAME} package-info [--provider-url <url>]
  ${PDPP_CLI_BIN_NAME} connect <provider-url>
  ${PDPP_CLI_BIN_NAME} token <provider-url>

Agent access:
  ${createPdppCliCommand()}

Local collector (pair a host you control with a reference deployment):
  ${PDPP_CLI_BIN_NAME} collector advertise
  ${PDPP_CLI_BIN_NAME} collector enroll --base-url <url> --code <code>
  ${PDPP_CLI_BIN_NAME} collector run    --base-url <url> --connector <id> ...

Reference diagnostics (reference server only):
  ${PDPP_CLI_BIN_NAME} ref login <reference-url>
  ${PDPP_CLI_BIN_NAME} ref run timeline <run-id> --as-url <url>
  ${PDPP_CLI_BIN_NAME} ref grant timeline <grant-id> --as-url <url>
  ${PDPP_CLI_BIN_NAME} ref trace show <trace-id> --as-url <url>

Notes:
  Do not ask users for owner bearer tokens for routine delegated access.
  "pdpp collector" is a thin @pdpp/cli shim. Install @pdpp/local-collector
  once, or use "npx -y @pdpp/local-collector ..." directly, for filesystem
  collectors like Claude Code and Codex.
  "pdpp ref" commands require a running PDPP reference server and an owner session.
  "pdpp ref login" caches an owner session in project-local .pdpp/ with mode 0600;
  later "pdpp ref" commands use the cache when --owner-session and
  PDPP_OWNER_SESSION_COOKIE are absent.
`;

export async function runCli(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  const [command, ...rest] = argv;

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    io.stdout.write(`${HELP}\n`);
    return 0;
  }

  if (command === 'package-info') {
    const providerUrl = readOption(rest, '--provider-url');
    io.stdout.write(`${JSON.stringify(getPdppCliPackageInfo(providerUrl), null, 2)}\n`);
    return 0;
  }

  if (command === 'connect') {
    const providerUrl = rest[0];
    if (!providerUrl) {
      io.stderr.write('Usage: pdpp connect <provider-url>\n');
      return 64;
    }

    try {
      await connectProvider(providerUrl, { io });
      return 0;
    } catch (error) {
      if (error instanceof ConnectError) {
        io.stderr.write(`${error.message}\n`);
        return error.exitCode;
      }
      throw error;
    }
  }

  if (command === 'token') {
    const providerUrl = readFirstPositional(rest);
    if (!providerUrl) {
      io.stderr.write('Usage: pdpp token <provider-url>\n');
      return 64;
    }

    try {
      const { credential } = await readStoredCredential(providerUrl, {
        cacheRoot: readOption(rest, '--cache-root'),
      });
      io.stdout.write(`${credential.access_token}\n`);
      return 0;
    } catch (error) {
      if (error instanceof ConnectError) {
        io.stderr.write(`${error.message}\n`);
        return error.exitCode;
      }
      throw error;
    }
  }

  if (command === 'collector') {
    return await runCollector(rest, io);
  }

  if (command === 'ref') {
    const [refCommand, ...refRest] = rest;

    if (!refCommand || refCommand === '--help' || refCommand === '-h') {
      io.stdout.write(`Reference diagnostics (reference server only):\n`);
      io.stdout.write(`  ${PDPP_CLI_BIN_NAME} ref login <reference-url> [--password-stdin] [--cache-root <dir>]\n`);
      io.stdout.write(`  ${PDPP_CLI_BIN_NAME} ref run timeline <run-id> --as-url <url> [--owner-session <cookie>] [--format json|table]\n`);
      io.stdout.write(`  ${PDPP_CLI_BIN_NAME} ref grant timeline <grant-id> --as-url <url> [--owner-session <cookie>] [--format json|table]\n`);
      io.stdout.write(`  ${PDPP_CLI_BIN_NAME} ref trace show <trace-id> --as-url <url> [--owner-session <cookie>] [--format json|table]\n`);
      io.stdout.write(`\nNotes:\n`);
      io.stdout.write(`  "ref login" prompts the reference server's owner-login route and caches the\n`);
      io.stdout.write(`  resulting session in .pdpp/owner-sessions/ (mode 0600). The cookie value is\n`);
      io.stdout.write(`  never printed. The password must come from --password-stdin or\n`);
      io.stdout.write(`  PDPP_OWNER_PASSWORD; it is not accepted on the command line.\n`);
      return 0;
    }

    const refDispatch = { login: runRefLogin, run: runRefRun, grant: runRefGrant, trace: runRefTrace };
    const handler = refDispatch[refCommand];
    if (!handler) {
      io.stderr.write(`Unknown ref command: ${refCommand}\n`);
      return 64;
    }

    try {
      return await handler(refRest, io);
    } catch (error) {
      if (error instanceof PdppUsageError) {
        io.stderr.write(`${error.message}\n`);
        return error.exitCode;
      }
      if (error instanceof PdppCliError) {
        io.stderr.write(`${error.message}\n`);
        return error.exitCode;
      }
      throw error;
    }
  }

  io.stderr.write(`Unknown command: ${command}\n\n${HELP}\n`);
  return 64;
}

function readOption(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }

  return argv[index + 1];
}

function readFirstPositional(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value.startsWith('--')) {
      index += 1;
      continue;
    }
    return value;
  }
  return undefined;
}

export { connectProvider, normalizeProviderUrl, readStoredCredential };
