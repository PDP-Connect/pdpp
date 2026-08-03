// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Whether a hosted MCP client could reach this instance's origin.
 *
 * Hosted clients (ChatGPT, Claude.ai) fetch the MCP URL from their own
 * servers, so a loopback, private-range, or plain-http origin can never work
 * for them — no amount of local setup fixes it. Local agents (Claude Code,
 * Codex, the CLI) run on the owner's machine and are unaffected, so the
 * connect page uses this to tell the owner which half of its guidance applies
 * instead of promising hosted clients that will fail.
 */
export function isHostedMcpReachableOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "[::1]") {
    return false;
  }
  // Loopback, link-local, and RFC1918 ranges are unreachable from a hosted client.
  return !/^(127\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
}
