// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { CredentialError, loadScopedCredential } from "./credentials.ts";
import { DEFAULT_SERVER_NAME, DEFAULT_SERVER_VERSION, type StdioServerHandle, startStdioServer } from "./server.ts";

const HELP = `pdpp-mcp-server — local stdio MCP adapter over a PDPP resource server

Usage:
  pdpp-mcp-server --provider-url <url> [--cache-root <dir>] [--server-name <name>]

Environment:
  PDPP_PROVIDER_URL      Default for --provider-url
  PDPP_CACHE_ROOT        Default for --cache-root (defaults to .pdpp)
  PDPP_MCP_SERVER_NAME   Default for --server-name

The adapter uses a grant-scoped client token for the profile-free normal PDPP read
surface. It refuses owner credentials and exits non-zero if no scoped grant token is
cached for the provider. Run \`pdpp connect <provider-url>\` first.

stdout is reserved for MCP protocol messages. Diagnostics go to stderr.
`;

interface WritableStream {
  write: (chunk: string) => unknown;
}

// `startStdioServer` is injectable for tests, which may stub it with a
// handle-less double (a bare `async () => {}`). Widen the dependency's return
// type to match that real substitutability rather than the stricter
// `StdioServerHandle` the production implementation always returns.
type StartStdioServerDep = (
  options: Parameters<typeof startStdioServer>[0]
) => Promise<Partial<StdioServerHandle> | undefined>;

interface RunMcpServerCliDeps {
  env?: Record<string, string | undefined>;
  loadScopedCredential?: typeof loadScopedCredential;
  startStdioServer?: StartStdioServerDep;
  stderr?: WritableStream;
}

/**
 * Entry point used by both the published bin and tests.
 *
 * Resolves config from argv/env, loads the cached scoped client token, refuses owner
 * credentials, and starts the stdio server. Returns the process exit code; callers are
 * responsible for invoking process.exit().
 */
export async function runMcpServerCli(argv: string[], deps: RunMcpServerCliDeps = {}): Promise<number> {
  const stderr = deps.stderr ?? process.stderr;
  const env = deps.env ?? process.env;
  const load = deps.loadScopedCredential ?? loadScopedCredential;
  const start = deps.startStdioServer ?? startStdioServer;

  if (argv.includes("--help") || argv.includes("-h")) {
    stderr.write(HELP);
    return 0;
  }
  if (argv.includes("--version")) {
    stderr.write(`${DEFAULT_SERVER_VERSION}\n`);
    return 0;
  }

  let options: { providerUrl: string; cacheRoot: string; serverName: string };
  try {
    options = parseOptions(argv, env);
  } catch (error) {
    const parseError = error as { message: string; exitCode?: number };
    stderr.write(`pdpp-mcp-server: ${parseError.message}\n`);
    stderr.write(HELP);
    return parseError.exitCode ?? 64;
  }

  let credential: Awaited<ReturnType<typeof loadScopedCredential>>;
  try {
    credential = await load(options.providerUrl, { cacheRoot: options.cacheRoot });
  } catch (error) {
    if (error instanceof CredentialError) {
      stderr.write(`pdpp-mcp-server: ${error.message}\n`);
      return error.exitCode;
    }
    const err = error as { stack?: string } | null;
    stderr.write(`pdpp-mcp-server: ${err?.stack ?? error}\n`);
    return 1;
  }

  stderr.write(
    `pdpp-mcp-server: connected to ${credential.providerUrl} using scoped credential at ${credential.cacheFile}\n`
  );

  let handle: Partial<StdioServerHandle> | undefined;
  try {
    handle = await start({
      providerUrl: credential.providerUrl,
      accessToken: credential.accessToken,
      serverName: options.serverName,
    });
  } catch (error) {
    const err = error as { stack?: string } | null;
    stderr.write(`pdpp-mcp-server: failed to start stdio server: ${err?.stack ?? error}\n`);
    return 1;
  }

  // Block until the transport signals close (e.g. parent harness closes our stdin).
  // Without this, the bin would exit immediately after wiring up the server and the
  // child process would terminate before any MCP request could be processed.
  if (handle && typeof handle.closed?.then === "function") {
    await handle.closed;
  }

  return 0;
}

export class OptionParseError extends Error {
  exitCode: number;

  constructor(message: string, exitCode = 64) {
    super(message);
    this.name = "OptionParseError";
    this.exitCode = exitCode;
  }
}

export function parseOptions(
  argv: string[],
  env: Record<string, string | undefined>
): { providerUrl: string; cacheRoot: string; serverName: string } {
  const providerUrl = readOption(argv, "--provider-url") ?? env.PDPP_PROVIDER_URL ?? "";
  const cacheRoot = readOption(argv, "--cache-root") ?? env.PDPP_CACHE_ROOT ?? ".pdpp";
  const serverName = readOption(argv, "--server-name") ?? env.PDPP_MCP_SERVER_NAME ?? DEFAULT_SERVER_NAME;

  if (!providerUrl) {
    throw new OptionParseError("Missing --provider-url (or PDPP_PROVIDER_URL).");
  }

  if (env.PDPP_OWNER_TOKEN || env.PDPP_OWNER_SESSION_COOKIE) {
    // Refuse to operate when an owner credential is in the environment even though
    // we never consult it. Exposing the owner-mode self-export surface through MCP
    // is the footgun the design forbids.
    throw new OptionParseError(
      "Refusing to start: owner credentials (PDPP_OWNER_TOKEN / PDPP_OWNER_SESSION_COOKIE) are present in the environment. Unset them before running the MCP adapter.",
      77
    );
  }

  return { providerUrl, cacheRoot, serverName };
}

function readOption(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) {
    return;
  }
  return argv[index + 1];
}

export { CredentialError, loadScopedCredential } from "./credentials.ts";
export { RsClient } from "./rs-client.ts";
export {
  createPdppMcpServer,
  DEFAULT_SERVER_NAME,
  DEFAULT_SERVER_VERSION,
  handleStreamableHttpRequest,
  PDPP_MCP_TOOL_NAMES,
  startStdioServer,
} from "./server.ts";
export { buildResourceTemplates, buildStreamResourceTemplate, buildTools, InvalidResourceUriError } from "./tools.ts";
