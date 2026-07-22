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

import { closeDb, initDb } from '../../server/db.js';
import {
  emitSpineEvent,
  listSpineCorrelations,
  listSpineEventsPage,
} from '../../lib/spine.ts';

export function createSqliteDisclosureSpineDriver() {
  return {
    async setup() {
      initDb();
    },

    async teardown() {
      closeDb();
    },

    async append(input) {
      return emitSpineEvent(input);
    },

    async listPage(kind, id, opts = {}) {
      const limit = opts.limit ?? 100;
      const cursor = opts.cursor ?? null;
      const page = listSpineEventsPage(kind, id, { limit, cursor });
      return {
        events: page.events,
        next_cursor: page.next_cursor,
        truncated: page.truncated,
      };
    },

    async listSummaries(kind, filters = {}) {
      const page = await listSpineCorrelations(kind, { limit: 500, ...filters });
      return { summaries: page.summaries };
    },
  };
}
