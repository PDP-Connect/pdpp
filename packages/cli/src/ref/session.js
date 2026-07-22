// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { writePdppSecretFile } from "../cache-layout.js";
import { PdppCliError } from "./errors.js";

const SESSION_DIR_NAME = "owner-sessions";

export function getOwnerSessionPaths(referenceUrl, opts = {}) {
  const cacheRoot = opts.cacheRoot || ".pdpp";
  const dir = join(cacheRoot, SESSION_DIR_NAME);
  const file = join(dir, `${sessionCacheKey(referenceUrl)}.json`);
  return { cacheRoot, dir, file };
}

function sessionCacheKey(referenceUrl) {
  try {
    const u = new URL(referenceUrl);
    // Owner sessions are origin-scoped. Include protocol so an HTTPS login
    // cannot be silently reused for an HTTP reference URL on the same host.
    return `${u.protocol}//${u.host}`.replace(/[^a-zA-Z0-9.-]/g, "_");
  } catch {
    return referenceUrl.replace(/[^a-zA-Z0-9.-]/g, "_");
  }
}

export function writeOwnerSession({ referenceUrl, cookie, cacheRoot } = {}) {
  if (!referenceUrl) {
    throw new PdppCliError("writeOwnerSession requires referenceUrl");
  }
  if (!cookie) {
    throw new PdppCliError("writeOwnerSession requires cookie");
  }

  const { file } = getOwnerSessionPaths(referenceUrl, { cacheRoot });
  const payload = {
    cookie,
    reference_url: referenceUrl,
    saved_at: new Date().toISOString(),
  };
  writePdppSecretFile(file, JSON.stringify(payload, null, 2));
  ensureGitignore(cacheRoot || ".pdpp");
  return file;
}

export function readOwnerSession({ referenceUrl, cacheRoot } = {}) {
  if (!referenceUrl) {
    return null;
  }
  const { file } = getOwnerSessionPaths(referenceUrl, { cacheRoot });
  if (!existsSync(file)) {
    return null;
  }
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (data && typeof data.cookie === "string" && data.cookie.length > 0) {
      return { cookie: data.cookie, file, savedAt: data.saved_at || null };
    }
  } catch {
    return null;
  }
  return null;
}

export function clearOwnerSession({ referenceUrl, cacheRoot } = {}) {
  if (!referenceUrl) {
    return false;
  }
  const { file } = getOwnerSessionPaths(referenceUrl, { cacheRoot });
  if (!existsSync(file)) {
    return false;
  }
  try {
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

export function getOwnerSessionFileMode(referenceUrl, opts = {}) {
  const { file } = getOwnerSessionPaths(referenceUrl, opts);
  if (!existsSync(file)) {
    return null;
  }
  return statSync(file).mode & 0o777;
}

function ensureGitignore(cacheRoot) {
  const gi = join(cacheRoot, ".gitignore");
  try {
    mkdirSync(dirname(gi), { mode: 0o700, recursive: true });
    if (!existsSync(gi)) {
      writeFileSync(gi, "*\n!.gitignore\n", { mode: 0o600 });
    }
  } catch {
    // best-effort; never block CLI on .gitignore creation
  }
}

// Parse a Set-Cookie header value (or array of values) and return the value of
// the named cookie if present, e.g. "pdpp_owner_session=abc; Path=/; HttpOnly".
export function extractCookieFromSetCookie(setCookie, cookieName) {
  if (!setCookie) {
    return null;
  }
  const headers = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const raw of headers) {
    if (typeof raw !== "string") {
      continue;
    }
    // Set-Cookie may contain multiple cookies joined by ", " when collapsed.
    // Split conservatively on the first attribute pair only.
    for (const piece of raw.split(/,\s*(?=[^;]+=[^;]+)/)) {
      const [pair] = piece.split(";");
      if (!pair) {
        continue;
      }
      const eq = pair.indexOf("=");
      if (eq === -1) {
        continue;
      }
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (name === cookieName) {
        return value;
      }
    }
  }
  return null;
}
