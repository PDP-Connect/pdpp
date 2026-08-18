"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { buttonVariants } from "@pdpp/brand-react";
import { useEffect, useState } from "react";
import { createRetryCounter, nextRetryDelayMs } from "./components/read-resilient-retry.ts";
import { ListLoadingSkeleton } from "./components/route-loading.tsx";

/**
 * Dashboard ROOT error boundary (App Router convention) — the catch-all for
 * anything not caught by a more specific segment boundary (`sources/error.tsx`,
 * `syncs/error.tsx`, etc.).
 *
 * DELIBERATELY DIFFERENT from the leaf-segment boundaries: those all now
 * retry unbounded, because their specific throw (`Error: The destination
 * stream closed early`) is a known, provenance-checked transport race — the
 * underlying read already succeeded, only the RSC stream teardown raced. This
 * boundary sits above `page.tsx` (the dashboard overview), which already
 * fault-isolates every one of its OWN data reads via `safeRead()` — an
 * individual source failing degrades that section to empty inline, it never
 * throws up to here. So an error that DOES reach this root boundary is either
 * (a) the same stream-teardown race, now unprovable-by-route because this
 * boundary is shared by the whole segment, or (b) a genuine unhandled fault
 * in render/layout code — precisely the class of bug `safeRead()` was built
 * NOT to swallow. There is no error-reporting integration in this codebase
 * (no Sentry/equivalent) — `console.error` here is the only diagnostic
 * signal an operator has. Retrying an unprovable root-level fault forever,
 * silently, would delete that signal for a real crash.
 *
 * So this boundary retries quietly (same skeleton, no failure copy, capped
 * backoff) for a BOUNDED number of attempts — enough to absorb the ordinary
 * transient race — and only after that repeatedly fails does it fall back to
 * the pre-existing "Something went wrong" / Try again / Sign in again panel.
 * That is strictly no worse than the boundary's prior behavior (which showed
 * that panel immediately, every time) and materially better for the common
 * case: a lone stream hiccup anywhere in the dashboard no longer flashes
 * failure copy at the owner.
 *
 * Self-contained on purpose: it must not import server-only modules. The
 * dashboard shell (`RecordroomShellWithPalette`) transitively pulls in
 * `lib/owner-token.ts`, which is `server-only`; importing it here would break
 * the client build. See https://nextjs.org/docs/app/getting-started/error-handling.
 */

/** Bounded: absorb a handful of quiet retries before conceding this may be a real fault. */
const MAX_QUIET_ATTEMPTS = 5;

/**
 * Consecutive-failure counter, held at MODULE scope rather than component
 * state — see `read-resilient-retry.ts` for why a `useState` counter would
 * silently reset every catch and never actually back off.
 */
const retryCounter = createRetryCounter();

export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const [gaveUp, setGaveUp] = useState(() => retryCounter.attempts >= MAX_QUIET_ATTEMPTS);

  useEffect(() => {
    // Logged for operator diagnostics only — never surfaced to the owner.
    console.error(error);
  }, [error]);

  useEffect(() => {
    if (gaveUp) {
      return;
    }
    // Bounded, capped backoff: retry quietly like the leaf segment boundaries,
    // but stop scheduling further attempts once MAX_QUIET_ATTEMPTS is reached
    // so a genuine, persistent fault surfaces instead of looping forever.
    const delay = nextRetryDelayMs(retryCounter.attempts);
    const id = setTimeout(() => {
      retryCounter.attempts += 1;
      if (retryCounter.attempts >= MAX_QUIET_ATTEMPTS) {
        setGaveUp(true);
        return;
      }
      reset();
    }, delay);
    return () => clearTimeout(id);
  }, [gaveUp, reset]);

  if (!gaveUp) {
    return (
      <div data-testid="dashboard-read-recovering">
        <ListLoadingSkeleton label="PDPP" rows={6} />
      </div>
    );
  }

  return (
    <main className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-start justify-center gap-3 px-6 py-16">
      <p className="pdpp-eyebrow text-muted-foreground/60 uppercase tracking-widest">PDPP</p>
      <h1 className="pdpp-heading text-foreground">Something went wrong</h1>
      <p className="pdpp-body max-w-prose text-muted-foreground">
        PDPP ran into an unexpected error. Your data is safe — this is a display failure, not a change. Try again or
        sign back in if the problem persists.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          className={buttonVariants({ size: "sm", variant: "default" })}
          onClick={() => {
            retryCounter.attempts = 0;
            setGaveUp(false);
            reset();
          }}
          type="button"
        >
          Try again
        </button>
        <a className={buttonVariants({ size: "sm", variant: "ghost" })} href="/owner/login?return_to=%2F">
          Sign in again
        </a>
      </div>
    </main>
  );
}
