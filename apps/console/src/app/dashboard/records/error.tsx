"use client";

import { useEffect } from "react";
import { buttonVariants } from "@/components/ui/button.tsx";

/**
 * Records-segment error boundary (App Router convention).
 *
 * Scopes a records-area failure to the records area instead of letting it fall
 * through to the dashboard-wide `Something went wrong`. The owner reported that
 * a `Sync now` (or a Reddit sync) could crash the page to the generic
 * dashboard boundary; the run-start *action* now returns its failures as a
 * row-local toast, but a subsequent `router.refresh()` re-render can still
 * throw if a data read fails. When it does, this boundary keeps the owner in
 * the Connections context with a retry and a link back to the list, rather
 * than ejecting them to a contextless page.
 *
 * Self-contained on purpose (mirrors `dashboard/error.tsx`): it must not import
 * server-only modules, since the dashboard shell transitively pulls in
 * `lib/owner-token.ts` (`server-only`). See
 * https://nextjs.org/docs/app/getting-started/error-handling.
 */
export default function RecordsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-start justify-center gap-4 px-6 py-16">
      <h1 className="font-semibold text-2xl tracking-tight">Couldn't load your connections</h1>
      <p className="max-w-prose text-muted-foreground">
        The Connections view ran into an error while reading from your reference deployment. Your data and connections
        are unaffected — this is a read failure, not a change. Try again, or check your reference deployment status.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button className={buttonVariants({ variant: "default", size: "sm" })} onClick={() => reset()} type="button">
          Try again
        </button>
        <a className={buttonVariants({ variant: "outline", size: "sm" })} href="/dashboard/records">
          Back to connections
        </a>
      </div>
    </main>
  );
}
