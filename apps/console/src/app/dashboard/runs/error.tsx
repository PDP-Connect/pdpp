"use client";

import { buttonVariants } from "@pdpp/brand-react";
import { useEffect } from "react";

/**
 * Runs-segment error boundary (App Router convention).
 *
 * Scopes a runs-area failure to the runs area instead of the dashboard-wide
 * `Something went wrong`. A run that failed unexpectedly should not also crash
 * the surrounding page to a contextless boundary. Self-contained on purpose
 * (mirrors `dashboard/error.tsx`): no server-only imports.
 */
export default function RunsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-start justify-center gap-4 px-6 py-16">
      <h1 className="pdpp-heading text-foreground">Couldn't load runs</h1>
      <p className="max-w-prose text-muted-foreground">
        The Runs view ran into an error while reading from your reference deployment. This is a read failure, not a
        change to any run. Try again, or check your reference deployment status.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button className={buttonVariants({ variant: "default", size: "sm" })} onClick={() => reset()} type="button">
          Try again
        </button>
        <a className={buttonVariants({ variant: "ghost", size: "sm" })} href="/dashboard/runs">
          Back to runs
        </a>
      </div>
    </main>
  );
}
