"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { buttonVariants } from "@pdpp/brand-react";
import { useEffect } from "react";

/**
 * Shared body for dashboard segment-level error boundaries (App Router
 * `error.tsx` convention).
 *
 * The owner reported that an action failure (`Sync now`, a connector sync) or a
 * post-action `router.refresh()` read failure could crash a whole dashboard
 * page to the generic dashboard-wide `Something went wrong`, ejecting them to a
 * contextless surface whose only escape was "Sign in again". The records
 * segment already scopes its own boundary (`records/error.tsx`); this component
 * lets the other server-read segments (grants, schedules, device-exporters,
 * event-subscriptions, deployment, traces) do the same with a consistent,
 * in-context message and a retry that stays inside the segment.
 *
 * Self-contained on purpose (mirrors `dashboard/error.tsx` and
 * `records/error.tsx`): a `"use client"` boundary must not import server-only
 * modules, and the dashboard shell transitively pulls in `lib/owner-token.ts`
 * (`server-only`). So this renders a plain shell-free panel rather than
 * `DashboardShell`. See https://nextjs.org/docs/app/getting-started/error-handling.
 */
export function SegmentError({
  error,
  reset,
  title,
  description,
  backHref,
  backLabel,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  /** In-context heading, e.g. "Couldn't load your grants". */
  title: string;
  /** One-line reassurance that this is a read failure, not a data change. */
  description: string;
  /** Where "Back" returns to — the segment's own list route. */
  backHref: string;
  /** Label for the back link, e.g. "Back to grants". */
  backLabel: string;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-start justify-center gap-3 px-6 py-16">
      <p className="pdpp-eyebrow text-muted-foreground/60 uppercase tracking-widest">Read error</p>
      <h1 className="pdpp-heading text-foreground">{title}</h1>
      <p className="pdpp-body max-w-prose text-muted-foreground">{description}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {/** biome-ignore lint/performance/noJsxPropsBind: non-memoized, inline binding intentional */}
        <button className={buttonVariants({ size: "sm", variant: "default" })} onClick={() => reset()} type="button">
          Try again
        </button>
        <a className={buttonVariants({ size: "sm", variant: "ghost" })} href={backHref}>
          {backLabel}
        </a>
      </div>
    </main>
  );
}
