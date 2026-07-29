// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SQLite-backed driver for the disclosure-spine conformance harness.
 *
 * Wraps the current reference helpers (`emitSpineEvent`, `listSpineEventsPage`,
 * `listSpineCorrelations`) in the narrow harness shape. This driver is the
 * pinned baseline for the disclosure-spine conformance suite; it is not
 * exported from production code.
 *
 * Spec: openspec/changes/add-disclosure-spine-conformance-harness/specs/
 *       reference-implementation-architecture/spec.md
 */

import type { SpineCorrelationKind, SpineEventRecord } from "../../lib/spine.ts";
import { emitSpineEvent, listSpineCorrelations, listSpineEventsPage } from "../../lib/spine.ts";
import { closeDb, initDb } from "../../server/db.ts";

export function createSqliteDisclosureSpineDriver() {
  return {
    async append(input: Record<string, unknown>): Promise<SpineEventRecord> {
      const event = await emitSpineEvent(input);
      if (!event) {
        throw new Error("SQLite spine append returned no event");
      }
      return event;
    },

    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async listPage(kind: SpineCorrelationKind, id: string, opts: { limit?: number; cursor?: string | null } = {}) {
      const limit = opts.limit ?? 100;
      const cursor = opts.cursor ?? null;
      const page = listSpineEventsPage(kind, id, { cursor, limit });
      return {
        events: page.events,
        next_cursor: page.next_cursor,
        truncated: page.truncated,
      };
    },

    async listSummaries(kind: SpineCorrelationKind, filters: Record<string, unknown> = {}) {
      const page = await listSpineCorrelations(kind, { limit: 500, ...filters });
      return { summaries: page.summaries };
    },
    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async setup() {
      initDb();
    },

    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async teardown() {
      closeDb();
    },
  };
}
