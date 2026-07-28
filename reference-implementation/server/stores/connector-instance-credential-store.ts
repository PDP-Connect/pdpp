// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { exec, getOne, type MutationQuery, type RegisteredQuery, referenceQueries } from "../../lib/db.ts";
import { postgresQuery } from "../postgres-storage.ts";
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
  sealed_secret: string;
  status: string;
}

function isMutationQuery(query: RegisteredQuery): query is MutationQuery {
  return query.terminator === "exec";
}

interface CredentialMetadata {
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
  status: string;
}

interface CaptureCredentialArgs {
  connectorInstanceId: string;
  credentialKind: string;
  now: string;
  ownerSubjectId: string;
  secret: string;
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
  status: "active";
}

interface CredentialStoreRead {
  getRaw: (connectorInstanceId: string) => Promise<CredentialRow | null>;
}

interface CredentialStoreRun {
  delete: (connectorInstanceId: string) => Promise<void>;
  markRejected: (args: { connectorInstanceId: string; rejectedAt: string; reason: string | null }) => Promise<void>;
  revoke: (args: { connectorInstanceId: string; revokedAt: string }) => Promise<void>;
  upsert: (record: CredentialWriteRecord) => Promise<void>;
}

export interface ConnectorInstanceCredentialStore {
  capture: (args: CaptureCredentialArgs) => Promise<CredentialMetadata | null>;
  delete: (connectorInstanceId: string) => Promise<boolean>;
  getMetadata: (connectorInstanceId: string) => Promise<CredentialMetadata | null>;
  hasActiveCredential: (connectorInstanceId: string) => Promise<boolean>;
  markRejected: (args: {
    connectorInstanceId: string;
    rejectedAt: string;
    reason: string | null;
  }) => Promise<CredentialMetadata | null>;
  recoverSecret: (args: {
    connectorInstanceId: string;
    ownerSubjectId?: string | undefined;
  }) => Promise<{ credentialKind: string; secret: string }>;
  revoke: (args: { connectorInstanceId: string; now: string }) => Promise<CredentialMetadata | null>;
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
    async capture({ connectorInstanceId, ownerSubjectId, credentialKind, secret, now }: CaptureCredentialArgs) {
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

    /** Non-secret metadata for one instance, or null when no credential exists. */
    async getMetadata(connectorInstanceId: string) {
      return projectMetadata(await read.getRaw(connectorInstanceId));
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
    }: {
      connectorInstanceId: string;
      rejectedAt: string;
      reason: string | null;
    }) {
      await run.markRejected({
        connectorInstanceId,
        reason: typeof reason === "string" && reason.trim() ? reason.trim().slice(0, 500) : null,
        rejectedAt,
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
      ownerSubjectId?: string | undefined;
    }) {
      const row = await read.getRaw(connectorInstanceId);
      if (!row) {
        throw new ConnectorInstanceCredentialError(
          "credential_not_found",
          `No static-secret credential is captured for connection '${connectorInstanceId}'.`
        );
      }
      if (ownerSubjectId && row.owner_subject_id !== ownerSubjectId) {
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
      const plaintext = cipher().open(row.sealed_secret);
      return { credentialKind: row.credential_kind, secret: plaintext };
    },

    /**
     * Credential revocation (distinct from connection revocation): stop future
     * runs for this connection without deleting the connection, its records, or
     * its schedule. Idempotent; returns the resulting metadata (or null if no
     * credential ever existed).
     */
    async revoke({ connectorInstanceId, now }: { connectorInstanceId: string; now: string }) {
      await run.revoke({ connectorInstanceId, revokedAt: now });
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
      }: {
        connectorInstanceId: string;
        rejectedAt: string;
        reason: string | null;
      }): Promise<void> {
        const query = referenceQueries.connectorInstanceCredentialsMarkRejectedByInstance;
        if (!(query && isMutationQuery(query))) {
          throw new Error("connectorInstanceCredentialsMarkRejectedByInstance query is not registered");
        }
        exec(query, [rejectedAt, reason, connectorInstanceId]);
        return Promise.resolve();
      },
      revoke({ connectorInstanceId, revokedAt }: { connectorInstanceId: string; revokedAt: string }): Promise<void> {
        exec(referenceQueries.connectorInstanceCredentialsRevokeByInstance, [revokedAt, connectorInstanceId]);
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
                  status, captured_at, rotated_at, revoked_at, rejected_at, rejection_reason
           FROM connector_instance_credentials
           WHERE connector_instance_id = $1`,
          [connectorInstanceId]
        );
        return result.rows[0] ?? null;
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
      }: {
        connectorInstanceId: string;
        rejectedAt: string;
        reason: string | null;
      }): Promise<void> {
        await postgresQuery(
          `UPDATE connector_instance_credentials
           SET status = 'rejected',
               rejected_at = $1,
               rejection_reason = $2,
               revoked_at = NULL
           WHERE connector_instance_id = $3
             AND status <> 'revoked'`,
          [rejectedAt, reason, connectorInstanceId]
        );
      },
      async revoke({
        connectorInstanceId,
        revokedAt,
      }: {
        connectorInstanceId: string;
        revokedAt: string;
      }): Promise<void> {
        await postgresQuery(
          `UPDATE connector_instance_credentials
           SET status = 'revoked', revoked_at = $1, rejected_at = NULL, rejection_reason = NULL
           WHERE connector_instance_id = $2 AND status <> 'revoked'`,
          [revokedAt, connectorInstanceId]
        );
      },
      async upsert(record: CredentialWriteRecord): Promise<void> {
        await postgresQuery(
          `INSERT INTO connector_instance_credentials(
             connector_instance_id, owner_subject_id, credential_kind, sealed_secret, fingerprint,
             status, captured_at, rotated_at, revoked_at, rejected_at, rejection_reason
           )
           VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT(connector_instance_id) DO UPDATE SET
             owner_subject_id = excluded.owner_subject_id,
             credential_kind = excluded.credential_kind,
             sealed_secret = excluded.sealed_secret,
             fingerprint = excluded.fingerprint,
             status = excluded.status,
             rotated_at = excluded.rotated_at,
             revoked_at = excluded.revoked_at,
             rejected_at = excluded.rejected_at,
             rejection_reason = excluded.rejection_reason`,
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
          ]
        );
      },
    },
  });
}
