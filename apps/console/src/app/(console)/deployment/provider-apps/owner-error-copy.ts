// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Bounded, owner-safe copy for a failed provider-app config save.
 *
 * Never surfaces a raw exception message or a server error body to the
 * owner — this is a small, fixed vocabulary of reasons an owner can act on,
 * not a passthrough for whatever text an upstream failure happens to
 * produce. `actions.ts` is a `"use server"` module that cannot be exercised
 * directly under plain `node:test`, so this classifier is split out as a
 * plain, directly executable function (mirrors `static-secret-refusal.ts`'s
 * split from `ref-client.ts`).
 *
 * Takes a structural discriminant rather than the concrete
 * `ReferenceServerUnreachableError`/`RefRequestError` classes: those live in
 * `owner-token.ts`/`ref-client.ts`, which import `server-only` and pull in
 * `next/headers` transitively, so importing the real classes here would
 * make this module untestable outside a Next.js server runtime.
 */

export type OwnerFacingSaveError =
  | { kind: "unreachable" }
  | { kind: "request_failed"; status: number }
  | { kind: "unknown" };

export function ownerErrorCopy(err: OwnerFacingSaveError): string {
  if (err.kind === "unreachable") {
    return "Could not reach the deployment. Check that it is running and try again.";
  }
  if (err.kind === "request_failed") {
    if (err.status === 401) {
      return "Your session expired. Sign in again and retry.";
    }
    if (err.status === 400) {
      return "One of the values was not accepted. Check the fields and try again.";
    }
    return "The deployment rejected this update. Try again, or check deployment diagnostics.";
  }
  return "This update could not be saved. Try again.";
}
