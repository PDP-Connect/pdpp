"use client";

import { Section } from "@pdpp/operator-ui/components/primitives";
import { useEffect, useState } from "react";
import {
  embeddingCacheRow,
  overallVerdict,
  ownerPasswordRow,
  type ReadinessRow,
  type ReadinessStatus,
  type RefreshTokenProbe,
  referenceOriginRow,
  refreshTokenRow,
  type ServerInputs,
  storageBackendRow,
  type Verdict,
} from "./deployment-readiness-rows.ts";

// Self-host onboarding SLVP readiness panel. Presents existing diagnostic
// state as a small, opinionated "can I share this MCP URL?" checklist.
//
// Spec: openspec/changes/archive/2026-05-28-add-selfhost-onboarding-slvp/design.md
//
// Rows derive from values already present on `/_ref/deployment` plus two
// browser-side reads (`window.location.origin` and a one-shot fetch of
// `/.well-known/oauth-authorization-server`). No new server endpoint.

export function DeploymentReadinessPanel({ inputs }: { inputs: ServerInputs }) {
  const browserOrigin = useBrowserOrigin();
  const refreshTokenProbe = useRefreshTokenAdvertisement();

  const rows: ReadinessRow[] = [
    ownerPasswordRow(inputs),
    referenceOriginRow(inputs, browserOrigin),
    storageBackendRow(inputs),
    embeddingCacheRow(inputs),
    refreshTokenRow(refreshTokenProbe),
  ];

  const verdict = overallVerdict(rows);

  return (
    <Section
      description="Five checks that determine whether the deployment is ready to hand out as an MCP endpoint. Derived from the /_ref/deployment report rendered below."
      title="Deployment readiness"
    >
      <div className="mb-3">
        <VerdictBanner verdict={verdict} />
      </div>
      <ul className="divide-y divide-border/70 border-border/70 border-y">
        {rows.map((row) => (
          <ReadinessRowItem key={row.check} row={row} />
        ))}
      </ul>
    </Section>
  );
}

function useBrowserOrigin(): string | null {
  const [origin, setOrigin] = useState<string | null>(null);
  useEffect(() => {
    if (typeof window !== "undefined") {
      setOrigin(window.location.origin);
    }
  }, []);
  return origin;
}

function useRefreshTokenAdvertisement(): RefreshTokenProbe {
  const [probe, setProbe] = useState<RefreshTokenProbe>({ state: "loading" });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/.well-known/oauth-authorization-server", {
          cache: "no-store",
          credentials: "omit",
        });
        if (!res.ok) {
          if (!cancelled) {
            setProbe({ state: "unreachable" });
          }
          return;
        }
        const body = (await res.json()) as { grant_types_supported?: unknown };
        const grants = Array.isArray(body.grant_types_supported) ? body.grant_types_supported : [];
        const refreshTokenSupported = grants.some((g) => g === "refresh_token");
        if (!cancelled) {
          setProbe({ state: "loaded", refreshTokenSupported });
        }
      } catch {
        if (!cancelled) {
          setProbe({ state: "unreachable" });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return probe;
}

function VerdictBanner({ verdict }: { verdict: Verdict }) {
  const { label, body, toneClass } = verdictPresentation(verdict);
  return (
    <div className={`rounded-md border px-3 py-2 text-sm ${toneClass}`}>
      <div className="font-medium">{label}</div>
      <p className="mt-0.5 text-muted-foreground text-xs">{body}</p>
    </div>
  );
}

function verdictPresentation(verdict: Verdict): { label: string; body: string; toneClass: string } {
  switch (verdict) {
    case "ready":
      return {
        label: "Ready to share with Claude / ChatGPT",
        body: "Owner gate, origin, storage, embeddings, and refresh-token metadata all check out.",
        toneClass: "border-[color:var(--success)]/30 bg-[color:var(--success-wash)] text-[color:var(--success)]",
      };
    case "attention":
      return {
        label: "Attention needed before sharing",
        body: "Some rows are usable but suboptimal. Read the hints below.",
        toneClass: "border-[color:var(--warning)]/30 bg-[color:var(--warning-wash)] text-[color:var(--warning)]",
      };
    case "blocked":
      return {
        label: "Not yet ready to share",
        body: "At least one row is in an error state. Fix it before handing the MCP URL to an agent.",
        toneClass: "border-destructive/30 bg-destructive/5 text-destructive",
      };
    case "unknown":
      return {
        label: "Some checks still running",
        body: "Browser-side probes have not returned yet.",
        toneClass: "border-border/80 bg-muted/40 text-foreground",
      };
    default:
      return {
        label: "Some checks still running",
        body: "Browser-side probes have not returned yet.",
        toneClass: "border-border/80 bg-muted/40 text-foreground",
      };
  }
}

function ReadinessRowItem({ row }: { row: ReadinessRow }) {
  return (
    <li className="flex flex-col gap-1 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="pdpp-title text-foreground">{row.check}</span>
        <StatusChip status={row.status} />
      </div>
      <p className="pdpp-body text-muted-foreground">{row.detail}</p>
      {row.hint ? <p className="pdpp-caption text-muted-foreground/80">Hint: {row.hint}</p> : null}
    </li>
  );
}

const STATUS_TONE: Record<ReadinessStatus, string> = {
  ok: "bg-[color:var(--success-wash)] text-[color:var(--success)]",
  warn: "bg-[color:var(--warning-wash)] text-[color:var(--warning)]",
  error: "bg-destructive/10 text-destructive",
  info: "bg-muted text-muted-foreground",
  unknown: "bg-muted text-muted-foreground",
};

const STATUS_LABEL: Record<ReadinessStatus, string> = {
  ok: "ready",
  warn: "attention",
  error: "blocked",
  info: "n/a",
  unknown: "checking",
};

const STATUS_BADGE_TONE: Record<ReadinessStatus, string> = {
  ok: "success",
  warn: "warning",
  error: "danger",
  info: "neutral",
  unknown: "neutral",
};

function StatusChip({ status }: { status: ReadinessStatus }) {
  return (
    <span
      className={`pdpp-status-badge pdpp-eyebrow inline-flex rounded-[3px] px-1.5 py-0.5 font-medium tabular-nums ${STATUS_TONE[status]}`}
      data-status-tone={STATUS_BADGE_TONE[status]}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}
