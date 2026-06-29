"use client";

import { buttonVariants } from "@pdpp/brand-react";
import { useEffect, useState } from "react";
import { readLastRecordsReadAt } from "./last-known-read.ts";

/**
 * Records-segment error boundary (App Router convention) — partial-aware.
 *
 * The owner reported hitting "Couldn't load your connections" — every card
 * gone — during a reference rebuild, when a transient read failed mid
 * `router.refresh()` (a poll tick or a post-Sync revalidation;
 * `records-page-poller.tsx` / `connector-row.tsx`). A read blip at the very
 * moment the owner most wants the page (ChatGPT consuming deployment resources
 * mid-run) should never blank all 19 cards.
 *
 * So this boundary is NOT a full-viewport takeover. It renders a compact,
 * top-anchored banner that:
 *   - frames the failure honestly as a *read* failure, not a data change;
 *   - names *when* the data was last confirmed live (last-successful-load
 *     timestamp, read from the client-side `sessionStorage` marker the poller
 *     stamps — see `last-known-read.ts`), without claiming cached rows exist;
 *   - offers an explicit Retry; and
 *   - quietly auto-retries once after a short delay, so a transient blip
 *     self-heals back to the live list without the owner lifting a finger.
 *
 * Self-contained on purpose (mirrors `dashboard/error.tsx`): a `"use client"`
 * boundary must not import server-only modules, since the dashboard shell
 * transitively pulls in `lib/owner-token.ts` (`server-only`). The last-known
 * snapshot therefore comes from a client-cached marker, never a server read
 * inside the boundary. See https://nextjs.org/docs/app/getting-started/error-handling.
 */

// How long to wait before the single automatic recovery attempt. Long enough to
// let a transient reference rebuild / 500 clear, short enough to feel like a
// self-healing page rather than a stuck one.
const AUTO_RETRY_DELAY_MS = 4000;

function formatLastKnown(at: number | null): string | null {
  if (at === null) {
    return null;
  }
  try {
    return new Date(at).toLocaleString();
  } catch {
    return null;
  }
}

export default function RecordsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const [lastKnown, setLastKnown] = useState<string | null>(null);
  const [autoRetried, setAutoRetried] = useState(false);

  useEffect(() => {
    console.error(error);
    // Read the client-cached last-good timestamp on mount (sessionStorage is
    // unavailable during SSR, so this stays in an effect).
    setLastKnown(formatLastKnown(readLastRecordsReadAt()));
  }, [error]);

  useEffect(() => {
    // One automatic recovery attempt: re-run the segment render after a short
    // delay so a transient read failure clears itself. If the read still fails
    // the boundary re-mounts and the owner is left with the manual Retry — we
    // never loop, so a persistent failure does not thrash the deployment.
    if (autoRetried) {
      return;
    }
    const id = setTimeout(() => {
      setAutoRetried(true);
      reset();
    }, AUTO_RETRY_DELAY_MS);
    return () => clearTimeout(id);
  }, [autoRetried, reset]);

  const lastKnownLine = lastKnown ? `Last successful load: ${lastKnown}.` : "The last successful load time is unknown.";

  if (!autoRetried) {
    return (
      <section
        aria-live="polite"
        className="mb-6 rounded-md border border-border bg-card px-4 py-3"
        data-testid="records-read-retry-pending"
        role="status"
      >
        <p className="pdpp-body font-medium text-foreground">Refreshing source status</p>
        <p className="pdpp-caption mt-1 max-w-prose text-muted-foreground">
          The Sources view hit a transient read interruption. Retrying automatically before showing an error.{" "}
          {lastKnownLine}
        </p>
      </section>
    );
  }

  return (
    <section
      aria-live="polite"
      className="mb-6 rounded-md border border-[color:var(--warning)]/30 border-l-4 border-l-[color:var(--warning)] bg-[color:var(--warning)]/5 px-4 py-3"
      data-testid="records-read-failure-banner"
      role="status"
    >
      <p className="pdpp-body font-medium text-foreground">Couldn't refresh your connections</p>
      <p className="pdpp-caption mt-1 max-w-prose text-muted-foreground">
        The Sources view hit an error reading from your reference deployment. Your data and connections are unaffected —
        this is a read failure, not a change. {lastKnownLine}
      </p>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <button
          className={buttonVariants({ variant: "default", size: "sm" })}
          data-testid="records-read-failure-retry"
          onClick={() => {
            setAutoRetried(true);
            reset();
          }}
          type="button"
        >
          Retry now
        </button>
        <a className={buttonVariants({ variant: "ghost", size: "sm" })} href="/dashboard/records">
          Reload Sources
        </a>
      </div>
    </section>
  );
}
