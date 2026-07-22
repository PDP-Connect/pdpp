"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
    <main className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-start justify-center gap-3 px-6 py-16">
      <p className="pdpp-eyebrow text-muted-foreground/60 uppercase tracking-widest">Read error</p>
      <h1 className="pdpp-heading text-foreground">Couldn't load syncs</h1>
      <p className="pdpp-body max-w-prose text-muted-foreground">
        The Syncs view ran into an error while reading from your reference deployment. Your syncs are unaffected — this
        is a read failure, not a change. Try again, or check your reference deployment status.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button className={buttonVariants({ size: "sm", variant: "default" })} onClick={() => reset()} type="button">
          Try again
        </button>
        <a className={buttonVariants({ size: "sm", variant: "ghost" })} href="/syncs">
          Back to syncs
        </a>
      </div>
    </main>
  );
}
