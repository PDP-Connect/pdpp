// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical `ref.schedules.list` operation.
 *
 * Owns the envelope semantics for the reference-only operator-console
 * schedule listing that powers `GET /_ref/schedules`. Host adapters
 * (Fastify route in `reference-implementation/server/index.js`) supply
 * schedule entries via the dependency contract; the operation owns the
 * `{object: 'list', data}` envelope.
 *
 * This is reference/operator surface, not PDPP protocol. Clients must not
 * depend on the response shape.
 *
 * Boundary rules (see openspec/changes/mount-ref-schedules-operations):
 * - This module SHALL NOT import Fastify, Express, Next, SQLite, Postgres,
 *   a raw SQL handle, sandbox modules, the runtime controller, the
 *   scheduler store, `reference-implementation/server/*` route or auth
 *   modules, or `process` / `process.env`.
 * - Schedule reads flow in through dependencies. The host wires the
 *   concrete read (e.g. `controller.listSchedules()` in
 *   `server/index.js`); the operation does not look at controller or
 *   scheduler-store internals.
 */

export interface RefSchedulesListDependencies {
  /**
   * Returns the schedules to surface in the listing. The host is the
   * source of truth for the entry shape (currently the controller's
   * `ScheduleApi` projection); the operation passes entries through
   * unchanged so a future projection-shape change does not require a
   * coordinated operation rev.
   */
  listSchedules(): Promise<readonly unknown[]> | readonly unknown[];
}

export interface RefSchedulesListEnvelope {
  readonly object: "list";
  readonly data: unknown[];
}

/**
 * Execute the canonical `ref.schedules.list` operation.
 *
 * Hosts pass capability-shaped dependencies; the operation assembles the
 * `{object: 'list', data}` envelope. The operation has no notion of HTTP,
 * owner sessions, headers, or framework — it returns the envelope and lets
 * the host write the response.
 */
export async function executeRefSchedulesList(
  dependencies: RefSchedulesListDependencies,
): Promise<RefSchedulesListEnvelope> {
  const schedules = await dependencies.listSchedules();
  return {
    object: "list",
    data: [...schedules],
  };
}
