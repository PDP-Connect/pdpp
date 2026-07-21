// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical `ref.connector-schedule.get` operation.
 *
 * Owns the envelope semantics for the reference-only operator-console
 * per-connector schedule view that powers
 * `GET /_ref/connectors/:connectorId/schedule`. Host adapters supply the
 * schedule projection via the dependency contract; the operation owns the
 * success projection and the typed not-found failure shape that the host
 * maps to its existing PDPP 404 `not_found` envelope.
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
 *   concrete read (e.g. `controller.getSchedule(connectorId)` in
 *   `server/index.js`); the operation does not look at controller or
 *   scheduler-store internals.
 */

export interface RefConnectorScheduleGetDependencies {
  /**
   * Resolve the schedule for the requested connector. Returns `null` when
   * no schedule exists; the operation maps that to a typed not-found error
   * the host translates into the existing PDPP 404 envelope.
   */
  getConnectorSchedule(connectorId: string): Promise<unknown> | unknown;
}

export interface RefConnectorScheduleGetInput {
  readonly connectorId: string;
}

export class RefConnectorScheduleGetNotFoundError extends Error {
  readonly code = "not_found" as const;
  readonly connectorId: string;
  constructor(connectorId: string) {
    super(`No schedule for connector: ${connectorId}`);
    this.connectorId = connectorId;
    this.name = "RefConnectorScheduleGetNotFoundError";
  }
}

/**
 * Execute the canonical `ref.connector-schedule.get` operation.
 *
 * Hosts pass capability-shaped dependencies; the operation either returns
 * the schedule projection unchanged or raises
 * `RefConnectorScheduleGetNotFoundError` for the host to translate into
 * the existing PDPP `not_found` 404 envelope. The operation has no notion
 * of HTTP, owner sessions, headers, or framework.
 */
export async function executeRefConnectorScheduleGet(
  input: RefConnectorScheduleGetInput,
  dependencies: RefConnectorScheduleGetDependencies,
): Promise<unknown> {
  const schedule = await dependencies.getConnectorSchedule(input.connectorId);
  if (schedule === null || schedule === undefined) {
    throw new RefConnectorScheduleGetNotFoundError(input.connectorId);
  }
  return schedule;
}
