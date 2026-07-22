// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// First-boot credential bootstrap for the standalone Core image
// (Dockerfile targets `railway-core` / `platform-core`).
//
// Managed platforms make owner credentials a deploy-time prompt (Railway) or a
// launch flag (Fly). A bare `docker run` has neither, and the runtime's
// fallback for a missing PDPP_OWNER_PASSWORD is owner auth DISABLED — which
// must never be the out-of-the-box posture of a self-hosted node. So the
// supervisor calls this module before starting the reference and console:
//
//   - PDPP_OWNER_PASSWORD set        -> no-op; the environment always wins.
//   - persisted password on the data  -> reused silently (one non-secret log
//     volume                            line; the password itself is never
//                                       reprinted after first boot).
//   - neither                        -> generate one, persist it to the data
//                                       volume so restarts keep it, and print
//                                       a one-time first-boot banner with the
//                                       dashboard URL and the password.
//
// When storage resolves to SQLite (the quickstart's zero-config default), a
// credential encryption key is provisioned the same way so owner-captured
// static-secret connector setup works without extra flags — the Docker
// equivalent of the Railway template's generated
// PDPP_CREDENTIAL_ENCRYPTION_KEY. The key is never printed. Postgres deploys
// keep the explicit fail-closed key contract (see
// reference-implementation/server/stores/credential-encryption.js).
//
// The password appears exactly once, in the first-boot banner on stdout
// (`docker logs`), and in the mode-0600 file on the data volume. It is never
// logged anywhere else and never passed via argv.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_DATA_DIR = '/var/lib/pdpp';
export const OWNER_PASSWORD_FILENAME = 'owner-password';
export const CREDENTIAL_KEY_FILENAME = 'credential-encryption-key';

const LOG_PREFIX = '[railway-core]';
const BANNER_RULE = '─'.repeat(64);

function trimmedValue(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// The directory that holds generated secrets. Default it to the SQLite
// database's directory: the quickstart mounts exactly one named volume there,
// so "keep the database" and "keep the credentials" are the same operator act.
export function resolveDataDir(env = process.env) {
  const dbPath = trimmedValue(env.PDPP_DB_PATH);
  if (dbPath && dbPath !== ':memory:') {
    return path.dirname(dbPath);
  }
  return DEFAULT_DATA_DIR;
}

// Mirrors resolveStorageBackend in
// reference-implementation/server/postgres-storage.js: explicit
// PDPP_STORAGE_BACKEND wins, otherwise a database URL selects Postgres.
function usesPostgresStorage(env) {
  const explicit = trimmedValue(env.PDPP_STORAGE_BACKEND)?.toLowerCase();
  if (explicit === 'postgres') return true;
  if (explicit === 'sqlite') return false;
  return Boolean(trimmedValue(env.PDPP_DATABASE_URL) ?? trimmedValue(env.DATABASE_URL));
}

function readPersistedSecret(file) {
  if (!existsSync(file)) return null;
  try {
    return trimmedValue(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function persistSecret(dataDir, file, secret) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, `${secret}\n`, { mode: 0o600 });
}

export function buildFirstBootBanner({ origin, password, passwordFile, persisted }) {
  const lines = [
    BANNER_RULE,
    'First boot — generated an owner password for this instance.',
    '',
    `  Dashboard:      ${origin}/`,
    `  Owner password: ${password}`,
    '',
  ];
  if (persisted) {
    lines.push(
      `Saved to ${passwordFile} (on the data volume), so restarts keep`,
      'this password. To change it, set the PDPP_OWNER_PASSWORD environment',
      'variable and restart; the environment variable always wins.',
      'This password is printed only on first boot.',
    );
  } else {
    lines.push(
      'WARNING: the password could not be persisted and will change on the',
      'next boot. Set PDPP_OWNER_PASSWORD to keep a stable password.',
    );
  }
  lines.push(BANNER_RULE);
  return lines.map((line) => (line ? `${LOG_PREFIX} ${line}` : LOG_PREFIX));
}

/**
 * Resolve first-boot credentials. Returns env additions for the supervised
 * children plus the one-time banner lines (empty on every boot after the
 * first, and always empty when PDPP_OWNER_PASSWORD is supplied).
 */
export function prepareFirstBoot({
  env = process.env,
  dataDir = resolveDataDir(env),
  log = console.log,
  warn = console.error,
} = {}) {
  const envAdditions = {};
  let bannerLines = [];

  if (!trimmedValue(env.PDPP_OWNER_PASSWORD)) {
    const passwordFile = path.join(dataDir, OWNER_PASSWORD_FILENAME);
    let password = readPersistedSecret(passwordFile);
    if (password) {
      log(`${LOG_PREFIX} owner password loaded from ${passwordFile}`);
    } else {
      password = randomBytes(18).toString('base64url');
      let persisted = true;
      try {
        persistSecret(dataDir, passwordFile, password);
      } catch (err) {
        persisted = false;
        warn(
          `${LOG_PREFIX} warning: could not persist the generated owner password to ${passwordFile} (${err?.code || err?.message}); it will be regenerated on the next boot`,
        );
      }
      const origin = (trimmedValue(env.PDPP_REFERENCE_ORIGIN) || 'http://localhost:3000').replace(/\/+$/, '');
      bannerLines = buildFirstBootBanner({ origin, password, passwordFile, persisted });
    }
    envAdditions.PDPP_OWNER_PASSWORD = password;
  }

  if (
    !usesPostgresStorage(env) &&
    !trimmedValue(env.PDPP_CREDENTIAL_ENCRYPTION_KEY) &&
    !trimmedValue(env.PDPP_CREDENTIAL_ENCRYPTION_KEY_FILE)
  ) {
    const keyFile = path.join(dataDir, CREDENTIAL_KEY_FILENAME);
    try {
      if (!readPersistedSecret(keyFile)) {
        persistSecret(dataDir, keyFile, randomBytes(32).toString('hex'));
        log(
          `${LOG_PREFIX} generated a credential encryption key at ${keyFile} (never printed; keep the data volume to keep sealed credentials readable)`,
        );
      }
      envAdditions.PDPP_CREDENTIAL_ENCRYPTION_KEY_FILE = keyFile;
    } catch (err) {
      warn(
        `${LOG_PREFIX} warning: could not provision a credential encryption key at ${keyFile} (${err?.code || err?.message}); static-secret connector setup stays fail-closed until PDPP_CREDENTIAL_ENCRYPTION_KEY is configured`,
      );
    }
  }

  return { env: envAdditions, bannerLines };
}
