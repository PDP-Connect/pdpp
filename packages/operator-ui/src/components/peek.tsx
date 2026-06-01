import Link from "next/link";
import type { ReactNode } from "react";
import { pdppCliNoInstallCommand } from "../lib/cli-command.ts";
import type { SpineEvent, TimelineEnvelope } from "../lib/ref-client.ts";
import { TimelineView } from "./timeline-view.tsx";

export function PeekPane({
  title,
  closeHref,
  openHref,
  cliCommand,
  children,
}: {
  title: string;
  closeHref: string;
  openHref: string;
  cliCommand?: string;
  children: ReactNode;
}) {
  return (
    <aside
      aria-label="peek"
      className="sticky top-16 max-h-[calc(100vh-5rem)] overflow-y-auto overscroll-contain rounded-md border border-border/80 bg-background"
      data-testid="peek-pane"
    >
      <div className="pdpp-caption sticky top-0 flex items-center justify-between gap-2 border-border/80 border-b bg-muted/40 px-3 py-2 backdrop-blur">
        <span className="truncate font-medium">{title}</span>
        <div className="flex items-center gap-3 whitespace-nowrap">
          <Link
            className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            href={openHref}
          >
            open full →
          </Link>
          <Link aria-label="close peek" className="text-muted-foreground hover:text-foreground" href={closeHref}>
            ×
          </Link>
        </div>
      </div>
      <div className="pdpp-caption p-3">
        {children}
        {cliCommand && (
          <div className="mt-3">
            <div className="pdpp-eyebrow mb-1">Reference CLI</div>
            <pre className="pdpp-caption overflow-x-auto rounded bg-muted p-2 font-mono">{cliCommand}</pre>
            {(() => {
              const noInstall = pdppCliNoInstallCommand(cliCommand);
              return noInstall ? (
                <pre
                  className="pdpp-caption mt-1 overflow-x-auto rounded bg-muted/60 p-2 font-mono"
                  data-testid="peek-cli-no-install"
                >
                  {noInstall}
                </pre>
              ) : null;
            })()}
            <p className="pdpp-caption mt-1 text-muted-foreground">
              Top form requires <code className="font-mono">@pdpp/cli</code> installed (or{" "}
              <code className="font-mono">pnpm exec</code> in this monorepo). Bottom form runs without an install via{" "}
              <code className="font-mono">npx</code>. Set <code className="font-mono">PDPP_OWNER_SESSION_COOKIE</code>{" "}
              when owner auth is enabled.
            </p>
          </div>
        )}
      </div>
    </aside>
  );
}

export function PeekEmpty() {
  return (
    <aside
      aria-label="peek hint"
      className="pdpp-caption hidden items-center justify-center rounded-md border border-border/80 border-dashed p-6 text-muted-foreground italic xl:flex"
    >
      Select a row to peek its timeline
    </aside>
  );
}

/**
 * Render a condensed timeline section inside the peek pane.
 */
export function PeekTimeline({ events }: { events: SpineEvent[] }) {
  return <TimelineView events={events} />;
}

/**
 * Derive pivot links from the events inside a timeline envelope.
 */
export function pivotsFromEnvelope(envelope: TimelineEnvelope): Array<{
  kind: "trace" | "grant" | "run";
  id: string;
}> {
  const pivots: Array<{ kind: "trace" | "grant" | "run"; id: string }> = [];
  const seen = new Set<string>();
  for (const ev of envelope.events) {
    for (const [key, kind] of [
      ["trace_id", "trace"] as const,
      ["grant_id", "grant"] as const,
      ["run_id", "run"] as const,
    ]) {
      const id = ev[key];
      if (!id) {
        continue;
      }
      const tag = `${kind}:${id}`;
      if (seen.has(tag)) {
        continue;
      }
      seen.add(tag);
      pivots.push({ kind, id });
    }
  }
  return pivots;
}
