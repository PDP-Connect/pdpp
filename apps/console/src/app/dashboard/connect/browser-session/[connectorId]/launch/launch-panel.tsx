"use client";

import { buttonVariants } from "@pdpp/brand-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

interface LaunchState {
  error: string | null;
  starting: boolean;
}

interface LaunchResponse {
  href?: string;
  message?: string;
  run_id?: string;
}

async function startBrowserRun(connectorId: string, connectionId: string, draft: boolean): Promise<string> {
  const response = await fetch(`/dashboard/connect/browser-session/${encodeURIComponent(connectorId)}/launch/start`, {
    body: new URLSearchParams({ connection_id: connectionId, draft: draft ? "1" : "0" }),
    credentials: "same-origin",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const body = (await response.json().catch(() => ({}))) as LaunchResponse;
  if (!(response.ok && body.href)) {
    throw new Error(body.message || `Could not start browser session (${response.status})`);
  }
  return body.href;
}

function launchErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : "The browser session could not start.";
  return message === "Failed to fetch"
    ? "The session may still be starting, but the network changed before this page received the run id. Check Runs, or try again if no new run appears."
    : message;
}

export function BrowserSessionLaunchPanel({
  connectionId,
  connectorId,
  draft,
}: {
  connectionId: string;
  connectorId: string;
  draft: boolean;
}) {
  const [state, setState] = useState<LaunchState>({ error: null, starting: true });
  const startedRef = useRef(false);

  function start() {
    setState({ error: null, starting: true });
    startBrowserRun(connectorId, connectionId, draft)
      .then((href) => {
        window.location.assign(href);
      })
      .catch((err) => {
        setState({ error: launchErrorMessage(err), starting: false });
      });
  }

  useEffect(() => {
    if (startedRef.current) {
      return;
    }
    startedRef.current = true;
    setState({ error: null, starting: true });
    startBrowserRun(connectorId, connectionId, draft)
      .then((href) => {
        window.location.assign(href);
      })
      .catch((err) => {
        setState({ error: launchErrorMessage(err), starting: false });
      });
  }, [connectionId, connectorId, draft]);

  return (
    <section className="grid gap-4 rounded-xl border border-border/70 bg-card/60 p-5 shadow-sm">
      <div className="grid gap-2">
        <p className="pdpp-eyebrow text-muted-foreground">secure browser</p>
        <h2 className="pdpp-title text-foreground">
          {state.starting ? "Starting the browser session..." : "Browser session did not finish starting"}
        </h2>
        <p className="pdpp-body text-muted-foreground">
          {state.starting
            ? "Keep this page open. PDPP is preparing the run and will open the secure browser when it is ready."
            : state.error}
        </p>
      </div>

      {state.error ? (
        <div className="flex flex-wrap gap-2">
          <button className={buttonVariants({ variant: "default", size: "sm" })} onClick={start} type="button">
            Try again
          </button>
          <Link className={buttonVariants({ variant: "ghost", size: "sm" })} href="/dashboard/runs">
            Open Runs
          </Link>
          <Link className={buttonVariants({ variant: "ghost", size: "sm" })} href="/dashboard/records">
            Back to Sources
          </Link>
        </div>
      ) : null}
    </section>
  );
}
