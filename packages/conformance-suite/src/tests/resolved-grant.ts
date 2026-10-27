// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// The field allowlist an authorization server RESOLVED for a stream.
//
// Core Section 7 ("Note on `fields`"): schema-required fields are always added
// to the resolved set regardless of the requested list, so a conformant AS may
// legitimately widen a narrow request. An oracle that judges the resource
// server against the REQUEST would report that widening as a leak. Judging
// against `IssuedGrant.streams` is no better on adapters that cannot read the
// grant back, because that field then echoes the request.
//
// So the allowlist is read only from a source that states what the AS froze:
// the grant body the approval returned, or failing that the introspection
// response the resource server itself enforces from. When neither is
// observable the allowlist is unknown, and the caller must `skip`.

import type { IssuedGrant, TargetAdapter } from "../harness/adapter.ts";
import { arrange } from "../harness/runner.ts";
import { introspectByAnyRoute } from "./authorization-server.ts";

interface StreamRow {
  readonly fields?: unknown;
  readonly name?: unknown;
}

function fieldsOf(rows: unknown, streamName: string): readonly string[] | undefined {
  const row = Array.isArray(rows) ? (rows as StreamRow[]).find((r) => r?.name === streamName) : undefined;
  return Array.isArray(row?.fields) && row.fields.every((f) => typeof f === "string")
    ? (row.fields as string[])
    : undefined;
}

/** The resolved field allowlist for `streamName`, or undefined when it is not observable. */
export async function resolvedFieldAllowlist(
  adapter: TargetAdapter,
  grant: IssuedGrant,
  streamName: string
): Promise<readonly string[] | undefined> {
  const raw = grant.rawGrant as { streams?: unknown } | undefined;
  const fromGrant = fieldsOf(raw?.streams, streamName);
  if (fromGrant) {
    return fromGrant;
  }
  const introspected = await arrange("introspection (prerequisite)", () =>
    introspectByAnyRoute(adapter, grant.accessToken)
  );
  const details = (introspected?.json as { authorization_details?: { streams?: unknown }[] } | undefined)
    ?.authorization_details;
  return (details ?? []).map((detail) => fieldsOf(detail.streams, streamName)).find((fields) => fields !== undefined);
}
