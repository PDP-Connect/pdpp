"use client";

import React from "react";
import { Button } from "@/components/ui/button.tsx";
import { Timestamp } from "@/components/ui/timestamp.tsx";

// Render a timestamp-ish string: if it parses as a real Date, use the
// interactive <Timestamp> component (human-readable + tooltip w/ full
// detail); otherwise render it verbatim. Lets pre-formatted specimen
// strings like 'Apr 15, 2026' pass through untouched while real ISO
// values get the full treatment.
function DateLike({ value }: { value: string | null | undefined }) {
  if (value == null || value === "") {
    return <>Never</>;
  }
  const looksISO = /^\d{4}-\d{2}-\d{2}([T ].+)?$/.test(value);
  const parsed = looksISO ? new Date(value) : null;
  if (parsed && !Number.isNaN(parsed.getTime())) {
    return <Timestamp value={parsed} precision="date" mode="absolute" />;
  }
  return <>{value}</>;
}

// ─── Grant Inspector ─────────────────────────────────────────────────────────

// Props contract — provenance of each field (see spec §6 Grant):
//
// ALL fields are protocol facts — the grant is an immutable consent artifact.
// No client-claimed content appears here; that was resolved at consent time.
//
// FROM grant object (server-authoritative):
//   grantId, issuedAt, status, client.clientId, client.name,
//   purposeCode, purposeDescription, accessMode, expiresAt,
//   retention, streams[]
//
// FROM manifest display metadata (server-trusted):
//   streams[].label, streams[].detail
//
// FROM server policy:
//   status (active/expired/revoked) — tracked by AS, not in grant

export interface GrantStream {
  name: string;
  label: string; // manifest display.label
  detail?: string; // manifest display.detail
  fields?: string[]; // granted field allowlist, absent = all
  view?: string; // informational — which view was selected
  timeRange?: { since?: string; until?: string };
}

export interface GrantInspectorProps {
  grantId: string;
  issuedAt: string; // human-readable date
  status: "active" | "expired" | "revoked";
  client: {
    clientId: string;
    name: string; // from client_display at consent time, or client_id
  };
  purposeCode: string;
  purposeDescription?: string;
  accessMode: "continuous" | "single_use";
  expiresAt?: string | null; // human-readable date, null = no expiry
  retention?: {
    duration: string; // human-readable, e.g. "90 days"
    onExpiry: "delete" | "anonymize";
  };
  streams: GrantStream[];
  onRevoke?: () => void;
}

export function GrantInspector({
  grantId,
  issuedAt,
  status,
  client,
  purposeCode,
  purposeDescription,
  accessMode,
  expiresAt,
  retention,
  streams,
  onRevoke,
}: GrantInspectorProps) {
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
  const toggleExpand = (key: string) => setExpanded((v) => ({ ...v, [key]: !v[key] }));
  const [revoked, setRevoked] = React.useState(status === "revoked");
  const currentStatus = revoked ? "revoked" : status;

  const statusColor = {
    active: "var(--success)",
    expired: "var(--muted-foreground)",
    revoked: "var(--destructive)",
  }[currentStatus];

  const statusLabel = {
    active: accessMode === "continuous" ? "Active, ongoing" : "Active, single use",
    expired: "Expired",
    revoked: "Revoked",
  }[currentStatus];

  const accessModeLabel =
    accessMode === "continuous" ? "Continuous access until revoked" : "Single use, consumed after first query";

  return (
    <div style={{ maxWidth: "440px" }}>
      <div data-surface="protocol" className="overflow-hidden rounded-xl">
        {/* ── Header: grant identity + status ── */}
        <div className="px-5 pt-5 pb-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <div className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: statusColor }} />
              <span className="font-medium text-xs" style={{ color: statusColor }}>
                {statusLabel}
              </span>
            </div>
            <span className="font-mono text-xs" style={{ color: "var(--muted-foreground)" }}>
              {grantId}
            </span>
          </div>

          {/* Client + purpose */}
          <div className="mb-1 font-medium text-sm" style={{ color: "var(--foreground)" }}>
            {client.name}
          </div>
          {purposeDescription && (
            <div className="mb-3 text-xs" style={{ color: "var(--muted-foreground)" }}>
              {purposeDescription}
            </div>
          )}

          {/* Key terms grid */}
          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
            <div>
              <div className="mb-0.5 text-xs" style={{ color: "var(--muted-foreground)", opacity: 0.7 }}>
                Issued
              </div>
              <div className="font-mono text-xs" style={{ color: "var(--muted-foreground)" }}>
                <DateLike value={issuedAt} />
              </div>
            </div>
            <div>
              <div className="mb-0.5 text-xs" style={{ color: "var(--muted-foreground)", opacity: 0.7 }}>
                Expires
              </div>
              <div className="font-mono text-xs" style={{ color: "var(--muted-foreground)" }}>
                <DateLike value={expiresAt ?? null} />
              </div>
            </div>
            <div>
              <div className="mb-0.5 text-xs" style={{ color: "var(--muted-foreground)", opacity: 0.7 }}>
                Access
              </div>
              <div className="text-xs" style={{ color: "var(--muted-foreground)" }}>
                {accessModeLabel}
              </div>
            </div>
            {retention && (
              <div>
                <div className="mb-0.5 text-xs" style={{ color: "var(--muted-foreground)", opacity: 0.7 }}>
                  Retention
                </div>
                <div className="text-xs" style={{ color: "var(--muted-foreground)" }}>
                  {retention.onExpiry === "delete" ? "Deleted" : "Anonymized"} after {retention.duration}
                </div>
              </div>
            )}
          </div>

          {/* Purpose code — technical */}
          <div className="mt-3 font-mono text-xs" style={{ color: "var(--muted-foreground)", opacity: 0.7 }}>
            purpose: <span style={{ color: "var(--edu-fg)", opacity: 1 }}>{purposeCode}</span>
          </div>
        </div>

        {/* ── Granted streams ── */}
        <div className="px-5 pb-1" style={{ borderTop: "1px solid var(--border)" }}>
          {streams.map(({ name, label, detail, fields, view, timeRange }) => (
            <div key={name} style={{ borderBottom: "1px solid var(--border)" }}>
              <button
                className="flex w-full items-center justify-between gap-2 py-2.5 text-left"
                onClick={() => toggleExpand(name)}
                aria-expanded={!!expanded[name]}
              >
                <span className="font-medium text-xs" style={{ color: "var(--foreground)" }}>
                  {label}
                </span>
                <span
                  className="shrink-0 text-xs"
                  style={{
                    color: "var(--muted-foreground)",
                    display: "inline-block",
                    transform: expanded[name] ? "rotate(90deg)" : "rotate(0deg)",
                    transition: "transform 150ms",
                  }}
                >
                  &#x203A;
                </span>
              </button>
              {expanded[name] && (
                <div
                  className="flex flex-col gap-1 border-l-2 pb-2.5 pl-3"
                  style={{ borderColor: "oklch(0.580 0.172 253.7 / 0.25)" }}
                >
                  {detail && (
                    <div className="text-xs" style={{ color: "var(--muted-foreground)" }}>
                      {detail}
                    </div>
                  )}
                  {view && (
                    <div className="font-mono text-xs" style={{ color: "var(--muted-foreground)" }}>
                      <span style={{ opacity: 0.7 }}>View: </span>
                      <span className="rounded px-1 py-px" style={{ backgroundColor: "var(--muted)" }}>
                        {view}
                      </span>
                    </div>
                  )}
                  {fields && (
                    <div className="font-mono text-xs" style={{ color: "var(--muted-foreground)" }}>
                      <span style={{ opacity: 0.7 }}>Fields: </span>
                      {fields.join(", ")}
                    </div>
                  )}
                  {timeRange?.since && (
                    <div className="font-mono text-xs" style={{ color: "var(--muted-foreground)" }}>
                      <span style={{ opacity: 0.7 }}>Since: </span>
                      {timeRange.since}
                    </div>
                  )}
                  {!(fields || view) && (
                    <div className="font-mono text-xs" style={{ color: "var(--muted-foreground)", opacity: 0.7 }}>
                      All fields authorized
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* ── Revoke action ── */}
        {currentStatus === "active" && onRevoke && (
          <div className="px-5 py-4">
            <Button
              variant="outline"
              className="w-full"
              style={{ borderColor: "var(--destructive)", color: "var(--destructive)" }}
              onClick={() => {
                setRevoked(true);
                onRevoke();
              }}
            >
              Revoke access
            </Button>
          </div>
        )}

        {currentStatus !== "active" && (
          <div className="px-5 py-3 text-center text-xs" style={{ color: "var(--muted-foreground)" }}>
            {currentStatus === "revoked"
              ? "Access has been revoked. No further queries will be served."
              : "This grant has expired. No further queries will be served."}
          </div>
        )}
      </div>
      {revoked && status !== "revoked" && (
        <button
          className="mt-2 px-0.5 font-mono text-xs"
          style={{ color: "var(--muted-foreground)" }}
          onClick={() => setRevoked(false)}
        >
          ↺ reset
        </button>
      )}
    </div>
  );
}
