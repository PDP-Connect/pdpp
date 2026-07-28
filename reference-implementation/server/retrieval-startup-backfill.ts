// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { getConnectorManifest, listRegisteredConnectorIds } from "./auth.ts";
import { lexicalIndexBackfillForManifest } from "./search.ts";
import { getSemanticBackend, semanticIndexBackfillForManifest } from "./search-semantic.ts";

type LexicalBackfillManifest = NonNullable<Parameters<typeof lexicalIndexBackfillForManifest>[0]>["manifest"];
type SemanticBackfillManifest = NonNullable<Parameters<typeof semanticIndexBackfillForManifest>[0]>["manifest"];
type RetrievalManifest = NonNullable<LexicalBackfillManifest> & NonNullable<SemanticBackfillManifest>;

interface RetrievalLogger {
  info: (context: unknown, message?: string) => void;
  warn: (context: unknown, message: string) => void;
}

interface CollectBackfillManifestsOptions {
  logger: RetrievalLogger;
  nativeManifest: RetrievalManifest | null;
}

interface RunBackfillOptions {
  logger: RetrievalLogger;
  manifests: RetrievalManifest[];
  signal?: AbortSignal | null;
}

function logBackfillProgress(logger: RetrievalLogger, message?: unknown): void {
  logger.info(message);
}

// Moved from index.js. Checkable invariants: this module imports nothing from
// index.js, and startServer keeps the existing startup call sites and order.
export async function collectRetrievalStartupBackfillManifests({
  nativeManifest,
  logger,
}: CollectBackfillManifestsOptions): Promise<RetrievalManifest[]> {
  if (nativeManifest) {
    return [nativeManifest];
  }

  const manifests: RetrievalManifest[] = [];
  const connectorIds = await listRegisteredConnectorIds();
  async function collectAt(index: number): Promise<void> {
    const connectorId = connectorIds[index];
    if (connectorId === undefined) {
      return;
    }
    try {
      const manifest = await getConnectorManifest(connectorId);
      if (manifest) {
        manifests.push(manifest as unknown as RetrievalManifest);
      }
    } catch (err) {
      logger.warn({ connectorId, err }, "skipping retrieval startup backfill for connector with invalid manifest");
    }
    await collectAt(index + 1);
  }
  await collectAt(0);
  return manifests;
}

export async function runRetrievalStartupBackfill({
  manifests,
  logger,
  signal = null,
}: RunBackfillOptions): Promise<void> {
  if (manifests.length === 0) {
    return;
  }

  const startedAt = Date.now();
  logger.info({ connectorCount: manifests.length }, "retrieval startup backfill started");

  async function backfillAt(index: number): Promise<void> {
    const manifest = manifests[index];
    if (manifest === undefined) {
      return;
    }
    if (signal?.aborted) {
      logger.info({ reason: "shutdown" }, "retrieval startup backfill aborted between connectors");
      return;
    }
    const connectorId = manifest.connector_id;
    try {
      logger.info({ connectorId }, "retrieval startup backfill connector started");
      await lexicalIndexBackfillForManifest({
        log: (message?: unknown) => logBackfillProgress(logger, message),
        manifest,
        signal,
      });
      const semanticBackend = getSemanticBackend();
      if (semanticBackend?.available()) {
        await semanticIndexBackfillForManifest({
          log: (message?: unknown) => logBackfillProgress(logger, message),
          manifest,
          signal,
        });
      }
      logger.info({ connectorId }, "retrieval startup backfill connector completed");
    } catch (err) {
      // If the abort is the cause, log at info — this is an expected
      // shutdown path, not an operator-visible failure.
      if (signal?.aborted) {
        logger.info({ connectorId, reason: "shutdown" }, "retrieval startup backfill connector aborted");
        return;
      }
      logger.warn({ connectorId, err }, "retrieval startup backfill failed for connector");
    }
    await backfillAt(index + 1);
  }
  await backfillAt(0);

  logger.info(
    { connectorCount: manifests.length, duration_ms: Date.now() - startedAt },
    "retrieval startup backfill completed"
  );
}

export function scheduleRetrievalStartupBackfill({
  manifests,
  logger,
  signal = null,
}: RunBackfillOptions): Promise<void> {
  if (manifests.length === 0) {
    return Promise.resolve();
  }

  logger.info({ connectorCount: manifests.length }, "retrieval startup backfill scheduled after AS/RS listen");

  return new Promise((resolve) => setImmediate(resolve))
    .then(() => runRetrievalStartupBackfill({ logger, manifests, signal }))
    .catch((err) => {
      // Abort-driven exits travel through this catch when the loop
      // re-throws an AbortError-like value before reaching the inner
      // try/catch (e.g., between connectors). Treat as a clean shutdown.
      if (signal?.aborted) {
        logger.info({ reason: "shutdown" }, "retrieval startup backfill aborted");
        return;
      }
      logger.warn({ err }, "retrieval startup backfill crashed");
    });
}
