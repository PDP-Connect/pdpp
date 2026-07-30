// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { runCollector } from "./collector/commands.ts";
// biome-ignore lint/style/noExportedImports: index.ts is @pdpp/cli's public entry point; connectProvider/normalizeProviderUrl/readStoredCredential are re-exported by design for library consumers, matching the reference-contract package's index.ts precedent.
import { ConnectError, connectProvider, normalizeProviderUrl, readStoredCredential } from "./connect/flow.ts";
import { runOwnerAgent } from "./owner-agent/command.ts";
import { createPdppCliCommand, getPdppCliPackageInfo, PDPP_CLI_BIN_NAME } from "./package-info.ts";
import { readHelp, runRead } from "./read/commands.ts";
import type { CommandIo } from "./ref/commands/call.ts";
import { runRefCall } from "./ref/commands/call.ts";
import { runRefConnectors } from "./ref/commands/connectors.ts";
import { runRefEventSubscriptions } from "./ref/commands/event-subscriptions.ts";
import { runRefGrant } from "./ref/commands/grant.ts";
import { runRefLogin } from "./ref/commands/login.ts";
import { runRefRun } from "./ref/commands/run.ts";
import { runRefTrace } from "./ref/commands/trace.ts";
import { PdppCliError, PdppUsageError } from "./ref/errors.ts";

const HELP = `PDPP CLI

Usage:
  ${PDPP_CLI_BIN_NAME} --help
  ${PDPP_CLI_BIN_NAME} package-info [--provider-url <url>]
  ${PDPP_CLI_BIN_NAME} connect <provider-url>
  ${PDPP_CLI_BIN_NAME} token <provider-url>

${readHelp(PDPP_CLI_BIN_NAME)}

Agent access:
  ${createPdppCliCommand()}

Trusted owner agent (owner-level local automation, not the default agent path):
  ${PDPP_CLI_BIN_NAME} owner-agent onboard <entrypoint-url> [--credential-file <path>] [--client-id <id>] [--client-name <name>]
  ${PDPP_CLI_BIN_NAME} owner-agent status [--credential-file <path>] [--entrypoint <url>]
  ${PDPP_CLI_BIN_NAME} owner-agent control [--credential-file <path>] [--entrypoint <url>]
  ${PDPP_CLI_BIN_NAME} owner-agent revoke [--credential-file <path>] [--entrypoint <url>] [--cache-root <dir>] [--owner-session <cookie>]

Local collector (pair a host you control with a reference deployment):
  ${PDPP_CLI_BIN_NAME} collector advertise
  ${PDPP_CLI_BIN_NAME} collector enroll --base-url <url> --code <code>
  ${PDPP_CLI_BIN_NAME} collector run    --base-url <url> --connector <id> ...

Reference diagnostics (reference server only):
  ${PDPP_CLI_BIN_NAME} ref login <reference-url>
  ${PDPP_CLI_BIN_NAME} ref call <method> <path> --as-url <url> [--data <json> | --data-stdin]
  ${PDPP_CLI_BIN_NAME} ref run timeline <run-id> --as-url <url>
  ${PDPP_CLI_BIN_NAME} ref grant timeline <grant-id> --as-url <url>
  ${PDPP_CLI_BIN_NAME} ref trace show <trace-id> --as-url <url>
  ${PDPP_CLI_BIN_NAME} ref connectors list --as-url <url>
  ${PDPP_CLI_BIN_NAME} ref connectors show <connector-id> --as-url <url>
  ${PDPP_CLI_BIN_NAME} ref event-subscriptions list --as-url <url> [--client-id <id>] [--grant-id <id>] [--status <status>]
  ${PDPP_CLI_BIN_NAME} ref event-subscriptions show <subscription-id> --as-url <url>
  ${PDPP_CLI_BIN_NAME} ref event-subscriptions disable <subscription-id> --as-url <url> [--reason <text>] [--yes]

Notes:
  Do not ask users for owner bearer tokens for routine delegated access.
  "pdpp collector" is a thin @pdpp/cli shim. Install @pdpp/local-collector
  once, or use "npx -y @pdpp/local-collector ..." directly, for filesystem
  collectors like Claude Code and Codex.
  "pdpp ref" commands require a running PDPP reference server and an owner session.
  "pdpp ref login" caches an owner session in project-local .pdpp/ with mode 0600;
  later "pdpp ref" commands use the cache when --owner-session and
  PDPP_OWNER_SESSION_COOKIE are absent.
  "pdpp ref call" is the escape hatch for owner POST/GET routes without a typed
  command. It infers auth from the path: /_ref/* uses the owner session cookie,
  /v1/owner/* uses the owner bearer (PDPP_OWNER_TOKEN or --owner-token-stdin).
  Bodies are sent as JSON (CSRF-exempt server-side), so no _csrf parsing is
  needed. Secrets are never printed.
`;

export interface RunCliIo {
  stderr: NodeJS.WritableStream;
  stdin?: NodeJS.ReadStream;
  stdout: NodeJS.WritableStream;
}

type RefCommandHandler = (argv: string[], io: CommandIo, fetchImpl?: typeof fetch) => Promise<number>;

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: command dispatcher with many top-level subcommands, splitting would scatter routing logic.
export async function runCli(
  argv: string[],
  io: RunCliIo = { stdout: process.stdout, stderr: process.stderr }
): Promise<number> {
  const [command, ...rest] = argv;

  if (!command || command === "--help" || command === "-h" || command === "help") {
    io.stdout.write(`${HELP}\n`);
    return 0;
  }

  if (command === "package-info") {
    const providerUrl = readOption(rest, "--provider-url");
    io.stdout.write(`${JSON.stringify(getPdppCliPackageInfo(providerUrl), null, 2)}\n`);
    return 0;
  }

  if (command === "connect") {
    const [providerUrl] = rest;
    if (!providerUrl) {
      io.stderr.write("Usage: pdpp connect <provider-url>\n");
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

  if (command === "token") {
    const providerUrl = readFirstPositional(rest);
    if (!providerUrl) {
      io.stderr.write("Usage: pdpp token <provider-url>\n");
      return 64;
    }

    try {
      const cacheRoot = readOption(rest, "--cache-root");
      const { credential } = await readStoredCredential(providerUrl, cacheRoot === undefined ? {} : { cacheRoot });
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

  if (command === "collector") {
    return await runCollector(rest, io);
  }

  if (command === "read") {
    try {
      return await runRead(rest, io);
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

  if (command === "owner-agent") {
    return await runOwnerAgent(rest, io);
  }

  if (command === "ref") {
    const [refCommand, ...refRest] = rest;

    if (!refCommand || refCommand === "--help" || refCommand === "-h") {
      io.stdout.write("Reference diagnostics (reference server only):\n");
      io.stdout.write(`  ${PDPP_CLI_BIN_NAME} ref login <reference-url> [--password-stdin] [--cache-root <dir>]\n`);
      io.stdout.write(
        `  ${PDPP_CLI_BIN_NAME} ref call <method> <path> --as-url <url> [--data <json> | --data-stdin] [--auth cookie|bearer] [--owner-session <cookie>] [--owner-token-stdin] [--status-only] [--format json|table]\n`
      );
      io.stdout.write(
        `  ${PDPP_CLI_BIN_NAME} ref run timeline <run-id> --as-url <url> [--owner-session <cookie>] [--format json|table]\n`
      );
      io.stdout.write(
        `  ${PDPP_CLI_BIN_NAME} ref grant timeline <grant-id> --as-url <url> [--owner-session <cookie>] [--format json|table]\n`
      );
      io.stdout.write(
        `  ${PDPP_CLI_BIN_NAME} ref trace show <trace-id> --as-url <url> [--owner-session <cookie>] [--format json|table]\n`
      );
      io.stdout.write(
        `  ${PDPP_CLI_BIN_NAME} ref connectors list --as-url <url> [--owner-session <cookie>] [--format json|table] [--verbose] [--limit <n>] [--cursor <opaque>] [--all]\n`
      );
      io.stdout.write(
        `  ${PDPP_CLI_BIN_NAME} ref connectors show <connector-id> --as-url <url> [--owner-session <cookie>] [--format json|table] [--verbose]\n`
      );
      io.stdout.write(
        `  ${PDPP_CLI_BIN_NAME} ref event-subscriptions list --as-url <url> [--client-id <id>] [--grant-id <id>] [--status <status>] [--owner-session <cookie>] [--format json|table]\n`
      );
      io.stdout.write(
        `  ${PDPP_CLI_BIN_NAME} ref event-subscriptions show <subscription-id> --as-url <url> [--owner-session <cookie>] [--format json|table]\n`
      );
      io.stdout.write(
        `  ${PDPP_CLI_BIN_NAME} ref event-subscriptions disable <subscription-id> --as-url <url> [--reason <text>] [--yes] [--owner-session <cookie>]\n`
      );
      io.stdout.write("\nNotes:\n");
      io.stdout.write('  "ref login" prompts the reference server\'s owner-login route and caches the\n');
      io.stdout.write("  resulting session in .pdpp/owner-sessions/ (mode 0600). The cookie value is\n");
      io.stdout.write("  never printed. The password must come from --password-stdin or\n");
      io.stdout.write("  PDPP_OWNER_PASSWORD; it is not accepted on the command line.\n");
      io.stdout.write('  "ref call" infers auth from the path: /_ref/* uses the owner session cookie,\n');
      io.stdout.write("  /v1/owner/* uses the owner bearer (PDPP_OWNER_TOKEN or --owner-token-stdin).\n");
      io.stdout.write("  It refuses a mismatched --auth, sends bodies as JSON (so no _csrf is needed),\n");
      io.stdout.write("  and never prints the cookie or bearer.\n");
      return 0;
    }

    const refDispatch: Record<string, RefCommandHandler> = {
      login: runRefLogin,
      call: runRefCall,
      run: runRefRun,
      grant: runRefGrant,
      trace: runRefTrace,
      connectors: runRefConnectors,
      "event-subscriptions": runRefEventSubscriptions,
    };
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

function readOption(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) {
    return;
  }

  return argv[index + 1];
}

function readFirstPositional(argv: string[]): string | undefined {
  let positional: string | undefined;
  // biome-ignore lint/style/useForOf: index is advanced by 2 when skipping a flag+value pair; not expressible as for...of.
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === undefined) {
      break;
    }
    if (value.startsWith("--")) {
      index += 1;
      continue;
    }
    positional = value;
    break;
  }
  return positional;
}

export { connectProvider, normalizeProviderUrl, readStoredCredential };
