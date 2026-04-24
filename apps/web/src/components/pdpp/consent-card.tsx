"use client";

import Image from "next/image";
import React from "react";
import { Button } from "@/components/ui/button.tsx";

// ─── Consent Card ─────────────────────────────────────────────────────────────

// Props contract — provenance of each field (see spec §5 Client Display, Client Claims, §7 Stream Display):
//
// FROM resolved client display metadata (entity-scoped):
//   requester.name, requester.monogram, requester.uri, requester.policyUri,
//   requester.tosUri, requester.logoSrc
//   Source may be local registration, trust registry, validated software
//   statement metadata, or inline client_display.
//
// FROM client_claims (request-scoped, attributed with disclaimer):
//   commitments[]
//
// FROM purpose_description (request-scoped, first-class field):
//   purpose
//
// FROM manifest display metadata (server-trusted):
//   streams[].label, streams[].detail
//
// FROM server policy / trust registry:
//   requester.verified
//
// Server-derived from grant fields (protocol facts):
//   accessMode, technical.*, retention display text, access mode display text
//
// Server-generated generic copy (v0.1):
//   optional.consequenceOn/Off

export interface ConsentCardStream {
  detail: string; // manifest display.detail — server-trusted
  key: string;
  label: string; // manifest display.label — server-trusted
}

export interface ConsentCardOptional {
  consequenceOff: string; // server-generated generic copy in v0.1
  consequenceOn: string; // server-generated generic copy in v0.1
  detail: string; // manifest display.detail — server-trusted
  key: string;
  label: string; // manifest display.label — server-trusted
}

export interface ConsentCardProps {
  accessMode: "continuous" | "single_use"; // grant.access_mode — protocol fact
  commitments: string[]; // client_claims.commitments — attributed, disclaimed
  onAllow?: () => void;
  onDeny?: () => void;
  optional?: ConsentCardOptional; // at most one optional stream (simplification for now)
  purpose: string; // purpose_description — client-authored, first-class
  requester: {
    name: string; // resolved display name
    monogram: string; // server-derived fallback from resolved name
    uri?: string; // resolved client homepage
    policyUri?: string; // resolved privacy policy URI
    tosUri?: string; // resolved terms-of-service URI
    verified: boolean; // server-determined trust signal, never client-asserted
    logoSrc?: string; // server-selected or approved brand mark, never raw untrusted remote content
  };
  streams: ConsentCardStream[]; // required streams
  technical: {
    clientId: string; // grant.client.client_id
    purposeCode: string; // grant.purpose_code
    grantExpires: string; // grant.expires_at — server-formatted
  };
}

export function ConsentCard({
  requester,
  purpose,
  commitments,
  streams,
  optional,
  accessMode,
  technical,
  onAllow,
  onDeny,
}: ConsentCardProps) {
  const [optionalEnabled, setOptionalEnabled] = React.useState(false);
  const [decided, setDecided] = React.useState<"approved" | "denied" | null>(null);
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
  const [techExpanded, setTechExpanded] = React.useState(false);
  const toggleExpand = (key: string) => setExpanded((v) => ({ ...v, [key]: !v[key] }));

  const accessLabel =
    accessMode === "continuous"
      ? "Ongoing access, active until you revoke it. Your server enforces this."
      : "One-time access. Your server will not allow further queries.";

  if (decided) {
    return (
      <div style={{ maxWidth: "440px" }}>
        <div
          className="flex flex-col items-center gap-3 rounded-xl px-6 py-8 text-center"
          style={{ border: "1px solid var(--border)", backgroundColor: "var(--card)" }}
        >
          <div
            className="flex h-8 w-8 items-center justify-center rounded-full text-sm"
            style={{
              backgroundColor: decided === "approved" ? "var(--success)" : "var(--muted)",
              color: decided === "approved" ? "white" : "var(--muted-foreground)",
            }}
          >
            {decided === "approved" ? "✓" : "×"}
          </div>
          <div className="font-medium text-sm">{decided === "approved" ? "Access granted" : "Access denied"}</div>
          <div className="text-xs" style={{ color: "var(--muted-foreground)" }}>
            {decided === "approved"
              ? `${requester.name} may now query your personal server. You can revoke this any time from your server dashboard.`
              : `No grant was issued. ${requester.name} cannot access your data.`}
          </div>
        </div>
        <button
          className="mt-2 px-0.5 font-mono text-xs"
          style={{ color: "var(--muted-foreground)" }}
          onClick={() => setDecided(null)}
        >
          ↺ reset
        </button>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: "440px" }}>
      <div data-surface="human" className="overflow-hidden rounded-xl">
        {/* ── Identity + purpose ── */}
        <div className="px-5 pt-5 pb-4">
          <div className="flex items-start gap-3">
            <div
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
              style={
                requester.logoSrc
                  ? {
                      backgroundColor: "var(--background)",
                      border: "1px solid var(--border)",
                    }
                  : {
                      backgroundColor: "var(--human)",
                      color: "white",
                    }
              }
            >
              {requester.logoSrc ? (
                <Image
                  src={requester.logoSrc}
                  alt=""
                  aria-hidden="true"
                  width={20}
                  height={20}
                  className="h-5 w-5 object-contain"
                  unoptimized
                />
              ) : (
                <span className="font-bold font-mono text-xs">{requester.monogram}</span>
              )}
            </div>
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-sm" style={{ color: "var(--foreground)" }}>
                  {requester.name}
                </span>
                <span
                  className="rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide"
                  style={{ backgroundColor: "var(--muted)", color: "var(--muted-foreground)" }}
                >
                  client app
                </span>
                {requester.verified ? (
                  <span
                    className="rounded px-1.5 py-0.5 font-mono text-xs uppercase tracking-wide"
                    style={{ backgroundColor: "oklch(0.52 0.15 150 / 0.1)", color: "var(--success)" }}
                  >
                    verified
                  </span>
                ) : (
                  <span
                    className="rounded px-1.5 py-0.5 font-mono text-xs uppercase tracking-wide"
                    style={{ backgroundColor: "oklch(0.62 0.15 70 / 0.1)", color: "var(--warning)" }}
                  >
                    unverified
                  </span>
                )}
              </div>
            </div>
          </div>

          <p className="mt-4 text-sm leading-relaxed" style={{ color: "var(--foreground)" }}>
            {purpose}
          </p>

          {/* AI training warning — spec §5 requires explicit affirmative consent */}
          {technical.purposeCode === "ai_training" && (
            <div
              className="mt-3 rounded-lg px-3 py-2.5 text-xs"
              style={{
                backgroundColor: "oklch(0.55 0.20 27 / 0.08)",
                border: "1px solid oklch(0.55 0.20 27 / 0.2)",
                color: "var(--destructive)",
              }}
            >
              This app wants to use your data for AI model training. This requires your explicit consent.
            </div>
          )}

          {/* Client commitments — scannable list, visually attributed */}
          {commitments.length > 0 && (
            <div className="mt-3 text-xs leading-relaxed" style={{ color: "var(--muted-foreground)" }}>
              <div style={{ color: "var(--foreground)" }} className="mb-1">
                {requester.name} says:
              </div>
              <div
                className="flex flex-col gap-0.5 pl-3"
                style={{ borderLeft: "2px solid oklch(0.52 0.09 45 / 0.35)" }}
              >
                {commitments.map((c) => (
                  <span key={c}>{c}</span>
                ))}
              </div>
              <div className="mt-1.5 italic" style={{ opacity: 0.7 }}>
                These are their commitments, not enforced by your server.
              </div>
            </div>
          )}

          {/* Technical details — pull-to-reveal */}
          <button
            className="mt-3 flex items-center gap-1 text-xs"
            style={{ color: "var(--muted-foreground)" }}
            onClick={() => setTechExpanded((v) => !v)}
          >
            <span
              className="inline-block text-xs"
              style={{
                transform: techExpanded ? "rotate(90deg)" : "rotate(0deg)",
                transition: "transform 150ms",
              }}
            >
              &#x203A;
            </span>
            Technical details
          </button>
          {techExpanded && (
            <div
              className="mt-1.5 flex flex-col gap-0.5 border-l-2 pl-3"
              style={{ borderColor: "oklch(0.580 0.172 253.7 / 0.25)" }}
            >
              <div className="font-mono text-xs" style={{ color: "var(--muted-foreground)" }}>
                <span style={{ opacity: 0.6 }}>Client ID: </span>
                {technical.clientId}
              </div>
              <div className="font-mono text-xs" style={{ color: "var(--muted-foreground)" }}>
                <span style={{ opacity: 0.6 }}>Purpose: </span>
                <span style={{ color: "var(--edu-fg)" }}>{technical.purposeCode}</span>
              </div>
              <div className="font-mono text-xs" style={{ color: "var(--muted-foreground)" }}>
                <span style={{ opacity: 0.6 }}>Grant expires: </span>
                {technical.grantExpires}
              </div>
            </div>
          )}
        </div>

        {/* ── Data being shared ── */}
        <div className="px-5 pb-1" style={{ borderTop: "1px solid var(--border)" }}>
          {streams.map(({ key, label, detail }) => (
            <div key={key} style={{ borderBottom: "1px solid var(--border)" }}>
              <button
                className="flex w-full items-center justify-between gap-2 py-2.5 text-left"
                onClick={() => toggleExpand(key)}
                aria-expanded={!!expanded[key]}
              >
                <span className="font-medium text-xs" style={{ color: "var(--foreground)" }}>
                  {label}
                </span>
                <span
                  className="shrink-0 text-xs"
                  style={{
                    color: "var(--muted-foreground)",
                    display: "inline-block",
                    transform: expanded[key] ? "rotate(90deg)" : "rotate(0deg)",
                    transition: "transform 150ms",
                  }}
                >
                  &#x203A;
                </span>
              </button>
              {expanded[key] && (
                <div className="pb-2.5 pl-3 text-xs" style={{ color: "var(--muted-foreground)" }}>
                  {detail}
                </div>
              )}
            </div>
          ))}

          {/* Optional stream — toggle distinguishes it from required */}
          {optional && (
            <div style={{ borderBottom: "1px solid var(--border)" }}>
              <div className="flex items-center gap-3 py-2.5">
                <button
                  onClick={() => setOptionalEnabled((v) => !v)}
                  className="relative h-4 w-7 shrink-0 rounded-full"
                  style={{
                    backgroundColor: optionalEnabled ? "var(--primary)" : "var(--border)",
                    transition: "background-color var(--motion-state)",
                  }}
                  role="switch"
                  aria-checked={optionalEnabled}
                  aria-label={optional.label}
                >
                  <span
                    className="absolute top-0.5 h-3 w-3 rounded-full"
                    style={{
                      backgroundColor: "white",
                      left: "2px",
                      transform: optionalEnabled ? "translateX(12px)" : "translateX(0)",
                      transition: "transform var(--motion-state)",
                    }}
                  />
                </button>
                <button
                  className="flex min-w-0 flex-1 items-center justify-between gap-2 text-left"
                  onClick={() => toggleExpand(optional.key)}
                  aria-expanded={!!expanded[optional.key]}
                >
                  <span
                    className="font-medium text-xs"
                    style={{ color: "var(--foreground)", opacity: optionalEnabled ? 1 : 0.5 }}
                  >
                    {optional.label}
                    <span className="ml-1.5 font-normal" style={{ color: "var(--muted-foreground)" }}>
                      optional
                    </span>
                  </span>
                  <span
                    className="shrink-0 text-xs"
                    style={{
                      color: "var(--muted-foreground)",
                      display: "inline-block",
                      transform: expanded[optional.key] ? "rotate(90deg)" : "rotate(0deg)",
                      transition: "transform 150ms",
                      opacity: optionalEnabled ? 1 : 0.5,
                    }}
                  >
                    &#x203A;
                  </span>
                </button>
              </div>
              {expanded[optional.key] && (
                <div
                  className="mb-2 pl-10 text-xs"
                  style={{ color: "var(--muted-foreground)", opacity: optionalEnabled ? 1 : 0.4 }}
                >
                  {optional.detail}
                </div>
              )}
              <div className="pb-2.5 pl-10 text-xs" style={{ color: "var(--muted-foreground)" }}>
                {optionalEnabled ? optional.consequenceOn : optional.consequenceOff}
              </div>
            </div>
          )}
        </div>

        {/* ── Access duration ── */}
        <div className="flex items-start gap-2 px-5 py-3">
          <div
            className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: accessMode === "continuous" ? "var(--warning)" : "var(--success)" }}
          />
          <div className="text-xs" style={{ color: "var(--muted-foreground)" }}>
            {accessLabel}
          </div>
        </div>

        {/* ── Actions ── */}
        <div className="px-5 pt-1 pb-5">
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              className="flex-1"
              style={{ borderColor: "var(--primary)", color: "var(--primary)" }}
              onClick={() => {
                setDecided("approved");
                onAllow?.();
              }}
            >
              Allow access
            </Button>
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => {
                setDecided("denied");
                onDeny?.();
              }}
            >
              Deny
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
