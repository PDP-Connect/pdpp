// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

"use client";

import { buttonVariants } from "@pdpp/brand-react";
import { useEffect } from "react";

/**
 * Dashboard error boundary (App Router convention).
 *
 * Self-contained on purpose: it must not import server-only modules. The
 * dashboard `<DashboardShell>` transitively pulls in `lib/owner-token.ts`,
 * which is `server-only`; importing it here would break the client build.
 * Stripe/Linear-style empty state lives below; the user can retry or sign
 * back in. See https://nextjs.org/docs/app/getting-started/error-handling.
 */
export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-start justify-center gap-3 px-6 py-16">
      <p className="pdpp-eyebrow text-muted-foreground/60 uppercase tracking-widest">PDPP</p>
      <h1 className="pdpp-heading text-foreground">Something went wrong</h1>
      <p className="pdpp-body max-w-prose text-muted-foreground">
        PDPP ran into an unexpected error. Your data is safe — this is a display failure, not a change. Try again or
        sign back in if the problem persists.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button className={buttonVariants({ variant: "default", size: "sm" })} onClick={() => reset()} type="button">
          Try again
        </button>
        <a className={buttonVariants({ variant: "ghost", size: "sm" })} href="/owner/login?return_to=%2F">
          Sign in again
        </a>
      </div>
    </main>
  );
}
