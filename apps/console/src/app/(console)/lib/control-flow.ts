// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Re-throw Next.js framework control-flow signals out of a `catch`.
 *
 * In the App Router, `redirect()`, `notFound()`, `forbidden()`,
 * `unauthorized()`, the CSR-bailout and dynamic-rendering interrupts, etc. are
 * implemented by *throwing* a special error (e.g. a `NEXT_REDIRECT`-digest
 * Error). These are control flow, not failures: the framework catches them
 * higher up and performs the navigation / 404 / forbidden render. Any
 * `try/catch` on a server-component render or server-action path that converts
 * a thrown error into a rendered fallback or a returned value will therefore
 * swallow the redirect — and surface its placeholder `"NEXT_REDIRECT"` message
 * as if it were a data-load error.
 *
 * The dashboard read path (`ref-client.ts` → `verifyDashboardSession()`)
 * redirects to `/owner/login` when the owner session must be re-established;
 * that redirect propagates up through every `_ref` read. So every server-side
 * catch on that path MUST call this first, before its own error handling, so
 * the redirect runs instead of rendering "Could not load …" with the
 * `NEXT_REDIRECT` digest leaked into the heading.
 *
 * Thin wrapper over Next's public `unstable_rethrow`, which re-throws every
 * framework control-flow error (and unwraps `.cause` chains) and does nothing
 * for ordinary errors. Named locally so call sites read as intent ("rethrow
 * control flow, then handle the real error") and so the framework dependency is
 * isolated to one module.
 *
 * Server-only: do not import from client components.
 */
import "server-only";

import { unstable_rethrow } from "next/navigation";

/**
 * Re-throw `err` if it is a Next.js control-flow signal (redirect / notFound /
 * forbidden / unauthorized / render interrupt); otherwise return so the caller
 * can handle the real error. Call at the very top of a server-side `catch`.
 */
export function rethrowControlFlow(err: unknown): void {
  unstable_rethrow(err);
}
