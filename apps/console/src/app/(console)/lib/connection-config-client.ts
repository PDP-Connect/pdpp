// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Typed owner-token wrappers for a connection's configuration-revision ledger
 * (`server/routes/owner-connection-config.ts`).
 *
 * Server-only: do not import from a client component. These sit next to the
 * other `/v1/owner/*` reader in `rs-client.ts` (`listOwnerConnectorTemplates`)
 * and follow the same shape — verify the dashboard session, mint an owner
 * bearer, and fail loudly rather than degrade. The config routes are mounted
 * behind `requireToken` + `requireOwner`, so the cookie-session `/_ref` proxy
 * is not an option here; a bearer is the contract.
 *
 * There are exactly THREE call sites in this file that issue a mutation, and
 * both are named for what they do (`proposeConnectionConfig`,
 * `confirmConnectionConfigRevision`). Nothing in the editor's draft or review
 * path imports this module, which is what keeps "preview never writes" a
 * structural property rather than a convention.
 */

import type { ConfigRevisionWire, ConnectionConfigWire } from "../sources/[connector]/connection-config-view-model.ts";
import { describeErrorText } from "./describe-error.ts";
import { getOwnerToken, getRsInternalUrl, ReferenceServerUnreachableError } from "./owner-token.ts";
import { verifyDashboardSession } from "./verify-session.ts";

/**
 * A typed failure from the config routes.
 *
 * `status` and `code` are both preserved because the recovery path depends on
 * them: a 409 `connector_instance_config_stale_write` must offer an explicit
 * rebase and must never be merged silently, while a 409
 * `connector_instance_config_not_proposed` means someone else already resolved
 * the proposal. Collapsing these into one message would make the difference
 * unrecoverable at the UI layer.
 */
export class ConnectionConfigHttpError extends Error {
  readonly body: string;
  readonly code: string | null;
  readonly status: number;

  constructor(message: string, status: number, code: string | null, body: string) {
    super(message);
    this.name = "ConnectionConfigHttpError";
    this.body = body;
    this.code = code;
    this.status = status;
  }
}

function readErrorCode(body: string): string | null {
  try {
    // Typed as `unknown` rather than an optimistic shape: `JSON.parse` happily
    // returns `null` or a scalar, and an error body is exactly the input least
    // likely to match the shape we hoped for.
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const { error } = parsed as { error?: unknown };
    if (typeof error !== "object" || error === null) {
      return null;
    }
    const { code } = error as { code?: unknown };
    return typeof code === "string" && code ? code : null;
  } catch {
    return null;
  }
}

async function configFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  // DAL gate, memoized per render — same contract as every other owner read.
  await verifyDashboardSession();
  const token = await getOwnerToken();
  const url = `${getRsInternalUrl()}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      cache: "no-store",
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...init.headers,
      },
    });
  } catch (err) {
    // ReferenceServerUnreachableError threads `err` through Error's native
    // `cause`; Biome's syntactic check cannot see inside the custom class.
    // biome-ignore lint/style/useErrorCause: see comment above.
    throw new ReferenceServerUnreachableError(`Cannot reach resource server at ${getRsInternalUrl()}`, err);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new ConnectionConfigHttpError(
      describeErrorText(body, `connection config ${path} failed (${res.status})`),
      res.status,
      readErrorCode(body),
      body
    );
  }
  return res.json();
}

function configPath(connectionId: string): string {
  return `/v1/owner/connections/${encodeURIComponent(connectionId)}/config`;
}

/** Active revision + options schema + the base a later propose must echo. */
export async function getConnectionConfig(connectionId: string): Promise<ConnectionConfigWire> {
  return (await configFetch(configPath(connectionId))) as ConnectionConfigWire;
}

/** The full attributed ledger, newest-first once the view-model sorts it. */
export async function listConnectionConfigRevisions(connectionId: string): Promise<ConfigRevisionWire[]> {
  const body = (await configFetch(`${configPath(connectionId)}/revisions`)) as { data?: ConfigRevisionWire[] };
  return Array.isArray(body.data) ? body.data : [];
}

export interface ProposeConfigInput {
  readonly baseEpoch: number;
  readonly baseRevision: number;
  readonly config: Record<string, unknown>;
  readonly connectionId: string;
  readonly sourceOfChange: string;
}

/**
 * Append a revision. MUTATES.
 *
 * A pure-transport bundle self-activates here, which is precisely why this is
 * only ever reached from an explicit owner commit and never from rendering a
 * preview. `base_revision`/`base_epoch` are echoed from the caller's read so a
 * concurrent change is rejected as a 409 rather than merged.
 */
export async function proposeConnectionConfig(input: ProposeConfigInput): Promise<ConfigRevisionWire> {
  return (await configFetch(`${configPath(input.connectionId)}/revisions`, {
    body: JSON.stringify({
      base_epoch: input.baseEpoch,
      base_revision: input.baseRevision,
      config: input.config,
      source_of_change: input.sourceOfChange,
    }),
    method: "POST",
  })) as ConfigRevisionWire;
}

/**
 * Move a proposed revision to active. MUTATES.
 *
 * The owner subject is taken from the authenticated bearer server-side and is
 * never sent in the body — a body-supplied subject would make owner
 * confirmation forgeable, which is the attack the propose/confirm split exists
 * to stop.
 */
export async function confirmConnectionConfigRevision(
  connectionId: string,
  revision: number
): Promise<ConfigRevisionWire> {
  return (await configFetch(`${configPath(connectionId)}/revisions/${revision}/confirm`, {
    body: "{}",
    method: "POST",
  })) as ConfigRevisionWire;
}
