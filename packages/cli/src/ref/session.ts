// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { writePdppSecretFile } from "../cache-layout.ts";
import { PdppCliError } from "./errors.ts";

const SESSION_DIR_NAME = "owner-sessions";

// Set-Cookie may contain multiple cookies joined by ", " when collapsed.
// Split conservatively on the first attribute pair only.
const SET_COOKIE_SPLIT_RE = /,\s*(?=[^;]+=[^;]+)/;

export interface OwnerSessionPaths {
  cacheRoot: string;
  dir: string;
  file: string;
}

export interface OwnerSessionOpts {
  cacheRoot?: string | undefined;
}

export function getOwnerSessionPaths(referenceUrl: string, opts: OwnerSessionOpts = {}): OwnerSessionPaths {
  const cacheRoot = opts.cacheRoot || ".pdpp";
  const dir = join(cacheRoot, SESSION_DIR_NAME);
  const file = join(dir, `${sessionCacheKey(referenceUrl)}.json`);
  return { cacheRoot, dir, file };
}

function sessionCacheKey(referenceUrl: string): string {
  try {
    const u = new URL(referenceUrl);
    // Owner sessions are origin-scoped. Include protocol so an HTTPS login
    // cannot be silently reused for an HTTP reference URL on the same host.
    return `${u.protocol}//${u.host}`.replace(/[^a-zA-Z0-9.-]/g, "_");
  } catch {
    return referenceUrl.replace(/[^a-zA-Z0-9.-]/g, "_");
  }
}

export interface WriteOwnerSessionArgs {
  cacheRoot?: string;
  cookie: string;
  referenceUrl: string;
}

export function writeOwnerSession({ referenceUrl, cookie, cacheRoot }: WriteOwnerSessionArgs): string {
  if (!referenceUrl) {
    throw new PdppCliError("writeOwnerSession requires referenceUrl");
  }
  if (!cookie) {
    throw new PdppCliError("writeOwnerSession requires cookie");
  }

  const { file } = getOwnerSessionPaths(referenceUrl, { cacheRoot });
  const payload = {
    reference_url: referenceUrl,
    cookie,
    saved_at: new Date().toISOString(),
  };
  writePdppSecretFile(file, JSON.stringify(payload, null, 2));
  ensureGitignore(cacheRoot || ".pdpp");
  return file;
}

export interface ReadOwnerSessionArgs {
  cacheRoot?: string | undefined;
  referenceUrl?: string | undefined;
}

export interface OwnerSessionRecord {
  cookie: string;
  file: string;
  savedAt: string | null;
}

export function readOwnerSession({ referenceUrl, cacheRoot }: ReadOwnerSessionArgs = {}): OwnerSessionRecord | null {
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
      return { cookie: data.cookie, savedAt: data.saved_at || null, file };
    }
  } catch {
    return null;
  }
  return null;
}

export function clearOwnerSession({ referenceUrl, cacheRoot }: ReadOwnerSessionArgs = {}): boolean {
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

export function getOwnerSessionFileMode(referenceUrl: string, opts: OwnerSessionOpts = {}): number | null {
  const { file } = getOwnerSessionPaths(referenceUrl, opts);
  if (!existsSync(file)) {
    return null;
  }
  // biome-ignore lint/suspicious/noBitwiseOperators: Unix permission bitmask, not a && typo.
  return statSync(file).mode & 0o777;
}

function ensureGitignore(cacheRoot: string): void {
  const gi = join(cacheRoot, ".gitignore");
  try {
    mkdirSync(dirname(gi), { recursive: true, mode: 0o700 });
    if (!existsSync(gi)) {
      writeFileSync(gi, "*\n!.gitignore\n", { mode: 0o600 });
    }
  } catch {
    // best-effort; never block CLI on .gitignore creation
  }
}

// Parse a Set-Cookie header value (or array of values) and return the value of
// the named cookie if present, e.g. "pdpp_owner_session=abc; Path=/; HttpOnly".
export function extractCookieFromSetCookie(
  setCookie: string | string[] | undefined | null,
  cookieName: string
): string | null {
  if (!setCookie) {
    return null;
  }
  const headers = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const raw of headers) {
    if (typeof raw !== "string") {
      continue;
    }
    for (const piece of raw.split(SET_COOKIE_SPLIT_RE)) {
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
