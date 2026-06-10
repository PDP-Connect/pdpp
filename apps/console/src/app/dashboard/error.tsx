"use client";

import { useEffect } from "react";
import { buttonVariants } from "@/components/ui/button.tsx";

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
    <main className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-start justify-center gap-4 px-6 py-16">
      <h1 className="pdpp-heading text-foreground">Something went wrong</h1>
      <p className="max-w-prose text-muted-foreground">
        The dashboard ran into an unexpected error. Try refreshing this page, or check your reference deployment status.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button className={buttonVariants({ variant: "default", size: "sm" })} onClick={() => reset()} type="button">
          Try again
        </button>
        <a className={buttonVariants({ variant: "outline", size: "sm" })} href="/owner/login?return_to=%2Fdashboard">
          Sign in again
        </a>
      </div>
    </main>
  );
}
