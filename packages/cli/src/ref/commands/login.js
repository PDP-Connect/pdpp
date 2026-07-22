// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { parseArgs } from "../args.js";
import { PdppCliError, PdppUsageError } from "../errors.js";
import { OWNER_SESSION_COOKIE_NAME } from "../fetch.js";
import { extractCookieFromSetCookie, getOwnerSessionPaths, writeOwnerSession } from "../session.js";

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
export async function runRefLogin(argv, io = {}, fetchImpl = globalThis.fetch) {
  const out = io.stdout || process.stdout;

  const { flags, positionals } = parseArgs(argv);
  const referenceUrlRaw = positionals[0];
  if (!referenceUrlRaw) {
    throw new PdppUsageError("Usage: pdpp ref login <reference-url> [--password-stdin] [--cache-root <dir>]");
  }
  const referenceUrl = referenceUrlRaw.replace(/\/$/, "");

  const password = await resolvePassword(flags, io);
  if (!password) {
    throw new PdppUsageError(
      "Owner password required. Pipe it via `--password-stdin` or set PDPP_OWNER_PASSWORD. " +
        "The password is never accepted on the command line."
    );
  }

  const loginUrl = `${referenceUrl}/owner/login`;
  let resp;
  try {
    resp = await fetchImpl(loginUrl, {
      body: JSON.stringify({ password }),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      method: "POST",
      redirect: "manual",
    });
  } catch (e) {
    throw new PdppCliError(`Network request to ${loginUrl} failed: ${e.message}`);
  }

  const status = resp.status;
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

  const cacheRoot = flags["cache-root"] || ".pdpp";
  const file = writeOwnerSession({
    cacheRoot,
    cookie: `${OWNER_SESSION_COOKIE_NAME}=${cookieValue}`,
    referenceUrl,
  });

  // Never print the cookie value. Confirm location only.
  out.write(`Saved owner session for ${referenceUrl}\n`);
  out.write(`  cache: ${file}\n`);
  return 0;
}

async function resolvePassword(flags, io) {
  if (flags["password-stdin"]) {
    return readFirstLine(io.stdin || process.stdin);
  }
  const fromEnv = process.env.PDPP_OWNER_PASSWORD;
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return fromEnv;
  }
  return null;
}

function readFirstLine(stream) {
  return new Promise((resolve, reject) => {
    let buf = "";
    if (!stream || typeof stream.on !== "function") {
      resolve("");
      return;
    }
    stream.setEncoding?.("utf8");
    const onData = (chunk) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        cleanup();
        resolve(buf.slice(0, nl).replace(/\r$/, ""));
      }
    };
    const onEnd = () => {
      cleanup();
      resolve(buf.replace(/\r?\n$/, ""));
    };
    const onError = (e) => {
      cleanup();
      reject(e);
    };
    function cleanup() {
      stream.off?.("data", onData);
      stream.off?.("end", onEnd);
      stream.off?.("error", onError);
    }
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
  });
}

function readSetCookie(resp) {
  const headers = resp.headers;
  if (!headers) {
    return null;
  }
  if (typeof headers.getSetCookie === "function") {
    const arr = headers.getSetCookie();
    if (arr?.length) {
      return arr;
    }
  }
  if (typeof headers.get === "function") {
    return headers.get("set-cookie") || headers.get("Set-Cookie");
  }
  return headers["set-cookie"] || headers["Set-Cookie"] || null;
}

export { getOwnerSessionPaths };
