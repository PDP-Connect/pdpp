// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Project-local agent grant cache.
 *
 * Layout (relative to project root, gitignored by convention):
 *   .pdpp/
 *     agent-access.json          non-secret: AS/RS URLs, project label, last activity
 *     clients/<client-id>.json   non-secret: DCR registration response
 *     grants/<grant-id>.json     non-secret: grant scope, expiry, source
 *     tokens/<grant-id>.token    secret: opaque client token, mode 0600
 *
 * Status reads only agent-access.json and grants/*.json.
 * Token reads happen only at call time; never echoed to status output.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

// A cache root override (see the --cache-root flag in agent.ts); `null`
// means "use the default .pdpp/ under cwd".
export type CacheRoot = string | null;

// A stream name as it appears in a grant/manifest: either a bare string or
// an object carrying at least `name` (both shapes occur in stored JSON;
// callers normalize with `s.name || s`).
export type StreamRef = string | { name: string };

export interface SourceBinding {
  id: string;
  kind: string;
}

// A cached grant record, persisted to grants/<grant-id>.json by writeGrant
// (see agent.ts's runStore) and read back by status/use/wait/forget/revoke.
// Every field beyond grant_id is optional because a freshly-staged or
// partially-populated grant may be missing fields the introspection
// response did not return.
export interface CachedGrant {
  access_mode?: string | null;
  client_id?: string | null;
  expires_at?: string | null;
  grant_id: string;
  issued_at?: string;
  purpose_code?: string | null;
  purpose_description?: string | null;
  retention?: unknown;
  revoked?: boolean;
  source?: SourceBinding | null;
  streams?: StreamRef[];
}

// A cached DCR client registration record, as returned by POST /oauth/register
// and persisted to clients/<client-id>.json.
export interface CachedClient {
  client_id: string;
  client_name?: string;
  [key: string]: unknown;
}

// The project-local agent-access.json cache: AS/RS URLs and the last time
// this cache was touched.
export interface AgentAccess {
  as_url?: string;
  last_activity?: string;
  rs_url?: string;
  [key: string]: unknown;
}

const PDPP_DIR = ".pdpp";

function pdppRoot(cacheRoot: CacheRoot): string {
  return cacheRoot || join(process.cwd(), PDPP_DIR);
}

function clientsDir(cacheRoot: CacheRoot) {
  return join(pdppRoot(cacheRoot), "clients");
}
function grantsDir(cacheRoot: CacheRoot) {
  return join(pdppRoot(cacheRoot), "grants");
}
function tokensDir(cacheRoot: CacheRoot) {
  return join(pdppRoot(cacheRoot), "tokens");
}
function accessFile(cacheRoot: CacheRoot) {
  return join(pdppRoot(cacheRoot), "agent-access.json");
}
function clientFile(cacheRoot: CacheRoot, clientId: string) {
  return join(clientsDir(cacheRoot), `${clientId}.json`);
}
function grantFile(cacheRoot: CacheRoot, grantId: string) {
  return join(grantsDir(cacheRoot), `${grantId}.json`);
}
function tokenFile(cacheRoot: CacheRoot, grantId: string) {
  return join(tokensDir(cacheRoot), `${grantId}.token`);
}

export async function ensureCacheDirs(cacheRoot: CacheRoot): Promise<void> {
  // Each mkdir is `recursive: true`, so creating clientsDir/grantsDir/
  // tokensDir (subdirectories of pdppRoot) concurrently is safe regardless
  // of ordering — recursive mkdir is idempotent and creates any missing
  // parent segments itself.
  const dirs = [pdppRoot(cacheRoot), clientsDir(cacheRoot), grantsDir(cacheRoot), tokensDir(cacheRoot)];
  await Promise.all(
    dirs.map(async (dir) => {
      if (!existsSync(dir)) {
        await mkdir(dir, { mode: 0o700, recursive: true });
      }
    })
  );
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { mode: 0o700, recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export function readAccess(cacheRoot: CacheRoot): AgentAccess | null {
  return readJson<AgentAccess>(accessFile(cacheRoot));
}

export function writeAccess(cacheRoot: CacheRoot, data: AgentAccess): void {
  writeJson(accessFile(cacheRoot), { ...data, last_activity: new Date().toISOString() });
}

export function readClient(cacheRoot: CacheRoot, clientId: string): CachedClient | null {
  return readJson<CachedClient>(clientFile(cacheRoot, clientId));
}

export function writeClient(cacheRoot: CacheRoot, clientId: string, data: CachedClient): void {
  writeJson(clientFile(cacheRoot, clientId), data);
}

export function listClients(cacheRoot: CacheRoot): CachedClient[] {
  const dir = clientsDir(cacheRoot);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson<CachedClient>(join(dir, f)))
    .filter((client): client is CachedClient => Boolean(client));
}

export function readGrant(cacheRoot: CacheRoot, grantId: string): CachedGrant | null {
  return readJson<CachedGrant>(grantFile(cacheRoot, grantId));
}

export function writeGrant(cacheRoot: CacheRoot, grantId: string, data: CachedGrant): void {
  writeJson(grantFile(cacheRoot, grantId), data);
}

export function listGrants(cacheRoot: CacheRoot): CachedGrant[] {
  const dir = grantsDir(cacheRoot);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson<CachedGrant>(join(dir, f)))
    .filter((grant): grant is CachedGrant => Boolean(grant));
}

export async function writeToken(cacheRoot: CacheRoot, grantId: string, token: string): Promise<void> {
  const dir = tokensDir(cacheRoot);
  if (!existsSync(dir)) {
    await mkdir(dir, { mode: 0o700, recursive: true });
  }
  const tf = tokenFile(cacheRoot, grantId);
  writeFileSync(tf, token, { mode: 0o600 });
  await chmod(tf, 0o600);
}

export function readToken(cacheRoot: CacheRoot, grantId: string): string | null {
  const tf = tokenFile(cacheRoot, grantId);
  if (!existsSync(tf)) {
    return null;
  }
  return readFileSync(tf, "utf8").trim() || null;
}

export function deleteGrantFiles(cacheRoot: CacheRoot, grantId: string): void {
  const gf = grantFile(cacheRoot, grantId);
  const tf = tokenFile(cacheRoot, grantId);
  for (const f of [gf, tf]) {
    if (existsSync(f)) {
      try {
        unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
  }
}

export interface HasUsableGrantFilter {
  grantId?: string;
  sourceId?: string;
  sourceKind?: string;
  streams?: string[];
}

// Whether a grant matches hasUsableGrant's filter (id/source/streams), not
// yet accounting for revocation, expiry, or a cached token — those are
// checked separately in hasUsableGrant itself. Extracted only to keep
// hasUsableGrant's own cognitive complexity in budget; behavior (which
// checks, in which order) is unchanged.
function grantMatchesFilter(grant: CachedGrant, filter: HasUsableGrantFilter): boolean {
  const { grantId, sourceKind, sourceId, streams } = filter;
  if (grantId && grant.grant_id !== grantId) {
    return false;
  }
  if (sourceKind && grant.source?.kind !== sourceKind) {
    return false;
  }
  if (sourceId && grant.source?.id !== sourceId) {
    return false;
  }
  if (streams?.length) {
    const grantStreams = new Set((grant.streams || []).map((s) => (typeof s === "string" ? s : s.name)));
    if (!streams.every((s) => grantStreams.has(s))) {
      return false;
    }
  }
  return true;
}

function isUsableGrant(grant: CachedGrant): boolean {
  if (grant.revoked) {
    return false;
  }
  return !(grant.expires_at && new Date(grant.expires_at).getTime() <= Date.now());
}

export function hasUsableGrant(cacheRoot: CacheRoot, filter: HasUsableGrantFilter = {}): CachedGrant | null {
  for (const grant of listGrants(cacheRoot)) {
    if (!(grantMatchesFilter(grant, filter) && isUsableGrant(grant))) {
      continue;
    }
    if (readToken(cacheRoot, grant.grant_id)) {
      return grant;
    }
  }
  return null;
}

// Async to keep parity with ensureCacheDirs (its usual call-site companion,
// which does need to await mkdir); this one is synchronous fs work today.
// biome-ignore lint/suspicious/useAwait: see comment above
export async function ensureGitignore(cacheRoot: CacheRoot): Promise<void> {
  const repoRoot = resolve(pdppRoot(cacheRoot), "..");
  const gitignorePath = join(repoRoot, ".gitignore");
  if (!existsSync(gitignorePath)) {
    return;
  }
  const content = readFileSync(gitignorePath, "utf8");
  if (content.includes(".pdpp/") || content.includes(".pdpp\n") || content.includes(".pdpp\r")) {
    return;
  }
  writeFileSync(gitignorePath, `${content.trimEnd()}\n.pdpp/\n`);
}

// CachedGrant is already exactly the display-safe field set (no
// secret-bearing field exists on it — the token lives only in
// tokens/<grant-id>.token, read separately via readToken). This is a
// defensive shallow copy so callers cannot mutate the cached record through
// the value handed back for display, not a redaction filter.
export function redactGrantForDisplay(grant: CachedGrant | null): CachedGrant | null {
  if (!grant) {
    return null;
  }
  return { ...grant };
}
