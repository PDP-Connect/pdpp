// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { CredentialError, loadScopedCredential } from "./credentials.js";
import { DEFAULT_SERVER_NAME, DEFAULT_SERVER_VERSION, startStdioServer } from "./server.js";

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

/**
 * Entry point used by both the published bin and tests.
 *
 * Resolves config from argv/env, loads the cached scoped client token, refuses owner
 * credentials, and starts the stdio server. Returns the process exit code; callers are
 * responsible for invoking process.exit().
 */
export async function runMcpServerCli(argv, deps = {}) {
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

  let options;
  try {
    options = parseOptions(argv, env);
  } catch (error) {
    stderr.write(`pdpp-mcp-server: ${error.message}\n`);
    stderr.write(HELP);
    return error.exitCode ?? 64;
  }

  let credential;
  try {
    credential = await load(options.providerUrl, { cacheRoot: options.cacheRoot });
  } catch (error) {
    if (error instanceof CredentialError) {
      stderr.write(`pdpp-mcp-server: ${error.message}\n`);
      return error.exitCode;
    }
    stderr.write(`pdpp-mcp-server: ${error?.stack ?? error}\n`);
    return 1;
  }

  stderr.write(
    `pdpp-mcp-server: connected to ${credential.providerUrl} using scoped credential at ${credential.cacheFile}\n`
  );

  let handle;
  try {
    handle = await start({
      accessToken: credential.accessToken,
      providerUrl: credential.providerUrl,
      serverName: options.serverName,
    });
  } catch (error) {
    stderr.write(`pdpp-mcp-server: failed to start stdio server: ${error?.stack ?? error}\n`);
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
  constructor(message, exitCode = 64) {
    super(message);
    this.name = "OptionParseError";
    this.exitCode = exitCode;
  }
}

export function parseOptions(argv, env) {
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

  return { cacheRoot, providerUrl, serverName };
}

function readOption(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) {
    return;
  }
  return argv[index + 1];
}

export { CredentialError, loadScopedCredential } from "./credentials.js";
export { RsClient } from "./rs-client.js";
export {
  createPdppMcpServer,
  DEFAULT_SERVER_NAME,
  DEFAULT_SERVER_VERSION,
  handleStreamableHttpRequest,
  PDPP_MCP_TOOL_NAMES,
  startStdioServer,
} from "./server.js";
export { buildResourceTemplates, buildStreamResourceTemplate, buildTools, InvalidResourceUriError } from "./tools.js";
