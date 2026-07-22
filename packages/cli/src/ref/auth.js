// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Owner-action auth resolution for `pdpp ref call`.
//
// The reference server exposes two owner surfaces with two different auth
// modes — the single fact that owners keep rediscovering:
//
//   /_ref/*      operator/diagnostics control plane  → owner SESSION COOKIE
//   /v1/owner/*  owner control machine API           → owner BEARER token
//
// Every mutating /_ref/* route is guarded by `requireOwnerSession` alone; none
// require a CSRF token, because the server exempts any POST whose Content-Type
// is exactly `application/json` (a JSON body can't be forged into a cross-origin
// browser POST without a CORS preflight). So a JSON owner-cookie POST to /_ref/*
// needs no `_csrf` handling at all. This module encodes that model and refuses
// the mismatched pairing (cookie→/v1/owner or bearer→/_ref), which would
// otherwise surface as a confusing 401/404 — the "401 = wrong auth, 404 = wrong
// path" trap from the live route map.

import { PdppUsageError } from "./errors.js";
import { ownerSessionHeaders } from "./fetch.js";

export const AUTH_COOKIE = "cookie";
export const AUTH_BEARER = "bearer";

// Infer the auth mode a path expects from its prefix. Returns 'cookie',
// 'bearer', or null when the prefix is not an owner surface we recognize.
export function inferAuthMode(path) {
  const p = normalizePath(path);
  if (p.startsWith("/v1/owner/") || p === "/v1/owner") {
    return AUTH_BEARER;
  }
  if (p.startsWith("/_ref/") || p === "/_ref") {
    return AUTH_COOKIE;
  }
  return null;
}

function normalizePath(path) {
  if (typeof path !== "string" || !path) {
    return "";
  }
  // Strip a query/hash and a leading origin if the caller passed a full URL.
  let p = path;
  try {
    if (/^https?:\/\//i.test(p)) {
      p = new URL(p).pathname;
    }
  } catch {
    // fall through; treat as a path
  }
  const q = p.indexOf("?");
  if (q !== -1) {
    p = p.slice(0, q);
  }
  const h = p.indexOf("#");
  if (h !== -1) {
    p = p.slice(0, h);
  }
  if (!p.startsWith("/")) {
    p = `/${p}`;
  }
  return p;
}

// Resolve the effective auth mode for a call: an explicit `--auth` override if
// present and valid, otherwise the path-inferred mode. Throws a usage error
// when an override conflicts with the path's surface, or when neither an
// override nor a recognized prefix is available.
export function resolveAuthMode(path, override) {
  const inferred = inferAuthMode(path);

  if (override !== undefined && override !== null && override !== "") {
    const chosen = String(override).toLowerCase();
    if (chosen !== AUTH_COOKIE && chosen !== AUTH_BEARER) {
      throw new PdppUsageError(`Invalid --auth value: ${override}. Use "cookie" or "bearer".`);
    }
    if (inferred && inferred !== chosen) {
      throw new PdppUsageError(mismatchMessage(normalizePath(path), inferred, chosen));
    }
    return chosen;
  }

  if (!inferred) {
    throw new PdppUsageError(
      `Cannot infer owner auth mode for path "${path}". ` +
        "Owner routes are /_ref/* (cookie) or /v1/owner/* (bearer). " +
        "Pass --auth cookie|bearer to call a non-standard path explicitly."
    );
  }
  return inferred;
}

function mismatchMessage(path, inferred, chosen) {
  const surface = inferred === AUTH_COOKIE ? "/_ref/*" : "/v1/owner/*";
  const correct = inferred === AUTH_COOKIE ? "cookie" : "bearer";
  return (
    `Auth mismatch: ${path} is a ${surface} route and uses ${correct} auth, ` +
    `but --auth ${chosen} was given. ` +
    "/_ref/* uses the owner session cookie; /v1/owner/* uses the owner bearer. " +
    "Pointing the wrong auth at a route returns a confusing 401/404. " +
    `Drop --auth (it is inferred) or use --auth ${correct}.`
  );
}

// Build the request headers for the chosen auth mode. For cookie auth, resolves
// the owner session (flag > env > 0600 cache) and never echoes it. For bearer
// auth, reads the owner token from --owner-token-stdin or PDPP_OWNER_TOKEN and
// never accepts it on argv. Throws a usage error when the required secret is
// absent. The returned object includes only the auth header; content-type is
// added by the caller for bodies.
export async function buildAuthHeaders({ mode, referenceUrl, flags, io, env = process.env }) {
  if (mode === AUTH_COOKIE) {
    const headers = ownerSessionHeaders({
      cacheRoot: flags["cache-root"],
      ownerSession: flags["owner-session"] || "",
      referenceUrl,
    });
    if (!headers.Cookie) {
      throw new PdppUsageError(
        "No owner session available. Run `pdpp ref login <reference-url>` first, " +
          "pass --owner-session <cookie>, or set PDPP_OWNER_SESSION_COOKIE."
      );
    }
    return headers;
  }

  if (mode === AUTH_BEARER) {
    const token = await resolveOwnerToken(flags, io, env);
    if (!token) {
      throw new PdppUsageError(
        "No owner bearer available for a /v1/owner/* call. " +
          "Pipe it via `--owner-token-stdin` or set PDPP_OWNER_TOKEN. " +
          "The token is never accepted on the command line."
      );
    }
    return { Authorization: `Bearer ${token}` };
  }

  throw new PdppUsageError(`Unknown auth mode: ${mode}`);
}

async function resolveOwnerToken(flags, io, env) {
  if (flags["owner-token-stdin"]) {
    return readFirstLine((io && io.stdin) || process.stdin);
  }
  const fromEnv = env.PDPP_OWNER_TOKEN;
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return fromEnv.trim();
  }
  return null;
}

function readFirstLine(stream) {
  return new Promise((resolve, reject) => {
    if (!stream || typeof stream.on !== "function") {
      resolve("");
      return;
    }
    let buf = "";
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
