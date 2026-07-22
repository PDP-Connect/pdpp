"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { IcButton, IcInput } from "@pdpp/brand-react";
import { Section } from "@pdpp/operator-ui/components/primitives";
import { useState } from "react";
import { deleteConnectionAction, revokeConnectionAction } from "./actions.ts";

interface Props {
  /**
   * The concrete connection selector (`connection_id` / `connector_instance_id`).
   * Null only when this connector type has no addressable connection yet — the
   * danger zone renders disabled guidance in that case rather than destructive
   * forms with no target.
   */
  connectionId: string | null;
  /** Result banner forwarded from the server action redirect. */
  error?: string;
  /** Result banner forwarded from the server action redirect. */
  message?: string;
}

/**
 * Per-connection danger zone: confirmed Revoke and Delete controls. This
 * component renders only on the connection detail page, which resolves a
 * concrete configured connection (catalog-only / unavailable rows `notFound()`
 * before reaching it), so destructive controls never attach to a catalog row.
 *
 * Revoke is a lightweight confirm (checkbox); it stops future collection while
 * retaining records, grants, and audit. Delete requires reproducing the
 * connection id (typed-id confirmation) before the destructive submit enables;
 * it erases exactly this connection's records and may be refused for an active
 * run or a default-account binding. Both confirmations are enforced again on the
 * server — the client gating is a guardrail, not the gate.
 */
export function ConnectionDangerZone({ connectionId, error, message }: Props) {
  return (
    <Section
      description="Revoke stops future collection but keeps this connection's records. Delete erases this connection's records and removes it. These actions affect only this connection, never another."
      id="danger-zone"
      title="Danger zone"
    >
      {error ? (
        <div className="pdpp-caption mb-4 rounded-md border border-destructive/30 border-l-4 border-l-destructive/60 bg-destructive/5 px-4 py-2.5">
          <span className="font-medium text-destructive">{error}</span>
        </div>
      ) : null}
      {message ? (
        <div className="pdpp-caption mb-4 rounded-md border border-emerald-500/30 border-l-4 border-l-emerald-500/60 bg-emerald-500/5 px-4 py-2.5">
          <span className="font-medium text-emerald-700 dark:text-emerald-400">{message}</span>
        </div>
      ) : null}

      {connectionId === null ? (
        <p className="pdpp-caption text-muted-foreground italic">
          This connector type has no addressable connection yet, so there is nothing to revoke or delete.
        </p>
      ) : (
        <div className="flex flex-col gap-6 rounded-md border border-border p-4">
          <RevokeForm connectionId={connectionId} />
          <div className="border-border border-t" />
          <DeleteForm connectionId={connectionId} />
        </div>
      )}
    </Section>
  );
}

function RevokeForm({ connectionId }: { connectionId: string }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="pdpp-body font-medium text-foreground">Revoke</h3>
      <p className="pdpp-caption text-muted-foreground">
        Stops future collection for this connection. Already-collected records, grants, and audit history are retained —
        revoke does not erase anything. Reversible only by an explicit owner re-initiate.
      </p>
      <form action={revokeConnectionAction} className="mt-1 flex flex-wrap items-center gap-3">
        <input name="connection_id" type="hidden" value={connectionId} />
        <label className="pdpp-caption flex items-center gap-2 text-muted-foreground">
          <input name="confirm_revoke" type="checkbox" value="yes" />
          <span>
            Stop future collection for <code className="font-mono">{connectionId}</code>; keep its records.
          </span>
        </label>
        <IcButton type="submit" variant="ghost">
          Revoke connection
        </IcButton>
      </form>
    </div>
  );
}

function DeleteForm({ connectionId }: { connectionId: string }) {
  const [typed, setTyped] = useState("");
  const confirmed = typed === connectionId;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="pdpp-body font-medium text-destructive">Delete</h3>
      <p className="pdpp-caption text-muted-foreground">
        Erases this connection's records and removes it. This is not revoke — it erases the past, not just the future,
        and it cannot be undone. It may be refused if a run is in flight, or for a default-account connection (revoke
        that instead). Sibling connections of the same connector type are untouched.
      </p>
      <form action={deleteConnectionAction} className="mt-1 flex flex-col gap-2">
        <input name="connection_id" type="hidden" value={connectionId} />
        <label className="pdpp-caption flex flex-col gap-1 text-muted-foreground" htmlFor="confirm-delete-input">
          <span>
            Type the connection id <code className="font-mono">{connectionId}</code> to confirm.
          </span>
          <IcInput
            aria-label="Type the connection id to confirm deletion"
            autoComplete="off"
            className="w-full max-w-md font-mono"
            id="confirm-delete-input"
            name="confirm_delete"
            // biome-ignore lint/performance/noJsxPropsBind: non-memoized, inline binding intentional
            onChange={(e) => setTyped(e.target.value)}
            placeholder={connectionId}
            value={typed}
          />
        </label>
        <div>
          <IcButton disabled={!confirmed} type="submit" variant="destructive">
            Delete connection and erase its records
          </IcButton>
        </div>
      </form>
    </div>
  );
}
