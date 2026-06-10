#!/usr/bin/env node
/**
 * Tier-1 env -> store credential migration.
 *
 * Moves a static-secret connector credential that currently lives in a process
 * environment variable into the encrypted per-connection credential store
 * (`connector_instance_credentials`), so the env var line can later be deleted
 * by the operator. See `tmp/workstreams/env-credential-migration-plan-2026-06-10.md`
 * (Phase 1: gmail + github, the only `STATIC_SECRET_CONNECTOR_REGISTRY` members).
 *
 * Usage:
 *   node scripts/migrate-env-credentials.mjs \
 *     --connector <gmail|github> --instance <cin_...> [--dry-run] [--force]
 *
 * Backend selection mirrors the server: `PDPP_DATABASE_URL`/`PDPP_STORAGE_BACKEND`
 * selects Postgres; otherwise `PDPP_DB_PATH` selects SQLite. The encryption key
 * comes from `PDPP_CREDENTIAL_ENCRYPTION_KEY` (or `_FILE`) exactly as in the
 * server's capture route — the script holds no key handling of its own.
 *
 * Secret hygiene (load-bearing): the credential VALUE is read from the process
 * env, sealed via the real store module, and verified by an in-process
 * round-trip. It is never printed, logged, or returned. All output is
 * metadata-only (instance id, kind, status, timestamps, source env var NAME).
 *
 * Idempotent: refuses to overwrite an existing stored credential unless
 * `--force` is passed (a forced overwrite is a rotation; `rotated_at` is set).
 */

import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

import { closeDb, initDb } from '../server/db.js';
import {
  closePostgresStorage,
  initPostgresStorage,
  resolveStorageBackend,
} from '../server/postgres-storage.js';
import {
  createPostgresConnectorInstanceCredentialStore,
  createSqliteConnectorInstanceCredentialStore,
} from '../server/stores/connector-instance-credential-store.js';
import {
  createPostgresConnectorInstanceStore,
  createSqliteConnectorInstanceStore,
} from '../server/stores/connector-instance-store.js';
import { resolveStaticSecretRunEnv } from '../server/stores/static-secret-run-credentials.js';

/**
 * Env-var source mapping, per the migration plan §2 ("Resolution-order facts").
 * Ground truth is each connector's own code:
 *   - gmail/index.ts `resolveGmailPasswordFromEnv`: GOOGLE_APP_PASSWORD_PDPP / GMAIL_APP_PASSWORD
 *   - github/index.ts auth.required: GITHUB_PERSONAL_ACCESS_TOKEN / GITHUB_TOKEN
 * This table is cross-validated at run time against the real
 * `STATIC_SECRET_CONNECTOR_REGISTRY` so it cannot silently drift.
 */
export const ENV_CREDENTIAL_SOURCES = Object.freeze({
  gmail: Object.freeze({
    credentialKind: 'app_password',
    secretEnvVars: Object.freeze(['GOOGLE_APP_PASSWORD_PDPP', 'GMAIL_APP_PASSWORD']),
  }),
  github: Object.freeze({
    credentialKind: 'personal_access_token',
    secretEnvVars: Object.freeze(['GITHUB_PERSONAL_ACCESS_TOKEN', 'GITHUB_TOKEN']),
  }),
});

export class EnvCredentialMigrationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EnvCredentialMigrationError';
    this.code = code;
  }
}

/** Exit code for the idempotency refusal so callers can distinguish it. */
export const EXIT_REFUSED_EXISTING = 2;

async function loadInjectionHelpers() {
  // The real registry + injection mapping (TypeScript; node >= 23.6 strips
  // types natively — the server imports the same file the same way).
  const mod = await import('../../packages/polyfill-connectors/src/static-secret-injection.ts');
  return {
    isStaticSecretConnector: mod.isStaticSecretConnector,
    buildConnectionScopedSecretEnv: mod.buildConnectionScopedSecretEnv,
    registry: mod.STATIC_SECRET_CONNECTOR_REGISTRY,
  };
}

function assertMappingMatchesRegistry(connectorKey, source, registry) {
  const descriptor = registry[connectorKey];
  if (!descriptor) {
    throw new EnvCredentialMigrationError(
      'not_a_static_secret_connector',
      `Connector '${connectorKey}' is not in STATIC_SECRET_CONNECTOR_REGISTRY; ` +
        'it has no store-injection path, so an env->store migration would be inert.',
    );
  }
  const sameKind = descriptor.credentialKind === source.credentialKind;
  const sameVars =
    descriptor.secretEnvVars.length === source.secretEnvVars.length &&
    descriptor.secretEnvVars.every((name, i) => name === source.secretEnvVars[i]);
  if (!(sameKind && sameVars)) {
    throw new EnvCredentialMigrationError(
      'mapping_registry_drift',
      `The script's env mapping for '${connectorKey}' no longer matches ` +
        'STATIC_SECRET_CONNECTOR_REGISTRY. Refusing to migrate against a stale mapping.',
    );
  }
}

function resolveSecretFromEnv(source, env) {
  for (const name of source.secretEnvVars) {
    const value = env[name];
    if (typeof value === 'string' && value.trim().length > 0) {
      return { envVarName: name, secret: value };
    }
  }
  return null;
}

/**
 * Core migration, dependency-injected so the colocated test can drive it
 * against a throwaway SQLite store. Returns a metadata-only summary; the
 * secret never appears in the return value or in `log` output.
 */
export async function migrateEnvCredential({
  connectorKey,
  connectorInstanceId,
  dryRun = false,
  force = false,
  env,
  credentialStore,
  connectorInstanceStore,
  injection,
  now = () => new Date().toISOString(),
  log = (line) => process.stdout.write(`${line}\n`),
}) {
  const source = ENV_CREDENTIAL_SOURCES[connectorKey];
  if (!source) {
    throw new EnvCredentialMigrationError(
      'unknown_connector',
      `No env-credential mapping for connector '${connectorKey}'. ` +
        `Known: ${Object.keys(ENV_CREDENTIAL_SOURCES).join(', ')}.`,
    );
  }
  assertMappingMatchesRegistry(connectorKey, source, injection.registry);

  const instance = await connectorInstanceStore.get(connectorInstanceId);
  if (!instance) {
    throw new EnvCredentialMigrationError(
      'connector_instance_not_found',
      `Connector instance '${connectorInstanceId}' does not exist.`,
    );
  }
  if (instance.connectorId !== connectorKey) {
    // Guard against sealing one connector's secret onto another connector's
    // connection (e.g. a gmail app password onto the github instance).
    throw new EnvCredentialMigrationError(
      'connector_instance_mismatch',
      `Instance '${connectorInstanceId}' belongs to connector '${instance.connectorId}', ` +
        `not '${connectorKey}'.`,
    );
  }
  if (instance.status !== 'active' && instance.status !== 'draft') {
    throw new EnvCredentialMigrationError(
      'connector_instance_inactive',
      `Instance '${connectorInstanceId}' has status '${instance.status}'; ` +
        'only active or draft connections accept a credential migration.',
    );
  }

  const resolved = resolveSecretFromEnv(source, env);
  if (!resolved) {
    throw new EnvCredentialMigrationError(
      'env_secret_missing',
      `None of ${source.secretEnvVars.join(', ')} is set in the process environment; ` +
        'nothing to migrate.',
    );
  }

  const existing = await credentialStore.getMetadata(connectorInstanceId);
  if (existing && !force) {
    throw new EnvCredentialMigrationError(
      'credential_already_present',
      `A '${existing.credentialKind}' credential (status '${existing.status}') already exists for ` +
        `'${connectorInstanceId}' (captured_at ${existing.capturedAt}). ` +
        'Pass --force to rotate it.',
    );
  }

  const action = existing ? 'rotate' : 'capture';
  if (dryRun) {
    log(`[dry-run] would ${action} '${source.credentialKind}' credential for ${connectorInstanceId}`);
    log(`[dry-run]   connector:       ${connectorKey}`);
    log(`[dry-run]   source env var:  ${resolved.envVarName} (value present, not shown)`);
    log(`[dry-run]   owner subject:   ${instance.ownerSubjectId}`);
    log(`[dry-run]   existing row:    ${existing ? `yes (captured_at ${existing.capturedAt})` : 'none'}`);
    return { action: 'dry_run', plannedAction: action, envVarName: resolved.envVarName, metadata: existing };
  }

  const metadata = await credentialStore.capture({
    connectorInstanceId,
    ownerSubjectId: instance.ownerSubjectId,
    credentialKind: source.credentialKind,
    secret: resolved.secret,
    now: now(),
  });

  // Round-trip verification through the REAL run seam: recover the sealed
  // secret via resolveStaticSecretRunEnv (store -> decrypt -> env fragment)
  // and confirm every injected env var carries exactly the value we sourced.
  // This proves the stored row decrypts under the configured key and that the
  // run-time resolution path serves the STORE value. Only the boolean is
  // reported.
  const fragment = await resolveStaticSecretRunEnv({
    connectorId: connectorKey,
    connectorInstanceId,
    ownerSubjectId: instance.ownerSubjectId,
    sourceBinding: instance.sourceBinding ?? null,
    credentialStore,
    isStaticSecretConnector: injection.isStaticSecretConnector,
    buildConnectionScopedSecretEnv: injection.buildConnectionScopedSecretEnv,
  });
  const verified = source.secretEnvVars.every((name) => fragment[name] === resolved.secret);
  if (!verified) {
    throw new EnvCredentialMigrationError(
      'roundtrip_verification_failed',
      `Stored credential for '${connectorInstanceId}' did not round-trip through ` +
        'resolveStaticSecretRunEnv to the sourced value. Investigate before deleting any env var.',
    );
  }

  log(`${action === 'rotate' ? 'rotated' : 'captured'} '${metadata.credentialKind}' credential for ${connectorInstanceId}`);
  log(`  connector:        ${connectorKey}`);
  log(`  source env var:   ${resolved.envVarName} (value not shown)`);
  log(`  owner subject:    ${metadata.ownerSubjectId}`);
  log(`  status:           ${metadata.status}`);
  log(`  captured_at:      ${metadata.capturedAt}`);
  log(`  rotated_at:       ${metadata.rotatedAt ?? '-'}`);
  log(`  store round-trip: verified (store-resolved secret matches env source)`);
  return { action, envVarName: resolved.envVarName, metadata, verified };
}

async function main() {
  const { values } = parseArgs({
    options: {
      connector: { type: 'string' },
      instance: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
    },
  });
  if (!values.connector || !values.instance) {
    process.stderr.write(
      'Usage: node scripts/migrate-env-credentials.mjs --connector <gmail|github> --instance <cin_...> [--dry-run] [--force]\n',
    );
    process.exit(1);
  }

  const backendConfig = resolveStorageBackend({ env: process.env });
  let credentialStore;
  let connectorInstanceStore;
  let teardown;
  if (backendConfig.backend === 'postgres') {
    // Same init the server runs at boot (schema bootstrap is idempotent).
    await initPostgresStorage(backendConfig);
    credentialStore = createPostgresConnectorInstanceCredentialStore();
    connectorInstanceStore = createPostgresConnectorInstanceStore();
    teardown = () => closePostgresStorage();
  } else {
    const dbPath = process.env.PDPP_DB_PATH;
    if (!dbPath) {
      process.stderr.write(
        'SQLite backend requires PDPP_DB_PATH (or set PDPP_DATABASE_URL for Postgres).\n',
      );
      process.exit(1);
    }
    initDb(dbPath);
    credentialStore = createSqliteConnectorInstanceCredentialStore();
    connectorInstanceStore = createSqliteConnectorInstanceStore();
    teardown = () => closeDb();
  }

  try {
    const injection = await loadInjectionHelpers();
    await migrateEnvCredential({
      connectorKey: values.connector,
      connectorInstanceId: values.instance,
      dryRun: values['dry-run'],
      force: values.force,
      env: process.env,
      credentialStore,
      connectorInstanceStore,
      injection,
    });
  } catch (err) {
    if (err instanceof EnvCredentialMigrationError) {
      process.stderr.write(`${err.code}: ${err.message}\n`);
      process.exitCode = err.code === 'credential_already_present' ? EXIT_REFUSED_EXISTING : 1;
      return;
    }
    // Never let a foreign error accidentally serialize a secret-bearing
    // context object: report name/message only.
    process.stderr.write(`${err?.name ?? 'Error'}: ${err?.message ?? 'unknown error'}\n`);
    process.exitCode = 1;
  } finally {
    await teardown();
  }
}

const isDirectInvocation =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectInvocation) {
  await main();
}
