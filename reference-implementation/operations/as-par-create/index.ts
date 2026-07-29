// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical `as.par.create` operation.
 *
 * Owns the RFC 9126-style pushed-authorization-request envelope semantics
 * for `POST /oauth/par`: the call into `consentStore.initiateGrant`, the
 * `trace_context` extraction (for adapter header propagation), and the
 * narrowed public response envelope (`request_uri`, `authorization_url`,
 * `expires_in`).
 *
 * Boundary rules (see openspec/changes/complete-reference-operation-refactor):
 * - This module SHALL NOT import Fastify, Express, Next, SQLite, Postgres,
 *   raw SQL handles, server-internal route/auth modules, sandbox modules, or
 *   `process` / `process.env`.
 */

export interface AsParCreateInput {
  readonly baseUrl: string;
  readonly body: Record<string, unknown> | null | undefined;
  readonly nativeManifest: unknown;
}

export interface AsParCreateTraceContext {
  readonly request_id?: string | null;
  readonly trace_id?: string | null;
}

export interface AsParCreateStoreResult {
  readonly authorization_url: string;
  readonly expires_in: number;
  readonly request_uri: string;
  readonly trace_context?: AsParCreateTraceContext | null;
  readonly [extra: string]: unknown;
}

export interface AsParCreateDependencies {
  initiateGrant: (
    body: Record<string, unknown> | null | undefined,
    opts: { baseUrl: string; nativeManifest: unknown }
  ) => Promise<AsParCreateStoreResult> | AsParCreateStoreResult;
}

export interface AsParCreateOutput {
  readonly envelope: {
    readonly request_uri: string;
    readonly authorization_url: string;
    readonly expires_in: number;
  };
  readonly status: 201;
  readonly traceContext: AsParCreateTraceContext | null;
}

export async function executeAsParCreate(
  input: AsParCreateInput,
  deps: AsParCreateDependencies
): Promise<AsParCreateOutput> {
  const result = await deps.initiateGrant(input.body, {
    baseUrl: input.baseUrl,
    nativeManifest: input.nativeManifest,
  });
  return {
    envelope: {
      authorization_url: result.authorization_url,
      expires_in: result.expires_in,
      request_uri: result.request_uri,
    },
    status: 201,
    traceContext: result.trace_context ?? null,
  };
}
