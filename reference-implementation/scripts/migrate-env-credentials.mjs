#!/usr/bin/env node
/**
 * Env -> store credential migration.
 *
 * Moves a static-secret connector credential that currently lives in a process
 * environment variable into the encrypted per-connection credential store
 * (`connector_instance_credentials`), so the env var line can later be deleted
 * by the operator. See `tmp/workstreams/env-credential-migration-plan-2026-06-10.md`
 * (Phase 1: gmail + github; Phase 2: registry-complete static-secret entries).
 *
 * Usage:
 *   node scripts/migrate-env-credentials.mjs \
 *     --connector <amazon|chase|chatgpt|gmail|github|ynab|slack|reddit|usaa> --instance <cin_...> [--dry-run] [--force]
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
 *   - ynab/index.ts auth.required: YNAB_PERSONAL_ACCESS_TOKEN / YNAB_PAT
 *   - slack/index.ts auth.required: SLACK_WORKSPACE / SLACK_TOKEN / SLACK_COOKIE
 *   - reddit/index.ts auth.required: REDDIT_USERNAME / REDDIT_PASSWORD
 *   - chatgpt/auto-login/chatgpt.ts: CHATGPT_USERNAME / CHATGPT_PASSWORD
 *   - amazon/auto-login/amazon.ts: AMAZON_USERNAME / AMAZON_PASSWORD
 *   - chase/auto-login/chase.ts: CHASE_USERNAME / CHASE_PASSWORD
 *   - usaa/auto-login/usaa.ts: USAA_USERNAME / USAA_PASSWORD
 * This table is cross-validated at run time against the real
 * `STATIC_SECRET_CONNECTOR_REGISTRY` so it cannot silently drift.
 */
export const ENV_CREDENTIAL_SOURCES = Object.freeze({
  amazon: Object.freeze({
    credentialKind: 'username_password',
    secretFieldEnvVars: Object.freeze({
      password: Object.freeze(['AMAZON_PASSWORD']),
      username: Object.freeze(['AMAZON_USERNAME']),
    }),
  }),
  chase: Object.freeze({
    credentialKind: 'username_password',
    secretFieldEnvVars: Object.freeze({
      password: Object.freeze(['CHASE_PASSWORD']),
      username: Object.freeze(['CHASE_USERNAME']),
    }),
  }),
  chatgpt: Object.freeze({
    credentialKind: 'username_password',
    secretFieldEnvVars: Object.freeze({
      password: Object.freeze(['CHATGPT_PASSWORD']),
      username: Object.freeze(['CHATGPT_USERNAME']),
    }),
  }),
  gmail: Object.freeze({
    credentialKind: 'app_password',
    secretEnvVars: Object.freeze(['GOOGLE_APP_PASSWORD_PDPP', 'GMAIL_APP_PASSWORD']),
  }),
  github: Object.freeze({
    credentialKind: 'personal_access_token',
    secretEnvVars: Object.freeze(['GITHUB_PERSONAL_ACCESS_TOKEN', 'GITHUB_TOKEN']),
  }),
  ynab: Object.freeze({
    credentialKind: 'personal_access_token',
    secretEnvVars: Object.freeze(['YNAB_PERSONAL_ACCESS_TOKEN', 'YNAB_PAT']),
  }),
  oura: Object.freeze({
    credentialKind: 'personal_access_token',
    secretEnvVars: Object.freeze(['OURA_PERSONAL_ACCESS_TOKEN']),
  }),
  notion: Object.freeze({
    credentialKind: 'personal_access_token',
    secretEnvVars: Object.freeze(['NOTION_API_TOKEN']),
  }),
  slack: Object.freeze({
    credentialKind: 'secret_bundle',
    secretFieldEnvVars: Object.freeze({
      slack_workspace: Object.freeze(['SLACK_WORKSPACE']),
      slack_token: Object.freeze(['SLACK_TOKEN']),
      slack_cookie: Object.freeze(['SLACK_COOKIE']),
    }),
  }),
  reddit: Object.freeze({
    credentialKind: 'username_password',
    secretFieldEnvVars: Object.freeze({
      password: Object.freeze(['REDDIT_PASSWORD']),
      username: Object.freeze(['REDDIT_USERNAME']),
    }),
  }),
  usaa: Object.freeze({
    credentialKind: 'username_password',
    secretFieldEnvVars: Object.freeze({
      password: Object.freeze(['USAA_PASSWORD']),
      username: Object.freeze(['USAA_USERNAME']),
    }),
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
  const sameSingleVars = sameArray(descriptor.secretEnvVars, source.secretEnvVars);
  const sameSecretFields = sameEnvVarMap(descriptor.secretFieldEnvVars, source.secretFieldEnvVars);
  if (!(sameKind && sameSingleVars && sameSecretFields)) {
    throw new EnvCredentialMigrationError(
      'mapping_registry_drift',
      `The script's env mapping for '${connectorKey}' no longer matches ` +
        'STATIC_SECRET_CONNECTOR_REGISTRY. Refusing to migrate against a stale mapping.',
    );
  }
}

function sameArray(left, right) {
  const l = Array.isArray(left) ? left : [];
  const r = Array.isArray(right) ? right : [];
  return l.length === r.length && l.every((name, i) => name === r[i]);
}

function sameEnvVarMap(left, right) {
  const l = left && typeof left === 'object' ? left : {};
  const r = right && typeof right === 'object' ? right : {};
  const lKeys = Object.keys(l).sort();
  const rKeys = Object.keys(r).sort();
  if (!sameArray(lKeys, rKeys)) {
    return false;
  }
  return lKeys.every((key) => sameArray(l[key], r[key]));
}

function envNamesForSource(source) {
  if (Array.isArray(source.secretEnvVars) && source.secretEnvVars.length > 0) {
    return [...source.secretEnvVars];
  }
  return Object.values(source.secretFieldEnvVars ?? {}).flat();
}

// Normalize an env value the way a `.env` parser would: trim surrounding
// whitespace, then strip exactly one matching pair of surrounding quotes
// (`'…'` or `"…"`). A value sourced from a quoted env-file line
// (`YNAB_PAT='abc'`) otherwise carries the literal quotes into the sealed
// credential — the connector then sends `Bearer 'abc'` and the provider 401s.
// (This is the YNAB corruption that wedged collection: the migration sealed a
// quote-wrapped token.) Only a MATCHING pair is stripped, so a secret that
// legitimately begins or ends with a lone quote is left untouched.
function normalizeEnvSecretValue(raw) {
  const trimmed = raw.trim();
  if (
    trimmed.length >= 2 &&
    (trimmed[0] === "'" || trimmed[0] === '"') &&
    trimmed[trimmed.length - 1] === trimmed[0]
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function resolveOneEnvValue(envVars, env) {
  for (const name of envVars) {
    const value = env[name];
    if (typeof value === 'string' && value.trim().length > 0) {
      return { envVarName: name, value: normalizeEnvSecretValue(value) };
    }
  }
  return null;
}

function resolveSecretFromEnv(source, env) {
  if (Array.isArray(source.secretEnvVars) && source.secretEnvVars.length > 0) {
    const resolved = resolveOneEnvValue(source.secretEnvVars, env);
    return resolved ? { envVarName: resolved.envVarName, secret: resolved.value } : null;
  }
  const fieldEnvVars = source.secretFieldEnvVars ?? {};
  const bundle = {};
  const envVarNames = [];
  for (const [fieldName, envVars] of Object.entries(fieldEnvVars)) {
    const resolved = resolveOneEnvValue(envVars, env);
    if (!resolved) {
      return null;
    }
    bundle[fieldName] = resolved.value;
    envVarNames.push(resolved.envVarName);
  }
  return envVarNames.length > 0 ? { envVarName: envVarNames.join(', '), secret: JSON.stringify(bundle) } : null;
}

function setupFieldsFromSourceBinding(sourceBinding) {
  if (!sourceBinding || typeof sourceBinding !== 'object' || Array.isArray(sourceBinding)) {
    return {};
  }
  const raw = sourceBinding.setup_fields;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  const fields = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' && value.trim().length > 0) {
      fields[key] = value.trim();
    }
  }
  return fields;
}

function secretBundleFields(connectorKey, secret) {
  if (!secret) {
    return {};
  }
  try {
    const parsed = JSON.parse(secret);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('bundle is not an object');
    }
    return parsed;
  } catch {
    throw new EnvCredentialMigrationError(
      'secret_bundle_invalid',
      `Connector '${connectorKey}' resolved an invalid secret bundle before migration.`,
    );
  }
}

function verifyRunFragment({ connectorKey, env, fragment, instance, resolved, source }) {
  if (Array.isArray(source.secretEnvVars) && source.secretEnvVars.length > 0) {
    for (const name of source.secretEnvVars) {
      if (fragment[name] !== resolved.secret) {
        return false;
      }
    }
  }
  if (source.secretFieldEnvVars) {
    const bundle = secretBundleFields(connectorKey, resolved.secret);
    for (const [fieldName, envVars] of Object.entries(source.secretFieldEnvVars)) {
      for (const name of envVars) {
        if (fragment[name] !== bundle[fieldName]) {
          return false;
        }
      }
    }
  }
  if (source.setupFieldEnvVars) {
    const setupFields = setupFieldsFromSourceBinding(instance.sourceBinding ?? null);
    for (const [fieldName, envVars] of Object.entries(source.setupFieldEnvVars)) {
      const value = setupFields[fieldName];
      if (!value) {
        throw new EnvCredentialMigrationError(
          'source_binding_setup_field_missing',
          `Connection '${instance.connectorInstanceId}' is missing non-secret setup field '${fieldName}' in ` +
            `source_binding_json. Re-run owner setup or repair the source binding before deleting ${envNamesForSource(source).join(', ')}.`,
        );
      }
      for (const name of envVars) {
        if (fragment[name] !== value) {
          return false;
        }
        const envValue = env[name];
        if (typeof envValue === 'string' && envValue.trim().length > 0 && envValue.trim() !== value) {
          throw new EnvCredentialMigrationError(
            'source_binding_setup_field_mismatch',
            `Connection '${instance.connectorInstanceId}' source binding field '${fieldName}' does not match ${name}. ` +
              'Repair the source binding before deleting the env var.',
          );
        }
      }
    }
  }
  return true;
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
      `None of ${envNamesForSource(source).join(', ')} is set in the process environment; ` +
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
  const verified = verifyRunFragment({ connectorKey, env, fragment, instance, resolved, source });
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
        'Usage: node scripts/migrate-env-credentials.mjs --connector <amazon|chase|chatgpt|gmail|github|ynab|slack|reddit|usaa> --instance <cin_...> [--dry-run] [--force]\n',
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
