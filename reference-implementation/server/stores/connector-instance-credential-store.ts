// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { exec, getOne, type MutationQuery, type RegisteredQuery, referenceQueries } from "../../lib/db.ts";
import { getDb } from "../db.ts";
import { type PostgresTransactionClient, postgresQuery } from "../postgres-storage.ts";
import {
  CredentialEncryptionError as CredentialEncryptionErrorClass,
  createCredentialCipherFromEnv,
} from "./credential-encryption.ts";

export const CredentialEncryptionError = CredentialEncryptionErrorClass;

interface CredentialRow {
  captured_at: string;
  connector_instance_id: string;
  credential_kind: string;
  fingerprint: string | null;
  owner_subject_id: string;
  rejected_at: string | null;
  rejection_reason: string | null;
  revoked_at: string | null;
  rotated_at: string | null;
  sealed_secret?: string;
  state_change_json: Record<string, unknown> | string | null;
  status: string;
}

function isMutationQuery(query: RegisteredQuery): query is MutationQuery {
  return query.terminator === "exec";
}

export interface CredentialMetadata {
  capturedAt: string;
  connectorInstanceId: string;
  credentialKind: string;
  fingerprint: string | null;
  ownerSubjectId: string;
  present: true;
  rejected: boolean;
  rejectedAt: string | null;
  rejectionReason: string | null;
  revokedAt: string | null;
  rotatedAt: string | null;
  stateChange: CredentialStateChange | null;
  status: string;
}

// Stable, assertion-friendly explanations for the latest credential state
// transition. The actor is deliberately separate and nullable: provenance that
// was not available to a writer must remain unknown rather than be inferred
// from ownership or timing.
export const CREDENTIAL_STATE_CHANGE_CAUSES = Object.freeze([
  "credential_captured",
  "credential_rotated",
  "credential_revoked",
  "connection_revoked",
  "duplicate_static_secret_identity",
  "owner_abandoned",
  "owner_revoked",
  "provider_rejected",
  "ttl_expired",
]);
export type CredentialStateChangeCause = (typeof CREDENTIAL_STATE_CHANGE_CAUSES)[number];
const VALID_STATE_CHANGE_CAUSES = new Set<string>(CREDENTIAL_STATE_CHANGE_CAUSES);

export interface CredentialStateChange {
  readonly actorId?: string;
  readonly actorType?: string;
  readonly cause: CredentialStateChangeCause;
  readonly interactionId?: string;
  readonly requestId?: string;
  readonly runId?: string;
  readonly traceId?: string;
}

interface CaptureCredentialArgs {
  connectorInstanceId: string;
  credentialKind: string;
  now: string;
  ownerSubjectId: string;
  secret: string;
  stateChange?: CredentialStateChange;
}

interface CredentialWriteRecord {
  capturedAt: string;
  connectorInstanceId: string;
  credentialKind: string;
  fingerprint: string | null;
  ownerSubjectId: string;
  rejectedAt: string | null;
  rejectionReason: string | null;
  revokedAt: string | null;
  rotatedAt: string | null;
  sealedSecret: string;
  stateChange: CredentialStateChange;
  status: "active";
}

interface CredentialStoreRead {
  getRaw: (connectorInstanceId: string) => Promise<CredentialRow | null>;
  getRawByInstanceIds?: (connectorInstanceIds: readonly string[]) => Promise<CredentialRow[]>;
}

interface CredentialStoreRun {
  delete: (connectorInstanceId: string) => Promise<void>;
  markRejected: (args: {
    connectorInstanceId: string;
    rejectedAt: string;
    reason: string | null;
    stateChange: CredentialStateChange;
  }) => Promise<void>;
  revoke: (args: {
    connectorInstanceId: string;
    revokedAt: string;
    stateChange: CredentialStateChange;
  }) => Promise<void>;
  upsert: (record: CredentialWriteRecord) => Promise<void>;
}

/**
 * Revoke the credential bound to one connection using the caller's Postgres
 * transaction. Connection lifecycle writes use this to make a connection
 * revoke and its credential revoke one durable state transition.
 *
 * The status predicate deliberately preserves the first revocation timestamp:
 * a retry must not make an older revoke look newer.
 */
export async function revokePostgresConnectorInstanceCredentialsWithClient(
  client: PostgresTransactionClient,
  {
    connectorInstanceId,
    revokedAt,
    stateChange,
  }: {
    connectorInstanceId: string;
    revokedAt: string;
    stateChange: CredentialStateChange;
  }
): Promise<void> {
  await client.query(
    `UPDATE connector_instance_credentials
     SET status = 'revoked', revoked_at = $1, rejected_at = NULL, rejection_reason = NULL,
         state_change_json = $2::jsonb
     WHERE connector_instance_id = $3 AND status <> 'revoked'`,
    [revokedAt, serializeCredentialStateChange(stateChange), connectorInstanceId]
  );
}

export interface ConnectorInstanceCredentialStore {
  capture: (args: CaptureCredentialArgs) => Promise<CredentialMetadata | null>;
  delete: (connectorInstanceId: string) => Promise<boolean>;
  /**
   * Non-secret, key-derived fingerprint of a candidate plaintext, for proving
   * "is this the exact same credential already stored" without sealing or
   * persisting anything. Same derivation `capture` uses; a pure read.
   */
  fingerprintCandidate: (secret: string) => string | null;
  getMetadata: (connectorInstanceId: string) => Promise<CredentialMetadata | null>;
  /** Non-secret metadata keyed by exact instance id. Empty input performs no SQL. */
  getMetadataByInstanceIds: (connectorInstanceIds: readonly string[]) => Promise<Map<string, CredentialMetadata>>;
  hasActiveCredential: (connectorInstanceId: string) => Promise<boolean>;
  markRejected: (args: {
    connectorInstanceId: string;
    rejectedAt: string;
    reason: string | null;
    stateChange?: CredentialStateChange;
  }) => Promise<CredentialMetadata | null>;
  recoverSecret: (args: {
    connectorInstanceId: string;
    ownerSubjectId: string;
  }) => Promise<{ credentialKind: string; secret: string }>;
  revoke: (args: {
    connectorInstanceId: string;
    now: string;
    stateChange?: CredentialStateChange;
  }) => Promise<CredentialMetadata | null>;
}

/**
 * Per-connection encrypted static-secret credential store.
 *
 * A credential is instance-scoped to exactly one connector instance
 * (`connector_instance_id`, equivalently the owner-facing `connection_id`). It
 * holds a connector-declared static provider secret sealed at rest under the
 * owner/operator-held key (`credential-encryption.ts`). The plaintext is
 * recoverable ONLY through
 * {@link recoverSecret}, which the orchestrator calls to inject the secret into a
 * single connection-scoped connector run. No read projection, audit record, or
 * error message ever carries the plaintext.
 *
 * Lifecycle (design Decision 7) is kept distinct from the connection lifecycle:
 *   - capture / rotate: write or replace the sealed secret (status active);
 *   - reject: flip status to 'rejected' after the provider definitively refuses
 *     the stored secret; future runs fail closed until owner re-capture;
 *   - revoke: flip status to 'revoked' so runs fail closed, without deleting the
 *     connection or its records;
 *   - delete: remove the row entirely so no orphaned secret survives a deleted
 *     connection.
 * A revoked or deleted credential never implicitly resurrects: recovery requires
 * an explicit owner re-capture.
 */

export const CREDENTIAL_KINDS = Object.freeze([
  "access_token",
  "api_key",
  "app_password",
  "personal_access_token",
  "secret_bundle",
  "username_password",
]);
const VALID_KINDS = new Set(CREDENTIAL_KINDS);

export class ConnectorInstanceCredentialError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ConnectorInstanceCredentialError";
    this.code = code;
  }
}

function assertRecoveryOwnerSubjectId(ownerSubjectId: unknown): asserts ownerSubjectId is string {
  if (typeof ownerSubjectId !== "string" || ownerSubjectId.trim().length === 0) {
    throw new ConnectorInstanceCredentialError(
      "owner_subject_required",
      "ownerSubjectId is required to recover a credential."
    );
  }
}

function assertCaptureArgs({
  connectorInstanceId,
  ownerSubjectId,
  credentialKind,
  secret,
}: Omit<CaptureCredentialArgs, "now">): void {
  if (typeof connectorInstanceId !== "string" || !connectorInstanceId) {
    throw new ConnectorInstanceCredentialError(
      "connector_instance_required",
      "connectorInstanceId is required to capture a credential."
    );
  }
  if (typeof ownerSubjectId !== "string" || !ownerSubjectId) {
    throw new ConnectorInstanceCredentialError(
      "owner_subject_required",
      "ownerSubjectId is required to capture a credential."
    );
  }
  if (!VALID_KINDS.has(credentialKind)) {
    throw new ConnectorInstanceCredentialError(
      "credential_kind_invalid",
      `credentialKind must be one of ${CREDENTIAL_KINDS.join(", ")}.`
    );
  }
  if (typeof secret !== "string" || secret.length === 0) {
    throw new ConnectorInstanceCredentialError(
      "credential_secret_invalid",
      "A non-empty secret is required to capture a credential."
    );
  }
  if (isUnusableSecretShape(secret)) {
    throw new ConnectorInstanceCredentialError(
      "credential_secret_invalid",
      "That value is a mask or placeholder, not a secret. Type the real value, or leave the field alone to keep the stored one."
    );
  }
}

/**
 * A mask is a RENDERING of a secret, never a secret. Sealing one is the system
 * lying to itself about holding a credential.
 *
 * Reproduced 2026-08-26 against the real store: `"{}"`, `"••••••••"`,
 * `"unchanged"`, and eight spaces were ALL accepted and sealed, and
 * `recoverSecret` returned them as the owner's password. The only guard was
 * `length === 0`, which none of them trip.
 *
 * The owner-visible cost of getting this wrong is not an error message. A
 * login runs with eight spaces as the password, the provider rejects it, the
 * connection reads as broken credentials, and the owner is asked to re-enter a
 * password that was never stored — while the real one may still be in the
 * form, masked. Repeated automated attempts with a junk secret are also how an
 * account gets locked or rate-limited.
 *
 * The rule is deliberately SHAPE-based, not substring-based:
 *   - whitespace-only, in any combination, is never a secret someone typed;
 *   - a value made ENTIRELY of mask glyphs is a rendering, not a value;
 *   - a small set of exact placeholder literals are form/serialization
 *     artifacts, matched whole and case-insensitively.
 *
 * A password that merely CONTAINS one of these (`myUnchangedP@ss`) is a
 * password someone actually chose and is accepted — refusing it would be a new
 * defect wearing a fix's clothes. Nothing here trims or rewrites: a value with
 * real content is stored exactly as typed, so a deliberate trailing space
 * survives.
 */
const MASK_GLYPHS_ONLY = /^[\s*•·●◦∙×xX#?]+$/u;
const PLACEHOLDER_LITERALS: ReadonlySet<string> = new Set([
  "{}",
  "[]",
  "null",
  "undefined",
  "unchanged",
  "[redacted]",
  "redacted",
  "<redacted>",
  "***",
]);
// Deliberately NOT listed: "password", "changeme", and similar weak-but-real
// values. They are bad passwords, not masks or placeholders — and if that is
// genuinely what a provider account uses, refusing to store it would lock the
// owner out of his own data to make a point about password strength. This
// guard exists to stop the system sealing a value that CANNOT be a credential,
// not to judge the ones that can.

function isUnusableSecretShape(secret: string): boolean {
  if (secret.trim().length === 0) {
    return true;
  }
  if (MASK_GLYPHS_ONLY.test(secret)) {
    return true;
  }
  return PLACEHOLDER_LITERALS.has(secret.trim().toLowerCase());
}

function optionalStateChangeValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeStateChange(value: CredentialStateChange): CredentialStateChange {
  if (!VALID_STATE_CHANGE_CAUSES.has(value.cause)) {
    throw new ConnectorInstanceCredentialError(
      "credential_state_change_cause_invalid",
      `Credential state-change cause must be one of ${CREDENTIAL_STATE_CHANGE_CAUSES.join(", ")}.`
    );
  }
  // Each optional field is OMITTED when it is absent or blank, never written
  // as `undefined` or defaulted to a placeholder. An unattributed change must
  // read back as unattributed; inventing a plausible actor would make a guess
  // indistinguishable from a fact.
  const actorId = optionalStateChangeValue(value.actorId);
  const actorType = optionalStateChangeValue(value.actorType);
  const interactionId = optionalStateChangeValue(value.interactionId);
  const requestId = optionalStateChangeValue(value.requestId);
  const runId = optionalStateChangeValue(value.runId);
  const traceId = optionalStateChangeValue(value.traceId);
  return {
    ...(actorId === undefined ? {} : { actorId }),
    ...(actorType === undefined ? {} : { actorType }),
    cause: value.cause,
    ...(interactionId === undefined ? {} : { interactionId }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(runId === undefined ? {} : { runId }),
    ...(traceId === undefined ? {} : { traceId }),
  };
}

/** Validate and serialize non-secret state-transition provenance for storage. */
export function serializeCredentialStateChange(value: CredentialStateChange): string {
  return JSON.stringify(normalizeStateChange(value));
}

function parseStateChange(value: CredentialRow["state_change_json"]): CredentialStateChange | null {
  const parsed =
    typeof value === "string"
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return null;
          }
        })()
      : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.cause !== "string" || !VALID_STATE_CHANGE_CAUSES.has(record.cause)) {
    return null;
  }
  // normalizeStateChange trims and omits each optional field, so the raw
  // values are handed over as-is rather than pre-widened to `undefined`.
  const actorId = optionalStateChangeValue(record.actorId);
  const actorType = optionalStateChangeValue(record.actorType);
  const interactionId = optionalStateChangeValue(record.interactionId);
  const requestId = optionalStateChangeValue(record.requestId);
  const runId = optionalStateChangeValue(record.runId);
  const traceId = optionalStateChangeValue(record.traceId);
  return normalizeStateChange({
    ...(actorId === undefined ? {} : { actorId }),
    ...(actorType === undefined ? {} : { actorType }),
    cause: record.cause as CredentialStateChangeCause,
    ...(interactionId === undefined ? {} : { interactionId }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(runId === undefined ? {} : { runId }),
    ...(traceId === undefined ? {} : { traceId }),
  });
}

/**
 * Project a stored row to NON-SECRET metadata only. This is the single shape any
 * read surface (REST, MCP, console) may return. `sealed_secret` is deliberately
 * excluded — it must never cross this boundary. `fingerprint` is a key-derived,
 * non-reversible diagnostic that distinguishes "the secret changed" from
 * "unchanged" without revealing bytes.
 */
function projectMetadata(row: CredentialRow | null): CredentialMetadata | null {
  if (!row) {
    return null;
  }
  return {
    capturedAt: row.captured_at,
    connectorInstanceId: row.connector_instance_id,
    credentialKind: row.credential_kind,
    fingerprint: row.fingerprint ?? null,
    ownerSubjectId: row.owner_subject_id,
    present: true,
    rejected: row.status === "rejected",
    rejectedAt: row.rejected_at ?? null,
    rejectionReason: row.rejection_reason ?? null,
    revokedAt: row.revoked_at ?? null,
    rotatedAt: row.rotated_at ?? null,
    stateChange: parseStateChange(row.state_change_json),
    status: row.status,
  };
}

function buildStore({
  run,
  read,
  cipherFactory,
}: {
  cipherFactory: typeof createCredentialCipherFromEnv;
  read: CredentialStoreRead;
  run: CredentialStoreRun;
}): ConnectorInstanceCredentialStore {
  function cipher() {
    // Built per-operation so a key configured after process start, or rotated in
    // tests, is always picked up — and so the fail-closed error surfaces at the
    // exact capture/recover call rather than at store construction.
    return cipherFactory();
  }

  const store: ConnectorInstanceCredentialStore = {
    /**
     * Capture (first write) or rotate (replace) the credential for one instance.
     * Seals the plaintext under the operator key before it touches storage; the
     * plaintext is discarded immediately after sealing.
     *
     * Rotation preserves the connection — only the sealed bytes, fingerprint, and
     * a rotation timestamp change. A rotation always re-activates the credential
     * (an explicit owner re-capture is the sanctioned resurrection path).
     */
    async capture({
      connectorInstanceId,
      ownerSubjectId,
      credentialKind,
      secret,
      now,
      stateChange,
    }: CaptureCredentialArgs) {
      assertCaptureArgs({ connectorInstanceId, credentialKind, ownerSubjectId, secret });
      const c = cipher();
      const sealed = c.seal(secret);
      const fingerprint = c.fingerprint(secret);
      const existing = await read.getRaw(connectorInstanceId);
      const capturedAt = existing ? existing.captured_at : now;
      const rotatedAt = existing ? now : null;
      await run.upsert({
        capturedAt,
        connectorInstanceId,
        credentialKind,
        fingerprint,
        ownerSubjectId,
        rejectedAt: null,
        rejectionReason: null,
        revokedAt: null,
        rotatedAt,
        sealedSecret: sealed,
        stateChange: stateChange ?? { cause: existing ? "credential_rotated" : "credential_captured" },
        status: "active",
      });
      return store.getMetadata(connectorInstanceId);
    },

    /**
     * Delete the stored credential entirely so no orphaned secret survives. Used
     * by the connection-delete cascade. Returns true when a row was removed.
     */
    async delete(connectorInstanceId: string) {
      const existed = Boolean(await read.getRaw(connectorInstanceId));
      await run.delete(connectorInstanceId);
      return existed;
    },

    fingerprintCandidate(secret: string) {
      return cipher().fingerprint(secret);
    },

    /** Non-secret metadata for one instance, or null when no credential exists. */
    async getMetadata(connectorInstanceId: string) {
      return projectMetadata(await read.getRaw(connectorInstanceId));
    },

    async getMetadataByInstanceIds(connectorInstanceIds: readonly string[]) {
      const ids = [...new Set(connectorInstanceIds.filter((id) => typeof id === "string" && id.length > 0))];
      if (ids.length === 0) {
        return new Map<string, CredentialMetadata>();
      }
      const rows = read.getRawByInstanceIds
        ? await read.getRawByInstanceIds(ids)
        : await Promise.all(ids.map((id) => read.getRaw(id))).then((values) =>
            values.filter((row): row is CredentialRow => row !== null)
          );
      const result = new Map<string, CredentialMetadata>();
      for (const row of rows) {
        const metadata = projectMetadata(row);
        if (metadata) {
          result.set(metadata.connectorInstanceId, metadata);
        }
      }
      return result;
    },

    /** True when an active credential exists for the instance. */
    async hasActiveCredential(connectorInstanceId: string) {
      const row = await read.getRaw(connectorInstanceId);
      return Boolean(row && row.status === "active");
    },

    /**
     * Mark the stored credential as provider-rejected after a run that actually
     * used the stored secret receives a definitive invalid-credential response.
     * This is distinct from revoke: the owner did not choose to disable the
     * connection, but stale bytes must not be retried indefinitely.
     */
    async markRejected({
      connectorInstanceId,
      rejectedAt,
      reason,
      stateChange = { cause: "provider_rejected" },
    }: {
      connectorInstanceId: string;
      rejectedAt: string;
      reason: string | null;
      stateChange?: CredentialStateChange;
    }) {
      await run.markRejected({
        connectorInstanceId,
        reason: typeof reason === "string" && reason.trim() ? reason.trim().slice(0, 500) : null,
        rejectedAt,
        stateChange,
      });
      return store.getMetadata(connectorInstanceId);
    },

    /**
     * Recover the plaintext secret for orchestrator injection into ONE run.
     * Fails closed (returns no secret, throws a typed error) when the credential
     * is absent or revoked, so a revoked/deleted credential can never authenticate
     * a run. Callers MUST treat the returned plaintext as ephemeral: inject it
     * into the single connection-scoped run env and never log or persist it.
     */
    async recoverSecret({
      connectorInstanceId,
      ownerSubjectId,
    }: {
      connectorInstanceId: string;
      ownerSubjectId: string;
    }) {
      assertRecoveryOwnerSubjectId(ownerSubjectId);
      const row = await read.getRaw(connectorInstanceId);
      if (!row) {
        throw new ConnectorInstanceCredentialError(
          "credential_not_found",
          `No static-secret credential is captured for connection '${connectorInstanceId}'.`
        );
      }
      if (row.owner_subject_id !== ownerSubjectId) {
        throw new ConnectorInstanceCredentialError(
          "credential_owner_mismatch",
          `Credential for '${connectorInstanceId}' does not belong to owner '${ownerSubjectId}'.`
        );
      }
      if (row.status === "rejected") {
        throw new ConnectorInstanceCredentialError(
          "credential_rejected",
          `The static-secret credential for connection '${connectorInstanceId}' was rejected by the provider; ` +
            "the owner must re-capture a valid credential before runs can authenticate."
        );
      }
      if (row.status !== "active") {
        throw new ConnectorInstanceCredentialError(
          "credential_revoked",
          `The static-secret credential for connection '${connectorInstanceId}' is '${row.status}'; ` +
            "the owner must re-capture a valid credential before runs can authenticate."
        );
      }
      if (!row.sealed_secret) {
        throw new ConnectorInstanceCredentialError(
          "credential_secret_unavailable",
          `Stored credential secret for connection '${connectorInstanceId}' is unavailable.`
        );
      }
      const plaintext = cipher().open(row.sealed_secret);
      return { credentialKind: row.credential_kind, secret: plaintext };
    },

    /**
     * Credential revocation (distinct from connection revocation): stop future
     * runs for this connection without deleting the connection, its records, or
     * its schedule. Idempotent; returns the resulting metadata (or null if no
     * credential ever existed).
     */
    async revoke({
      connectorInstanceId,
      now,
      stateChange = { cause: "credential_revoked" },
    }: {
      connectorInstanceId: string;
      now: string;
      stateChange?: CredentialStateChange;
    }) {
      await run.revoke({ connectorInstanceId, revokedAt: now, stateChange });
      return store.getMetadata(connectorInstanceId);
    },
  };
  return store;
}

export function createSqliteConnectorInstanceCredentialStore({
  env = process.env,
}: {
  env?: NodeJS.ProcessEnv;
} = {}): ConnectorInstanceCredentialStore {
  return buildStore({
    cipherFactory: () => createCredentialCipherFromEnv(env),
    read: {
      // Raw row including sealed_secret. INTERNAL ONLY — never returned to a
      // caller; the public surface is getMetadata/recoverSecret.
      getRaw(connectorInstanceId: string): Promise<CredentialRow | null> {
        return Promise.resolve(
          getOne(referenceQueries.connectorInstanceCredentialsGetByInstance, [connectorInstanceId])
        );
      },
      getRawByInstanceIds(connectorInstanceIds: readonly string[]): Promise<CredentialRow[]> {
        const rows: CredentialRow[] = [];
        for (let start = 0; start < connectorInstanceIds.length; start += 900) {
          const chunk = connectorInstanceIds.slice(start, start + 900);
          rows.push(
            ...(getDb()
              .prepare(
                `SELECT connector_instance_id, owner_subject_id, credential_kind, fingerprint,
                        status, captured_at, rotated_at, revoked_at, rejected_at, rejection_reason, state_change_json
                   FROM connector_instance_credentials
                  WHERE connector_instance_id IN (${chunk.map(() => "?").join(", ")})`
              )
              .all(...chunk) as CredentialRow[])
          );
        }
        return Promise.resolve(rows);
      },
    },
    run: {
      delete(connectorInstanceId: string): Promise<void> {
        exec(referenceQueries.connectorInstanceCredentialsDeleteByInstance, [connectorInstanceId]);
        return Promise.resolve();
      },
      markRejected({
        connectorInstanceId,
        rejectedAt,
        reason,
        stateChange,
      }: {
        connectorInstanceId: string;
        rejectedAt: string;
        reason: string | null;
        stateChange: CredentialStateChange;
      }): Promise<void> {
        const query = referenceQueries.connectorInstanceCredentialsMarkRejectedByInstance;
        if (!(query && isMutationQuery(query))) {
          throw new Error("connectorInstanceCredentialsMarkRejectedByInstance query is not registered");
        }
        exec(query, [rejectedAt, reason, serializeCredentialStateChange(stateChange), connectorInstanceId]);
        return Promise.resolve();
      },
      revoke({
        connectorInstanceId,
        revokedAt,
        stateChange,
      }: {
        connectorInstanceId: string;
        revokedAt: string;
        stateChange: CredentialStateChange;
      }): Promise<void> {
        exec(referenceQueries.connectorInstanceCredentialsRevokeByInstance, [
          revokedAt,
          serializeCredentialStateChange(stateChange),
          connectorInstanceId,
        ]);
        return Promise.resolve();
      },
      upsert(record: CredentialWriteRecord): Promise<void> {
        exec(referenceQueries.connectorInstanceCredentialsUpsert, [
          record.connectorInstanceId,
          record.ownerSubjectId,
          record.credentialKind,
          record.sealedSecret,
          record.fingerprint,
          record.status,
          record.capturedAt,
          record.rotatedAt,
          record.revokedAt,
          record.rejectedAt,
          record.rejectionReason,
          serializeCredentialStateChange(record.stateChange),
        ]);
        return Promise.resolve();
      },
    },
  });
}

export function createPostgresConnectorInstanceCredentialStore({
  env = process.env,
}: {
  env?: NodeJS.ProcessEnv;
} = {}): ConnectorInstanceCredentialStore {
  return buildStore({
    cipherFactory: () => createCredentialCipherFromEnv(env),
    read: {
      async getRaw(connectorInstanceId: string): Promise<CredentialRow | null> {
        const result = await postgresQuery<CredentialRow>(
          `SELECT connector_instance_id, owner_subject_id, credential_kind, sealed_secret, fingerprint,
                  status, captured_at, rotated_at, revoked_at, rejected_at, rejection_reason, state_change_json
           FROM connector_instance_credentials
           WHERE connector_instance_id = $1`,
          [connectorInstanceId]
        );
        return result.rows[0] ?? null;
      },
      async getRawByInstanceIds(connectorInstanceIds: readonly string[]): Promise<CredentialRow[]> {
        const result = await postgresQuery<CredentialRow>(
          `SELECT connector_instance_id, owner_subject_id, credential_kind, fingerprint,
                  status, captured_at, rotated_at, revoked_at, rejected_at, rejection_reason, state_change_json
             FROM connector_instance_credentials
            WHERE connector_instance_id = ANY($1::text[])`,
          [connectorInstanceIds]
        );
        return result.rows;
      },
    },
    run: {
      async delete(connectorInstanceId: string): Promise<void> {
        await postgresQuery("DELETE FROM connector_instance_credentials WHERE connector_instance_id = $1", [
          connectorInstanceId,
        ]);
      },
      async markRejected({
        connectorInstanceId,
        rejectedAt,
        reason,
        stateChange,
      }: {
        connectorInstanceId: string;
        rejectedAt: string;
        reason: string | null;
        stateChange: CredentialStateChange;
      }): Promise<void> {
        await postgresQuery(
          `UPDATE connector_instance_credentials
           SET status = 'rejected',
               rejected_at = $1,
               rejection_reason = $2,
               revoked_at = NULL,
               state_change_json = $3::jsonb
           WHERE connector_instance_id = $4
             AND status <> 'revoked'`,
          [rejectedAt, reason, serializeCredentialStateChange(stateChange), connectorInstanceId]
        );
      },
      async revoke({
        connectorInstanceId,
        revokedAt,
        stateChange,
      }: {
        connectorInstanceId: string;
        revokedAt: string;
        stateChange: CredentialStateChange;
      }): Promise<void> {
        await postgresQuery(
          `UPDATE connector_instance_credentials
           SET status = 'revoked', revoked_at = $1, rejected_at = NULL, rejection_reason = NULL,
               state_change_json = $2::jsonb
           WHERE connector_instance_id = $3 AND status <> 'revoked'`,
          [revokedAt, serializeCredentialStateChange(stateChange), connectorInstanceId]
        );
      },
      async upsert(record: CredentialWriteRecord): Promise<void> {
        await postgresQuery(
          `INSERT INTO connector_instance_credentials(
             connector_instance_id, owner_subject_id, credential_kind, sealed_secret, fingerprint,
             status, captured_at, rotated_at, revoked_at, rejected_at, rejection_reason, state_change_json
           )
           VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
           ON CONFLICT(connector_instance_id) DO UPDATE SET
             owner_subject_id = excluded.owner_subject_id,
             credential_kind = excluded.credential_kind,
             sealed_secret = excluded.sealed_secret,
             fingerprint = excluded.fingerprint,
             status = excluded.status,
             rotated_at = excluded.rotated_at,
             revoked_at = excluded.revoked_at,
             rejected_at = excluded.rejected_at,
             rejection_reason = excluded.rejection_reason,
             state_change_json = excluded.state_change_json`,
          [
            record.connectorInstanceId,
            record.ownerSubjectId,
            record.credentialKind,
            record.sealedSecret,
            record.fingerprint,
            record.status,
            record.capturedAt,
            record.rotatedAt,
            record.revokedAt,
            record.rejectedAt,
            record.rejectionReason,
            serializeCredentialStateChange(record.stateChange),
          ]
        );
      },
    },
  });
}
