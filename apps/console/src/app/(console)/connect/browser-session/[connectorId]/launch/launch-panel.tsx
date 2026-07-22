"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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

const LOST_TRANSPORT_RE = /Failed to fetch|NetworkError|ERR_NETWORK_CHANGED/i;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLostTransportError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return LOST_TRANSPORT_RE.test(message);
}

async function recoverStartedBrowserRun(
  connectorId: string,
  connectionId: string,
  attempts = 1
): Promise<string | null> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      await delay(400);
    }
    try {
      const params = new URLSearchParams({ connection_id: connectionId });
      const response = await fetch(
        `/connect/browser-session/${encodeURIComponent(connectorId)}/launch/recover?${params.toString()}`,
        { credentials: "same-origin" }
      );
      if (response.status === 404) {
        continue;
      }
      const body = (await response.json().catch(() => ({}))) as LaunchResponse;
      if (response.ok && body.href) {
        return body.href;
      }
    } catch {
      // Recovery is best-effort. A later attempt may succeed after Docker
      // networking settles from starting the browser surface.
    }
  }
  return null;
}

async function postStartBrowserRun(connectorId: string, connectionId: string, draft: boolean): Promise<string> {
  const response = await fetch(`/connect/browser-session/${encodeURIComponent(connectorId)}/launch/start`, {
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

async function startBrowserRun(connectorId: string, connectionId: string, draft: boolean): Promise<string> {
  const alreadyStarted = await recoverStartedBrowserRun(connectorId, connectionId);
  if (alreadyStarted) {
    return alreadyStarted;
  }

  try {
    return await postStartBrowserRun(connectorId, connectionId, draft);
  } catch (err) {
    if (isLostTransportError(err)) {
      const recovered = await recoverStartedBrowserRun(connectorId, connectionId, 6);
      if (recovered) {
        return recovered;
      }
    }
    throw err;
  }
}

function launchErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : "The browser session could not start.";
  return isLostTransportError(err)
    ? "PDPP may have started the browser run, but this page could not confirm it after the network changed. Open Syncs, or try again if no new run appears."
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
          {/** biome-ignore lint/performance/noJsxPropsBind: non-memoized, inline binding intentional */}
          <button className={buttonVariants({ size: "sm", variant: "default" })} onClick={start} type="button">
            Try again
          </button>
          <Link className={buttonVariants({ size: "sm", variant: "ghost" })} href="/syncs">
            Open Syncs
          </Link>
          <Link className={buttonVariants({ size: "sm", variant: "ghost" })} href="/sources">
            Back to Sources
          </Link>
        </div>
      ) : null}
    </section>
  );
}
