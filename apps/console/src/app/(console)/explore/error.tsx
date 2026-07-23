"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { buttonVariants } from "@pdpp/brand-react";
import { useEffect } from "react";

/**
 * Scoped Explore error boundary (App Router convention).
 *
 * Without this, an Explore render/data failure bubbled to the dashboard-wide
 * boundary and showed a full-page "Something went wrong". The most common
 * trigger is benign: backgrounding the PWA mid-load aborts the in-flight feed
 * fetch (an AbortError / "Failed to fetch" / "load failed"), so coming back
 * surfaced a scary full-dashboard error for what is just an interrupted load.
 *
 * This boundary keeps the failure inside Explore, recognises the
 * interrupted-load class, and leads with "Reload" (re-runs the server
 * component). Self-contained on purpose — no server-only imports (App Router
 * error boundaries are Client Components).
 */
function isInterruptedLoad(error: Error): boolean {
  const name = error.name ?? "";
  const message = (error.message ?? "").toLowerCase();
  return (
    name === "AbortError" ||
    message.includes("aborted") ||
    message.includes("failed to fetch") ||
    message.includes("load failed") ||
    message.includes("networkerror")
  );
}

export default function ExploreError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  const interrupted = isInterruptedLoad(error);

  return (
    <main className="mx-auto flex min-h-[50vh] max-w-xl flex-col items-start justify-center gap-3 px-6 py-16">
      <p className="pdpp-eyebrow text-muted-foreground/60 uppercase tracking-widest">Explore</p>
      <h1 className="pdpp-heading text-foreground">
        {interrupted ? "This view didn’t finish loading" : "Explore ran into a problem"}
      </h1>
      <p className="pdpp-body max-w-prose text-muted-foreground">
        {interrupted
          ? "The load was interrupted — usually from switching away while records were still loading. Your data is safe and unchanged. Reload to pick up where it left off."
          : "Explore hit an unexpected error while loading your records. Your data is safe — this is a display failure, not a change. Reload to try again."}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button className={buttonVariants({ size: "sm", variant: "default" })} onClick={() => reset()} type="button">
          Reload
        </button>
        <a className={buttonVariants({ size: "sm", variant: "ghost" })} href="/">
          Back to PDPP
        </a>
      </div>
    </main>
  );
}
