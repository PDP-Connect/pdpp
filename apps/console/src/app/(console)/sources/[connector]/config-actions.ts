"use server";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The ONLY mutation entry points for connection configuration.
 *
 * Two actions, both reached from an explicit owner commit: `proposeConfigAction`
 * (the "Apply changes" / "Create proposal" button) and `confirmConfigAction`
 * (the "Confirm and make active" button on a persisted proposal). The draft and
 * review steps have no action at all — they are pure local computation in
 * `connection-config-view-model.ts`, which is what makes an accidental
 * write-on-preview impossible rather than merely unlikely.
 *
 * Both return a discriminated result instead of redirecting, following
 * `renameConnectionAction`: the editor needs to keep the owner's draft on
 * screen when a write is refused, and a redirect would throw it away — exactly
 * the loss F7 §4 forbids on the stale-write path.
 */

import { revalidatePath } from "next/cache";
import {
  ConnectionConfigHttpError,
  confirmConnectionConfigRevision,
  proposeConnectionConfig,
} from "../../lib/connection-config-client.ts";
import { requireDashboardAccess } from "../../lib/dashboard-access.ts";
import type { ConfigRevisionWire } from "./connection-config-view-model.ts";

/**
 * A refused write, typed by what the owner can do about it.
 *
 * `stale` is separated from every other failure because its recovery is
 * different in kind: the draft must survive, the latest configuration must be
 * re-read, and the owner must re-review against it. The store rejects
 * last-write-wins, so silently retrying with a fresh base would apply a change
 * the owner never saw in context.
 */
export type ConfigWriteFailure = "conflict" | "stale" | "unavailable";

export type ProposeConfigResult =
  | { ok: true; revision: ConfigRevisionWire }
  | { ok: false; failure: ConfigWriteFailure; message: string };

export type ConfirmConfigResult =
  | { ok: true; revision: ConfigRevisionWire }
  | { ok: false; failure: ConfigWriteFailure; message: string };

const STALE_CODE = "connector_instance_config_stale_write";

function classify(err: unknown): { failure: ConfigWriteFailure; message: string } {
  if (err instanceof ConnectionConfigHttpError) {
    if (err.status === 409 && err.code === STALE_CODE) {
      return { failure: "stale", message: err.message };
    }
    if (err.status === 409) {
      return { failure: "conflict", message: err.message };
    }
    return { failure: "unavailable", message: err.message };
  }
  return {
    failure: "unavailable",
    message: err instanceof Error ? err.message : "Could not save this configuration change.",
  };
}

function revalidateSource(connectorId: string): void {
  revalidatePath(`/sources/${connectorId}`);
  revalidatePath("/sources");
}

/**
 * Append a revision from the owner's reviewed draft.
 *
 * The caller passes the base it actually read, so a concurrent change is
 * surfaced as `stale` rather than merged. The returned revision's `status`
 * tells the editor what really happened: `active` for a self-activating
 * transport bundle, `proposed` for anything that needs confirmation. The UI
 * renders that persisted answer instead of assuming its own prediction was
 * right.
 */
export async function proposeConfigAction(input: {
  baseEpoch: number;
  baseRevision: number;
  config: Record<string, unknown>;
  connectionId: string;
  connectorId: string;
  sourceOfChange: string;
}): Promise<ProposeConfigResult> {
  await requireDashboardAccess(`/sources/${encodeURIComponent(input.connectorId)}#configuration`);
  const reason = input.sourceOfChange.trim();
  if (!reason) {
    return {
      failure: "unavailable",
      message: "Say why you are changing this, so the record explains itself later.",
      ok: false,
    };
  }
  if (Object.keys(input.config).length === 0) {
    return { failure: "unavailable", message: "Nothing has changed yet.", ok: false };
  }
  try {
    const revision = await proposeConnectionConfig({
      baseEpoch: input.baseEpoch,
      baseRevision: input.baseRevision,
      config: input.config,
      connectionId: input.connectionId,
      sourceOfChange: reason,
    });
    revalidateSource(input.connectorId);
    return { ok: true, revision };
  } catch (err) {
    return { ok: false, ...classify(err) };
  }
}

/**
 * Confirm a persisted proposal, making it active.
 *
 * Takes the revision NUMBER, not a config body: the owner confirms exactly what
 * the server stored. Passing a body here would let the confirmed content drift
 * from the reviewed content.
 */
export async function confirmConfigAction(input: {
  connectionId: string;
  connectorId: string;
  revision: number;
}): Promise<ConfirmConfigResult> {
  await requireDashboardAccess(`/sources/${encodeURIComponent(input.connectorId)}#configuration`);
  try {
    const revision = await confirmConnectionConfigRevision(input.connectionId, input.revision);
    revalidateSource(input.connectorId);
    return { ok: true, revision };
  } catch (err) {
    return { ok: false, ...classify(err) };
  }
}
