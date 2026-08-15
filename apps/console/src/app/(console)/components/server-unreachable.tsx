// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";
import { getRsInternalUrl } from "../lib/owner-token.ts";

// ──────────────────────────────────────────────────────────────────────────
// Selective callouts — the few places where a real boundary deserves a box.
// ──────────────────────────────────────────────────────────────────────────

export function ServerUnreachable() {
  return (
    <div className="rounded-r-md border border-l-4 border-l-destructive/60 bg-destructive/5 px-4 py-3">
      <h2 className="pdpp-title text-destructive">Reference server unreachable</h2>
      <p className="pdpp-body mt-1 text-muted-foreground">
        This dashboard could not reach its PDPP authorization/resource server at{" "}
        <code className="pdpp-caption font-mono text-foreground">{getRsInternalUrl()}</code>. The reference server runs
        alongside this console in your deployment; the dashboard recovers as soon as it responds again.
      </p>
      <ul className="pdpp-caption mt-3 grid gap-1 text-muted-foreground">
        <li>Confirm the PDPP service is running in your deployment (Docker, Railway, Fly, or your VPS).</li>
        <li>Check the deployment logs for a startup error, then restart the PDPP service.</li>
        <li>
          Open{" "}
          <Link className="underline underline-offset-2 hover:text-foreground" href="/deployment">
            Deployment readiness
          </Link>{" "}
          once the server is reachable to confirm configuration.
        </li>
      </ul>
    </div>
  );
}
