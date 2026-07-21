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

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { chmod, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const PDPP_DIR = '.pdpp';

function pdppRoot(cacheRoot) {
  return cacheRoot || join(process.cwd(), PDPP_DIR);
}

function clientsDir(cacheRoot) { return join(pdppRoot(cacheRoot), 'clients'); }
function grantsDir(cacheRoot) { return join(pdppRoot(cacheRoot), 'grants'); }
function tokensDir(cacheRoot) { return join(pdppRoot(cacheRoot), 'tokens'); }
function accessFile(cacheRoot) { return join(pdppRoot(cacheRoot), 'agent-access.json'); }
function clientFile(cacheRoot, clientId) { return join(clientsDir(cacheRoot), `${clientId}.json`); }
function grantFile(cacheRoot, grantId) { return join(grantsDir(cacheRoot), `${grantId}.json`); }
function tokenFile(cacheRoot, grantId) { return join(tokensDir(cacheRoot), `${grantId}.token`); }

export async function ensureCacheDirs(cacheRoot) {
  for (const dir of [pdppRoot(cacheRoot), clientsDir(cacheRoot), grantsDir(cacheRoot), tokensDir(cacheRoot)]) {
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
    }
  }
}

function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function readAccess(cacheRoot) {
  return readJson(accessFile(cacheRoot));
}

export function writeAccess(cacheRoot, data) {
  writeJson(accessFile(cacheRoot), { ...data, last_activity: new Date().toISOString() });
}

export function readClient(cacheRoot, clientId) {
  return readJson(clientFile(cacheRoot, clientId));
}

export function writeClient(cacheRoot, clientId, data) {
  writeJson(clientFile(cacheRoot, clientId), data);
}

export function listClients(cacheRoot) {
  const dir = clientsDir(cacheRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(join(dir, f)))
    .filter(Boolean);
}

export function readGrant(cacheRoot, grantId) {
  return readJson(grantFile(cacheRoot, grantId));
}

export function writeGrant(cacheRoot, grantId, data) {
  writeJson(grantFile(cacheRoot, grantId), data);
}

export function listGrants(cacheRoot) {
  const dir = grantsDir(cacheRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(join(dir, f)))
    .filter(Boolean);
}

export async function writeToken(cacheRoot, grantId, token) {
  const dir = tokensDir(cacheRoot);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  const tf = tokenFile(cacheRoot, grantId);
  writeFileSync(tf, token, { mode: 0o600 });
  await chmod(tf, 0o600);
}

export function readToken(cacheRoot, grantId) {
  const tf = tokenFile(cacheRoot, grantId);
  if (!existsSync(tf)) return null;
  return readFileSync(tf, 'utf8').trim() || null;
}

export function deleteGrantFiles(cacheRoot, grantId) {
  const gf = grantFile(cacheRoot, grantId);
  const tf = tokenFile(cacheRoot, grantId);
  for (const f of [gf, tf]) {
    if (existsSync(f)) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
  }
}

export function hasUsableGrant(cacheRoot, { grantId, sourceKind, sourceId, streams } = {}) {
  for (const grant of listGrants(cacheRoot)) {
    if (grantId && grant.grant_id !== grantId) continue;
    if (grant.revoked) continue;
    if (grant.expires_at && new Date(grant.expires_at).getTime() <= Date.now()) continue;
    if (sourceKind && grant.source?.kind !== sourceKind) continue;
    if (sourceId && grant.source?.id !== sourceId) continue;
    if (streams && streams.length) {
      const grantStreams = new Set((grant.streams || []).map((s) => s.name || s));
      if (!streams.every((s) => grantStreams.has(s))) continue;
    }
    if (readToken(cacheRoot, grant.grant_id)) return grant;
  }
  return null;
}

export async function ensureGitignore(cacheRoot) {
  const repoRoot = resolve(pdppRoot(cacheRoot), '..');
  const gitignorePath = join(repoRoot, '.gitignore');
  if (!existsSync(gitignorePath)) return;
  const content = readFileSync(gitignorePath, 'utf8');
  if (content.includes('.pdpp/') || content.includes('.pdpp\n') || content.includes('.pdpp\r')) return;
  writeFileSync(gitignorePath, content.trimEnd() + '\n.pdpp/\n');
}

export function redactGrantForDisplay(grant) {
  if (!grant) return null;
  const {
    grant_id, source, streams,
    purpose_description, purpose_code, access_mode,
    retention, expires_at, revoked, issued_at, client_id,
  } = grant;
  return {
    grant_id, source, streams,
    purpose_description, purpose_code, access_mode,
    retention, expires_at, revoked, issued_at, client_id,
  };
}
