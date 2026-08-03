// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Whether an origin has the SHAPE a hosted MCP client requires.
 *
 * This is deliberately a NECESSARY-BUT-NOT-SUFFICIENT check, and the naming
 * says so. Hosted clients (ChatGPT, Claude.ai) fetch the MCP URL from their own
 * servers and reject non-public addresses before they ever send a request, so
 * an origin failing this check can NEVER work for them and the owner should be
 * told that up front. An origin PASSING this check has only cleared the syntax
 * bar: it can still be unreachable because of DNS, a firewall, a closed port,
 * a reverse proxy, or a certificate the client refuses. Syntax cannot prove
 * external reachability, so nothing here may be phrased as a promise that a
 * hosted client will connect.
 *
 * Local agents (Claude Code, Codex, the CLI) run on the owner's machine and are
 * unaffected by any of this.
 */
export type HostedMcpOriginShape = "public_https_shape" | "not_https" | "not_public_address" | "malformed";

// Hostnames that never resolve publicly. `.local` is mDNS, `.internal` and
// `.home.arpa` are private-DNS conventions, and the rest are reserved.
const NON_PUBLIC_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".lan", ".intranet", ".corp"];

// IPv4 literals a hosted client cannot route to: loopback, RFC1918 private,
// RFC6598 CGNAT (100.64/10), link-local, "this network", and multicast/reserved.
const NON_PUBLIC_IPV4 =
  /^(?:0\.|127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|22[4-9]\.|2[3-5]\d\.)/;

const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const IPV6_UNIQUE_LOCAL = /^f[cd]/i;
const IPV6_LINK_LOCAL = /^fe[89ab]/i;
const TRAILING_ROOT_DOT = /\.$/;

function isIpv4Literal(host: string): boolean {
  return IPV4_LITERAL.test(host);
}

// IPv6 loopback (::1), unspecified (::), unique-local (fc00::/7 → fc/fd), and
// link-local (fe80::/10 → fe8/fe9/fea/feb) are all non-public.
function isNonPublicIpv6(host: string): boolean {
  const inner = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (!inner.includes(":")) {
    return false;
  }
  const bare = inner.split("%")[0] ?? inner;
  if (bare === "::1" || bare === "::") {
    return true;
  }
  if (IPV6_UNIQUE_LOCAL.test(bare) || IPV6_LINK_LOCAL.test(bare)) {
    return true;
  }
  // IPv4-mapped/compatible forms such as ::ffff:127.0.0.1 inherit the v4 verdict.
  const tail = bare.slice(bare.lastIndexOf(":") + 1);
  return isIpv4Literal(tail) && NON_PUBLIC_IPV4.test(tail);
}

export function classifyHostedMcpOrigin(origin: string): HostedMcpOriginShape {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return "malformed";
  }
  if (url.protocol !== "https:") {
    return "not_https";
  }
  // A trailing root-label dot ("nas.local.") is the same name as "nas.local",
  // so normalize it away before any suffix comparison.
  const host = url.hostname.toLowerCase().replace(TRAILING_ROOT_DOT, "");
  if (!host || host === "localhost" || NON_PUBLIC_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return "not_public_address";
  }
  if (isNonPublicIpv6(host)) {
    return "not_public_address";
  }
  if (isIpv4Literal(host)) {
    return NON_PUBLIC_IPV4.test(host) ? "not_public_address" : "public_https_shape";
  }
  // A bare single-label hostname ("pdpp", "nas") is not publicly resolvable.
  if (!host.includes(".")) {
    return "not_public_address";
  }
  return "public_https_shape";
}

/**
 * True when the origin clears the shape bar hosted clients require. Passing is
 * necessary, NOT sufficient — see the module comment. Callers must not present
 * a `true` result as proof that a hosted client can connect.
 */
export function hasPublicHttpsShape(origin: string): boolean {
  return classifyHostedMcpOrigin(origin) === "public_https_shape";
}
