// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { isPostgresStorageBackend } from './postgres-storage.js';
import {
  createPostgresConnectorInstanceStore,
  createSqliteConnectorInstanceStore,
} from './stores/connector-instance-store.js';
import {
  createPostgresAcquisitionBatchStore,
  createSqliteAcquisitionBatchStore,
} from './stores/acquisition-batch-store.ts';
import {
  createPostgresManualUploadArtifactStore,
  createSqliteManualUploadArtifactStore,
} from './stores/manual-upload-artifact-store.ts';
import {
  createPostgresConnectorInstanceCredentialStore,
  createSqliteConnectorInstanceCredentialStore,
} from './stores/connector-instance-credential-store.js';

export function createRequestConnectorInstanceStore() {
  return isPostgresStorageBackend()
    ? createPostgresConnectorInstanceStore()
    : createSqliteConnectorInstanceStore();
}

export function createRequestConnectorInstanceCredentialStore() {
  return isPostgresStorageBackend()
    ? createPostgresConnectorInstanceCredentialStore()
    : createSqliteConnectorInstanceCredentialStore();
}

export function createRequestAcquisitionBatchStore() {
  return isPostgresStorageBackend()
    ? createPostgresAcquisitionBatchStore()
    : createSqliteAcquisitionBatchStore();
}

export function createRequestManualUploadArtifactStore() {
  return isPostgresStorageBackend()
    ? createPostgresManualUploadArtifactStore()
    : createSqliteManualUploadArtifactStore();
}

export function storageTargetForConnectorNamespace(namespace) {
  return {
    connector_id: namespace.connectorId,
    connector_instance_id: namespace.connectorInstanceId,
  };
}
