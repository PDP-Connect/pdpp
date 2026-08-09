// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Translate `connect`'s CLI scope flags into the `collection_scope` field the
 * enroll route (`POST /_ref/device-exporters/enroll`) already accepts.
 *
 * This module does NOT decide the effective boundary — the server does that
 * (see `reference-implementation/server/enrollment-scope-narrowing.ts`),
 * enforcing narrow-only against whatever it already declared and defaulting
 * to recent history when neither side says anything. This module only
 * builds the REQUEST: a device's stated preference, or no preference at all.
 *
 * `recentSinceDays` is a local copy of the day-math
 * `@pdpp/reference-contract`'s `resolveNamedCollectionScope`/
 * `defaultUndeclaredScope` already perform, duplicated rather than imported
 * — `@pdpp/local-collector` is a published, dependency-light package that
 * reaches into sibling packages' SOURCE (not npm dependencies) for its
 * bundled connectors and runtime, and `reference-contract` pulls in `ajv`
 * purely to validate OpenAPI schemas this package has no use for. This
 * mirrors the same "duplicate the pure leaf, prove equivalence with a test"
 * pattern `collector-runner.ts` already uses for the collection-scope
 * contract itself (see its `collectorScopeFingerprint` doc comment).
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const DEFAULT_CONNECT_RECENT_DAYS = 30;

/** Thrown by {@link normalizeSourceRoots}/{@link validateSinceLocally} before any request is built or sent. */
export class ConnectScopeValidationError extends Error {}

/**
 * Expand a leading `~` (home directory) and resolve to an absolute,
 * normalized path — the same shape `--source-roots` entries need to be
 * useful as filesystem roots. A bare `~` or `~/…` is expanded against
 * `homedir()`; every other value (including a bare connector-project name
 * with no path separator, which a filesystem-class connector matches by
 * final path segment) is resolved relative to the current working
 * directory so `.`/`..`/mixed separators collapse consistently.
 */
export function expandSourceRoot(rawRoot: string): string {
  let expanded = rawRoot;
  if (rawRoot === "~") {
    expanded = homedir();
  } else if (rawRoot.startsWith("~/")) {
    expanded = join(homedir(), rawRoot.slice(2));
  }
  return isAbsolute(expanded) ? resolve(expanded) : resolve(process.cwd(), expanded);
}

/**
 * Expand and validate `--source-roots` entries against the local
 * filesystem BEFORE any request reaches the server. The server has no
 * filesystem of its own to check against — it only validates the request's
 * shape (non-empty strings) — so a typo or an un-expanded `~` here would
 * otherwise sail through as a syntactically valid request that the
 * connector later matches against zero real directories, exactly the
 * silent-zero-coverage failure mode `source_roots` already had to be fixed
 * for once (see `claude_code`'s `projectDirMatchesSourceRoots`). Failing
 * locally, honestly, and before any network call is cheaper and clearer
 * than failing after a round trip.
 *
 * A root that is a bare name with no path separator (e.g. a Claude Code
 * project's flattened directory name) is not a filesystem path on this
 * host and is passed through unexpanded — existence is not checked for it,
 * since the connector, not this CLI, knows how to resolve it.
 */
export function normalizeSourceRoots(rawRoots: readonly string[]): string[] {
  return rawRoots.map((raw) => {
    const trimmed = raw.trim();
    if (!trimmed) {
      throw new ConnectScopeValidationError("--source-roots entries must be non-empty");
    }
    const looksLikePath = trimmed === "~" || trimmed.startsWith("~/") || trimmed.includes("/") || isAbsolute(trimmed);
    if (!looksLikePath) {
      return trimmed;
    }
    const expanded = expandSourceRoot(trimmed);
    if (!existsSync(expanded)) {
      throw new ConnectScopeValidationError(
        `--source-roots entry '${raw}' does not exist on this host (resolved to '${expanded}'). ` +
          "Pass an existing directory path, or a bare project name if your connector matches by name."
      );
    }
    return expanded;
  });
}

/**
 * Validate `--since` is a parseable timestamp before any request is sent.
 * `Date.parse` accepts more than strict ISO-8601, but rejecting everything
 * it rejects — and nothing it accepts — is the same leniency the server's
 * own `new Date(value)` parse will apply, so this can never reject a value
 * the server would have accepted, only catch the typos it wouldn't.
 */
export function validateSinceLocally(since: string): string {
  const trimmed = since.trim();
  if (!trimmed || Number.isNaN(Date.parse(trimmed))) {
    throw new ConnectScopeValidationError(`--since '${since}' is not a parseable date/time`);
  }
  return trimmed;
}

export interface ConnectScopeChoice {
  readonly kind: "recent" | "all" | "custom" | "unspecified";
  readonly recentDays?: number;
  readonly since?: string;
  readonly sourceRoots?: readonly string[];
}

/** A device's `collection_scope` request, or `undefined` for no preference (`unspecified`). */
export type ConnectScopeRequestBody = { since?: string; source_roots?: string[] } | null | undefined;

export function recentSinceDays(nowIso: string, days: number): string {
  return new Date(Date.parse(nowIso) - days * 86_400_000).toISOString();
}

/**
 * Build the `collection_scope` field to send with an enrollment request.
 *
 * Returns `undefined` for `unspecified` — the field is omitted from the
 * request body entirely, not sent as `null`. Only an explicit `--all`
 * produces `null` (a declared full pass); the two are different requests to
 * the server, and conflating them would silently turn "I have no
 * preference" into "I demand everything," which could then be rejected as
 * widening against a server-declared boundary the operator never intended
 * to fight.
 */
export function buildConnectScopeRequest(choice: ConnectScopeChoice, now: string): ConnectScopeRequestBody {
  if (choice.kind === "unspecified") {
    return;
  }
  if (choice.kind === "all") {
    return null;
  }
  if (choice.kind === "recent") {
    const days = choice.recentDays && choice.recentDays > 0 ? choice.recentDays : DEFAULT_CONNECT_RECENT_DAYS;
    return { since: recentSinceDays(now, days) };
  }
  // custom
  const out: { since?: string; source_roots?: string[] } = {};
  if (choice.since) {
    out.since = choice.since;
  }
  if (choice.sourceRoots && choice.sourceRoots.length > 0) {
    out.source_roots = [...choice.sourceRoots];
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * A one-line, operator-facing description of what a scope choice asked for —
 * used in `connect`'s human-readable output and the generated follow-up
 * note, so the CLI never prints a vague "scope declared" when it can say
 * exactly what boundary was requested.
 */
export function describeConnectScopeChoice(choice: ConnectScopeChoice, now: string): string {
  if (choice.kind === "unspecified") {
    return "no boundary requested (server default applies)";
  }
  if (choice.kind === "all") {
    return "all history (explicit full pass)";
  }
  if (choice.kind === "recent") {
    const days = choice.recentDays && choice.recentDays > 0 ? choice.recentDays : DEFAULT_CONNECT_RECENT_DAYS;
    return `recent ${days} day(s) (since=${recentSinceDays(now, days)})`;
  }
  const parts: string[] = [];
  if (choice.since) {
    parts.push(`since=${choice.since}`);
  }
  if (choice.sourceRoots && choice.sourceRoots.length > 0) {
    parts.push(`source_roots=${choice.sourceRoots.join(",")}`);
  }
  return parts.length > 0 ? `custom (${parts.join(", ")})` : "all history (empty custom scope)";
}
