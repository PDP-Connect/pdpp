"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { Section } from "@pdpp/operator-ui/components/primitives";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import {
  credentialEncryptionRow,
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

const TRAILING_SLASH_RE = /\/+$/;

interface ProtocolMetadataBody {
  authorization_endpoint?: unknown;
  authorization_servers?: unknown;
  grant_types_supported?: unknown;
  issuer?: unknown;
  resource?: unknown;
  token_endpoint?: unknown;
}

// Self-host onboarding SLVP readiness panel. Presents existing diagnostic
// state as a small, opinionated "can I share this MCP URL?" checklist.
//
// Spec: openspec/changes/archive/2026-05-28-add-selfhost-onboarding-slvp/design.md
//
// Rows derive from values already present on `/_ref/deployment` plus the
// browser origin and one-shot reads of both public OAuth metadata documents.
// No new server endpoint.

export function DeploymentReadinessPanel({
  inputs,
  setupInstructions,
  sourceRow,
}: {
  inputs: ServerInputs;
  setupInstructions?: ReactNode;
  sourceRow?: ReadinessRow;
}) {
  const browserOrigin = useBrowserOrigin();
  const refreshTokenProbe = useRefreshTokenAdvertisement();

  const rows: ReadinessRow[] = [
    ownerPasswordRow(inputs),
    referenceOriginRow(inputs, browserOrigin),
    credentialEncryptionRow(inputs),
    storageBackendRow(inputs),
    ...(sourceRow ? [sourceRow] : []),
    embeddingCacheRow(inputs),
    refreshTokenRow(refreshTokenProbe),
  ];

  const verdict = overallVerdict(rows);

  return (
    <>
      <Section
        description="These checks combine the existing deployment report, the running browser origin, public OAuth metadata, and server-owned source projections."
        title="Deployment readiness"
      >
        <div className="mb-3">
          <VerdictBanner hasSourceRow={Boolean(sourceRow)} verdict={verdict} />
        </div>
        <ul className="divide-y divide-border/70 border-border/70 border-y">
          {rows.map((row) => (
            <ReadinessRowItem key={row.check} row={row} />
          ))}
        </ul>
      </Section>
      {setupInstructions ? (
        <Section
          description={
            verdict === "ready"
              ? "The prerequisites above are green. Use the scoped MCP setup below."
              : "Readiness is advisory for advanced users. Open the disclosure to inspect the exact setup instructions even while a prerequisite needs attention."
          }
          title="MCP setup instructions"
        >
          {verdict === "ready" ? (
            setupInstructions
          ) : (
            <details className="rounded-md border border-border/80 bg-muted/20 p-4">
              <summary className="cursor-pointer font-medium text-foreground">Show setup instructions anyway</summary>
              <div className="mt-4">{setupInstructions}</div>
            </details>
          )}
        </Section>
      ) : null}
    </>
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
    fetchProtocolMetadata(window.location.origin).then((nextProbe) => {
      if (!cancelled) {
        setProbe(nextProbe);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return probe;
}

async function fetchProtocolMetadata(origin: string): Promise<RefreshTokenProbe> {
  try {
    const authorizationServer = await fetch("/.well-known/oauth-authorization-server", {
      cache: "no-store",
      credentials: "omit",
    });
    if (!authorizationServer.ok) {
      return { failedEndpoints: ["authorization_server"], state: "unreachable" };
    }
    const authorizationServerBody = (await authorizationServer.json()) as ProtocolMetadataBody;
    const protectedResource = await fetch("/.well-known/oauth-protected-resource/mcp", {
      cache: "no-store",
      credentials: "omit",
    });
    if (!protectedResource.ok) {
      return { failedEndpoints: ["protected_resource"], state: "unreachable" };
    }
    const protectedResourceBody = (await protectedResource.json()) as ProtocolMetadataBody;
    return {
      authorizationServerSupported: hasAuthorizationServerMetadata(authorizationServerBody),
      protectedResourceSupported: hasProtectedResourceMetadata(
        protectedResourceBody,
        origin,
        isNonEmptyString(authorizationServerBody.issuer) ? authorizationServerBody.issuer : null
      ),
      refreshTokenSupported: supportsRefreshToken(authorizationServerBody),
      state: "loaded",
    };
  } catch {
    return { failedEndpoints: ["authorization_server", "protected_resource"], state: "unreachable" };
  }
}

function hasAuthorizationServerMetadata(body: ProtocolMetadataBody): boolean {
  return (
    isNonEmptyString(body.issuer) &&
    isNonEmptyString(body.authorization_endpoint) &&
    isNonEmptyString(body.token_endpoint)
  );
}

function hasProtectedResourceMetadata(body: ProtocolMetadataBody, origin: string, issuer: string | null): boolean {
  const authorizationServers = Array.isArray(body.authorization_servers) ? body.authorization_servers : [];
  return (
    isNonEmptyString(body.resource) &&
    trimTrailingSlash(body.resource) === `${origin}/mcp` &&
    issuer !== null &&
    authorizationServers.some(
      (server) => isNonEmptyString(server) && trimTrailingSlash(server) === trimTrailingSlash(issuer)
    )
  );
}

function supportsRefreshToken(body: ProtocolMetadataBody): boolean {
  return (
    Array.isArray(body.grant_types_supported) && body.grant_types_supported.some((grant) => grant === "refresh_token")
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function VerdictBanner({ hasSourceRow, verdict }: { hasSourceRow: boolean; verdict: Verdict }) {
  const { label, body, toneClass } = verdictPresentation(verdict, hasSourceRow);
  return (
    <div className={`rounded-md border px-3 py-2 text-sm ${toneClass}`}>
      <div className="font-medium">{label}</div>
      <p className="mt-0.5 text-muted-foreground text-xs">{body}</p>
    </div>
  );
}

function trimTrailingSlash(value: string): string {
  return value.replace(TRAILING_SLASH_RE, "");
}

function verdictPresentation(
  verdict: Verdict,
  hasSourceRow: boolean
): { label: string; body: string; toneClass: string } {
  switch (verdict) {
    case "ready":
      return {
        body: hasSourceRow
          ? "Owner auth, origin, encryption, storage, protocol metadata, and usable source evidence all check out."
          : "Owner auth, origin, encryption, storage, embeddings, and protocol metadata all check out.",
        label: "Ready to share with Claude / ChatGPT",
        toneClass: "border-[color:var(--success)]/30 bg-[color:var(--success-wash)] text-[color:var(--success)]",
      };
    case "attention":
      return {
        body: "Some rows are usable but suboptimal. Read the hints below.",
        label: "Attention needed before sharing",
        toneClass: "border-[color:var(--warning)]/30 bg-[color:var(--warning-wash)] text-[color:var(--warning)]",
      };
    case "blocked":
      return {
        body: "At least one row is in an error state. Fix it before handing the MCP URL to an agent.",
        label: "Not yet ready to share",
        toneClass: "border-destructive/30 bg-destructive/5 text-destructive",
      };
    case "unknown":
      return {
        body: "Some prerequisite evidence is still unknown or being checked.",
        label: "Readiness is still being checked",
        toneClass: "border-border/80 bg-muted/40 text-foreground",
      };
    default:
      return {
        body: "Some prerequisite evidence is still unknown or being checked.",
        label: "Readiness is still being checked",
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
  error: "bg-destructive/10 text-destructive",
  info: "bg-muted text-muted-foreground",
  ok: "bg-[color:var(--success-wash)] text-[color:var(--success)]",
  unknown: "bg-muted text-muted-foreground",
  warn: "bg-[color:var(--warning-wash)] text-[color:var(--warning)]",
};

const STATUS_LABEL: Record<ReadinessStatus, string> = {
  error: "blocked",
  info: "n/a",
  ok: "ready",
  unknown: "checking",
  warn: "attention",
};

const STATUS_BADGE_TONE: Record<ReadinessStatus, string> = {
  error: "danger",
  info: "neutral",
  ok: "success",
  unknown: "neutral",
  warn: "warning",
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
