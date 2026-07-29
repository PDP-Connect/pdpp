// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { parseArgs } from "../args.ts";
import { PdppCliError, PdppUsageError } from "../errors.ts";
import { OWNER_SESSION_COOKIE_NAME } from "../fetch.ts";
// biome-ignore lint/style/noExportedImports: getOwnerSessionPaths is re-exported by design for callers of this module's owner-session cache path, matching index.ts's re-export precedent; `getOwnerSessionPaths` is not used locally in this file.
import { extractCookieFromSetCookie, getOwnerSessionPaths, writeOwnerSession } from "../session.ts";
import type { CommandIo } from "./call.ts";

// Owner-session login UX for `pdpp ref ...`.
//
// Usage:
//   pdpp ref login <reference-url> [--password-stdin] [--cache-root <dir>]
//
// Password sources, in precedence order:
//   1. --password-stdin   (reads first line of stdin; CI-friendly)
//   2. PDPP_OWNER_PASSWORD env var
// We intentionally do NOT accept the password on argv to avoid leaking it
// into shell history, ps output, or logs.
//
// On success: persists the issued owner-session cookie to project-local
// `.pdpp/owner-sessions/<host>.json` with mode 0600. Cookie value is never
// printed.
const TRAILING_SLASH_RE = /\/$/;
const TRAILING_CR_RE = /\r$/;
const TRAILING_CRLF_RE = /\r?\n$/;

export async function runRefLogin(
  argv: string[],
  io: CommandIo = {},
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<number> {
  const out = io.stdout || process.stdout;

  const { flags, positionals } = parseArgs(argv);
  const [referenceUrlRaw] = positionals;
  if (!referenceUrlRaw) {
    throw new PdppUsageError("Usage: pdpp ref login <reference-url> [--password-stdin] [--cache-root <dir>]");
  }
  const referenceUrl = referenceUrlRaw.replace(TRAILING_SLASH_RE, "");

  const password = await resolvePassword(flags, io);
  if (!password) {
    throw new PdppUsageError(
      "Owner password required. Pipe it via `--password-stdin` or set PDPP_OWNER_PASSWORD. " +
        "The password is never accepted on the command line."
    );
  }

  const loginUrl = `${referenceUrl}/owner/login`;
  let resp: Response;
  try {
    resp = await fetchImpl(loginUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ password }),
      redirect: "manual",
    });
  } catch (e) {
    // biome-ignore lint/style/useErrorCause: PdppCliError's constructor (message, exitCode, details) has no cause param; the original error's message is interpolated into the thrown message instead.
    throw new PdppCliError(`Network request to ${loginUrl} failed: ${(e as Error).message}`);
  }

  const { status } = resp;
  // The reference server's POST /owner/login responds with a 302 redirect
  // and Set-Cookie on success, or 401/403 on failure. Anything outside
  // 200-399 means the login was rejected.
  if (status >= 400) {
    if (status === 401) {
      throw new PdppCliError("Owner login rejected: incorrect password (HTTP 401).", 3);
    }
    if (status === 403) {
      throw new PdppCliError("Owner login rejected: CSRF/policy failure (HTTP 403).", 4);
    }
    if (status === 404) {
      throw new PdppCliError(
        `Owner login route not found at ${loginUrl} (HTTP 404). Confirm the reference server URL.`,
        5
      );
    }
    throw new PdppCliError(`Owner login failed: HTTP ${status}.`);
  }

  const setCookie = readSetCookie(resp);
  const cookieValue = extractCookieFromSetCookie(setCookie, OWNER_SESSION_COOKIE_NAME);
  if (!cookieValue) {
    throw new PdppCliError(
      "Owner login succeeded but no owner-session cookie was returned. " +
        "Confirm that placeholder owner auth is enabled on the reference server."
    );
  }

  const cacheRoot = typeof flags["cache-root"] === "string" ? flags["cache-root"] : ".pdpp";
  const file = writeOwnerSession({
    referenceUrl,
    cookie: `${OWNER_SESSION_COOKIE_NAME}=${cookieValue}`,
    cacheRoot,
  });

  // Never print the cookie value. Confirm location only.
  out.write(`Saved owner session for ${referenceUrl}\n`);
  out.write(`  cache: ${file}\n`);
  return 0;
}

function resolvePassword(flags: Record<string, string | boolean>, io: CommandIo): Promise<string | null> {
  if (flags["password-stdin"]) {
    return readFirstLine(io.stdin || process.stdin);
  }
  const fromEnv = process.env.PDPP_OWNER_PASSWORD;
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return Promise.resolve(fromEnv);
  }
  return Promise.resolve(null);
}

function readFirstLine(stream: NodeJS.ReadableStream | undefined): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    let buf = "";
    if (!stream || typeof stream.on !== "function") {
      resolvePromise("");
      return;
    }
    stream.setEncoding?.("utf8");
    const onData = (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        cleanup();
        resolvePromise(buf.slice(0, nl).replace(TRAILING_CR_RE, ""));
      }
    };
    const onEnd = () => {
      cleanup();
      resolvePromise(buf.replace(TRAILING_CRLF_RE, ""));
    };
    const onError = (e: Error) => {
      cleanup();
      rejectPromise(e);
    };
    function cleanup() {
      stream?.off?.("data", onData);
      stream?.off?.("end", onEnd);
      stream?.off?.("error", onError);
    }
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
  });
}

function readSetCookie(resp: Response): string | string[] | null {
  const { headers } = resp;
  if (!headers) {
    return null;
  }
  const headersWithGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headersWithGetSetCookie.getSetCookie === "function") {
    const arr = headersWithGetSetCookie.getSetCookie();
    if (arr?.length) {
      return arr;
    }
  }
  if (typeof headers.get === "function") {
    return headers.get("set-cookie") || headers.get("Set-Cookie");
  }
  return null;
}

export { getOwnerSessionPaths };
