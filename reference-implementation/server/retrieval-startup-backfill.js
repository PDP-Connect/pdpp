// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { getConnectorManifest, listRegisteredConnectorIds } from './auth.js';
import { lexicalIndexBackfillForManifest } from './search.js';
import {
  getSemanticBackend,
  semanticIndexBackfillForManifest,
} from './search-semantic.js';

// Moved from index.js. Checkable invariants: this module imports nothing from
// index.js, and startServer keeps the existing startup call sites and order.
export async function collectRetrievalStartupBackfillManifests({ nativeManifest, logger }) {
  if (nativeManifest) {
    return [nativeManifest];
  }

  const manifests = [];
  const connectorIds = await listRegisteredConnectorIds();
  for (const connectorId of connectorIds) {
    try {
      const manifest = await getConnectorManifest(connectorId);
      if (manifest) {
        manifests.push(manifest);
      }
    } catch (err) {
      logger.warn(
        { err, connectorId },
        'skipping retrieval startup backfill for connector with invalid manifest',
      );
    }
  }
  return manifests;
}

export async function runRetrievalStartupBackfill({ manifests, logger, signal = null }) {
  if (manifests.length === 0) {
    return;
  }

  const startedAt = Date.now();
  logger.info({ connectorCount: manifests.length }, 'retrieval startup backfill started');

  for (const manifest of manifests) {
    if (signal?.aborted) {
      logger.info({ reason: 'shutdown' }, 'retrieval startup backfill aborted between connectors');
      return;
    }
    const connectorId = manifest.connector_id;
    try {
      logger.info({ connectorId }, 'retrieval startup backfill connector started');
      await lexicalIndexBackfillForManifest({
        manifest,
        log: (msg) => logger.info(msg),
        signal,
      });
      const semanticBackend = getSemanticBackend();
      if (semanticBackend?.available()) {
        await semanticIndexBackfillForManifest({
          manifest,
          log: (msg) => logger.info(msg),
          signal,
        });
      }
      logger.info({ connectorId }, 'retrieval startup backfill connector completed');
    } catch (err) {
      // If the abort is the cause, log at info — this is an expected
      // shutdown path, not an operator-visible failure.
      if (signal?.aborted) {
        logger.info(
          { connectorId, reason: 'shutdown' },
          'retrieval startup backfill connector aborted',
        );
        return;
      }
      logger.warn(
        { err, connectorId },
        'retrieval startup backfill failed for connector',
      );
    }
  }

  logger.info(
    { connectorCount: manifests.length, duration_ms: Date.now() - startedAt },
    'retrieval startup backfill completed',
  );
}

export function scheduleRetrievalStartupBackfill({ manifests, logger, signal = null }) {
  if (manifests.length === 0) {
    return Promise.resolve();
  }

  logger.info(
    { connectorCount: manifests.length },
    'retrieval startup backfill scheduled after AS/RS listen',
  );

  return new Promise((resolve) => setImmediate(resolve))
    .then(() => runRetrievalStartupBackfill({ manifests, logger, signal }))
    .catch((err) => {
      // Abort-driven exits travel through this catch when the loop
      // re-throws an AbortError-like value before reaching the inner
      // try/catch (e.g., between connectors). Treat as a clean shutdown.
      if (signal?.aborted) {
        logger.info({ reason: 'shutdown' }, 'retrieval startup backfill aborted');
        return;
      }
      logger.warn({ err }, 'retrieval startup backfill crashed');
    });
}
